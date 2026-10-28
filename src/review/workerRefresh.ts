import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fork, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {DiffRange} from '../git.js';
import type {ReviewModel} from './model.js';

/**
 * How long a refresh may go without reporting progress. The refresh process
 * reports after each step and each file, so a large review that keeps
 * moving is never cut off; a hung git or delta is.
 */
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
  | {id: number; progress: true}
  | ({id: number; ok: true} & WorkerRefreshResult)
  | {id: number; ok: false; error: string; stderr?: string};

export type WorkerRefreshError = Error & {stderr?: string};

const STDERR_TAIL_LIMIT = 8192;
const killsProcessGroup = process.platform !== 'win32';
// Each live refresh process and the temp dir it was given.
const activeChildren = new Map<ChildProcess, string>();
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

function removeTempDir(dir: string) {
  try {
    fs.rmSync(dir, {recursive: true, force: true});
  } catch {
    // Best effort: the OS temp dir is cleaned eventually.
  }
}

// The child runs in its own process group so killing the group also stops
// the git and delta processes it is blocked on. The group is killed even
// after the child itself has exited: a child that died on its own leaves
// its git running in that group.
function killChild(child: ChildProcess) {
  try {
    if (killsProcessGroup && child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  } catch {
    // ESRCH: nothing is left in the group.
  }
}

// A killed child never runs its own cleanup, so the parent removes what it
// left in its temp dir. On exit there is no later event to wait for.
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const [child, tempDir] of [...activeChildren]) {
      killChild(child);
      removeTempDir(tempDir);
    }
    activeChildren.clear();
  });
}

function firstErrorLine(stderr: string) {
  return stderr.split('\n').map((line) => line.trim()).find((line) => /^[A-Za-z]*Error\b/.test(line));
}

// V8 prints this, then aborts, when the heap limit is reached.
function ranOutOfMemory(stderr: string) {
  return /^FATAL ERROR:.*(heap limit|out of memory)/im.test(stderr);
}

function refreshError(message: string, stderr?: string): WorkerRefreshError {
  const error: WorkerRefreshError = new Error(message);
  if (stderr) error.stderr = stderr;
  return error;
}

/**
 * Builds the review in a separate process so a slow or stuck git call never
 * blocks the UI. Rejects when the process reports no progress for
 * `timeoutMs`, on abort, or when the process dies without answering; in each
 * case the process and its children are killed. The process gets its own
 * temp dir, removed once it has exited however it ended.
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-refresh-'));
    let child: ChildProcess;
    try {
      child = fork(modulePath, [], {
        execArgv: workerExecArgv(modulePath),
        // BRANCH_REVIEW_TMPDIR is where the private index copy goes; TMPDIR
        // sends anything else the process tree writes to temp there too.
        env: {...process.env, BRANCH_REVIEW_TMPDIR: tempDir, TMPDIR: tempDir},
        serialization: 'advanced',
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        detached: killsProcessGroup,
      });
    } catch (error) {
      removeTempDir(tempDir);
      throw error;
    }
    activeChildren.set(child, tempDir);
    installExitHook();
    child.once('exit', () => {
      activeChildren.delete(child);
      // Whatever the child left running would keep writing to the temp dir.
      killChild(child);
      removeTempDir(tempDir);
    });

    let settled = false;
    let stderrTail = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    let idleTimer: NodeJS.Timeout | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idleTimer);
      signal?.removeEventListener('abort', handleAbort);
      killChild(child);
      settle();
    };
    const restartIdleTimer = (limitMs: number) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        finish(() => reject(refreshError(
          `refresh timed out: no progress for ${Math.round(limitMs / 1000)}s`,
        )));
      }, limitMs);
    };

    const handleAbort = () => finish(() => reject(refreshError('refresh aborted')));
    // Starting node and loading the worker reports nothing, and on a loaded
    // machine can take longer than a short limit; until the first message the
    // default limit applies.
    restartIdleTimer(Math.max(timeoutMs, REFRESH_TIMEOUT_MS));
    signal?.addEventListener('abort', handleAbort, {once: true});

    child.on('message', (message: WorkerRefreshMessage) => {
      if (message.id !== id || settled) return;

      if ('progress' in message) {
        restartIdleTimer(timeoutMs);
        return;
      }

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
      if (ranOutOfMemory(stderrTail)) {
        finish(() => reject(refreshError(`refresh ran out of memory (worker exited with ${reason})`, stderrTail)));
        return;
      }

      const detail = firstErrorLine(stderrTail);
      finish(() => reject(refreshError(
        `refresh worker exited with ${reason}${detail ? `: ${detail}` : ''}`,
        stderrTail || undefined,
      )));
    });

    child.send({id, ...options});
  });
}
