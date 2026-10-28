import fs from 'node:fs';
import {fork, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {DiffRange} from '../git.js';
import type {ReviewModel} from './model.js';

export const REFRESH_TIMEOUT_MS = 30_000;

type WorkerRefreshOptions = {
  cwd: string;
  requestedBranch: string;
  requestedBase: string;
  width: number;
  previousFingerprint?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type WorkerRefreshResult = {
  range: DiffRange;
  fingerprint: string;
  branchName: string | null;
  review?: ReviewModel;
};

type WorkerRefreshMessage =
  | ({id: number; ok: true} & WorkerRefreshResult)
  | {id: number; ok: false; error: string; stderr?: string};

export type WorkerRefreshError = Error & {stderr?: string};

const STDERR_TAIL_LIMIT = 8192;
const killsProcessGroup = process.platform !== 'win32';
const activeChildren = new Set<ChildProcess>();
let requestId = 0;
let exitHookInstalled = false;

// The bundle puts cli.js and refreshWorker.js side by side in dist/; running
// from source (tsx, vitest) the worker is src/refreshWorker.ts.
function resolveWorkerModule() {
  const candidates = [
    new URL('./refreshWorker.js', import.meta.url),
    new URL('../refreshWorker.ts', import.meta.url),
  ];
  const found = candidates.find((url) => fs.existsSync(fileURLToPath(url)));
  if (!found) {
    throw new Error('refresh worker module not found next to the CLI');
  }

  return fileURLToPath(found);
}

function workerExecArgv(modulePath: string) {
  const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
  if (modulePath.endsWith('.ts') && !execArgv.some((arg) => arg.includes('tsx'))) {
    execArgv.push('--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href);
  }

  return execArgv;
}

// The child runs in its own process group so killing the group also stops
// the git and delta processes it is blocked on.
function killChild(child: ChildProcess) {
  activeChildren.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) return;

  try {
    if (killsProcessGroup && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of [...activeChildren]) killChild(child);
  });
}

function firstErrorLine(stderr: string) {
  return stderr.split('\n').map((line) => line.trim()).find((line) => /^[A-Za-z]*Error\b/.test(line));
}

function refreshError(message: string, stderr?: string): WorkerRefreshError {
  const error: WorkerRefreshError = new Error(message);
  if (stderr) error.stderr = stderr;
  return error;
}

/**
 * Builds the review in a separate process so a slow or stuck git call never
 * blocks the UI. Rejects on timeout, on abort, or when the process dies
 * without answering; in each case the process and its children are killed.
 */
export function refreshReviewInWorker({
  timeoutMs = REFRESH_TIMEOUT_MS,
  signal,
  ...options
}: WorkerRefreshOptions): Promise<WorkerRefreshResult> {
  const id = requestId += 1;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(refreshError('refresh aborted'));
      return;
    }

    const modulePath = resolveWorkerModule();
    const child = fork(modulePath, [], {
      execArgv: workerExecArgv(modulePath),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: killsProcessGroup,
    });
    activeChildren.add(child);
    installExitHook();

    let settled = false;
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', handleAbort);
      killChild(child);
      settle();
    };

    const handleAbort = () => finish(() => reject(refreshError('refresh aborted')));
    const timeout = setTimeout(() => {
      finish(() => reject(refreshError(`refresh timed out after ${Math.round(timeoutMs / 1000)}s`)));
    }, timeoutMs);
    signal?.addEventListener('abort', handleAbort, {once: true});

    child.on('message', (message: WorkerRefreshMessage) => {
      if (message.id !== id) return;

      if (message.ok) {
        finish(() => resolve({
          range: message.range,
          fingerprint: message.fingerprint,
          branchName: message.branchName,
          review: message.review,
        }));
        return;
      }

      finish(() => reject(refreshError(message.error, message.stderr)));
    });

    child.on('error', (error) => finish(() => reject(error)));

    // 'close' fires after the IPC channel and stderr have drained, so a
    // result sent just before exiting is never mistaken for a crash.
    child.on('close', (code, exitSignal) => {
      const reason = exitSignal ? `signal ${exitSignal}` : `code ${code}`;
      const detail = firstErrorLine(stderrTail);
      finish(() => reject(refreshError(
        `refresh worker exited with ${reason}${detail ? `: ${detail}` : ''}`,
        stderrTail || undefined,
      )));
    });

    child.send({id, ...options});
  });
}
