import fs from 'node:fs';
import path from 'node:path';
import {fork, type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import type {Socket} from 'node:net';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {
  ExportRequest,
  ExportResult,
  InspectRequest,
  InspectResult,
  MediaBackend,
  RenderRequest,
  RenderResult,
  VideoRequest,
  VideoResult,
  WorkerRequest,
} from './backend.js';

// The UI side of the media worker. One long-lived child process does every
// read and decode, two jobs at a time, nearest-the-viewport first. Every job
// has a deadline; a worker that misses one, or dies, is killed with its whole
// process group and started again after a backoff. Three such failures in a
// minute turn previews off for the session, so a file that hangs or crashes
// the decoder can never make the app spin.

type JobType = WorkerRequest['type'];
type JobResult = InspectResult | RenderResult | VideoResult | ExportResult;

const DEFAULT_DEADLINES_MS: Record<JobType, number> = {
  // Covers a partial clone fetching a blob it never had.
  inspect: 10_000,
  render: 8_000,
  // A probe and up to four frames, each with its own shorter deadline.
  video: 30_000,
  exportCopy: 30_000,
};
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000];
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 3;
const IDLE_EXIT_MS = 60_000;
const MAX_IN_FLIGHT = 2;
const STDERR_TAIL_LIMIT = 4096;

const killsProcessGroup = process.platform !== 'win32';

export type WorkerBackendOptions = {
  // The session's media temp dir, made on first use; the worker's own temp
  // files go in its `worker` dir.
  tempDir: () => string;
  env?: NodeJS.ProcessEnv;
  // Where the worker runs: the repo root.
  cwd?: string;
  modulePath?: string;
  deadlinesMs?: Partial<Record<JobType, number>>;
  backoffMs?: readonly number[];
  idleMs?: number;
  // Called once, when failures turn previews off.
  onDisabled?: (reason: string) => void;
  // Called right after each fork with the new worker's pid.
  onSpawn?: (pid: number) => void;
};

export type WorkerBackend = MediaBackend & {disabledReason(): string | null};

type Job = {
  id: number;
  type: JobType;
  request: InspectRequest | RenderRequest | VideoRequest | ExportRequest;
  priority: number;
  signal: AbortSignal;
  resolve: (result: JobResult) => void;
  reject: (error: Error) => void;
  requeued: boolean;
  settled: boolean;
  timer?: NodeJS.Timeout;
  // The worker this job was last sent to, so a deadline that outlives it
  // never touches a later worker.
  child?: ChildProcess;
  onAbort?: () => void;
};

// The bundle puts cli.js and mediaWorker.js side by side in dist/; running
// from source (tsx, vitest) the worker is src/mediaWorker.ts.
function resolveWorkerModule() {
  const candidates = [
    new URL('./mediaWorker.js', import.meta.url),
    new URL('../mediaWorker.ts', import.meta.url),
  ];
  const found = candidates.find((url) => fs.existsSync(fileURLToPath(url)));
  if (!found) throw new Error('media worker module not found next to the CLI');
  return fileURLToPath(found);
}

function workerExecArgv(modulePath: string) {
  const execArgv = process.execArgv.filter((arg) => !arg.startsWith('--input-type'));
  if (modulePath.endsWith('.ts') && !execArgv.some((arg) => arg.includes('tsx'))) {
    execArgv.push('--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href);
  }
  return execArgv;
}

// The recorded pid's group: the worker and the git it started. Killed even
// after the worker itself exited, since its children may still run.
function killGroup(child: ChildProcess) {
  try {
    if (killsProcessGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
    else if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } catch {
    // ESRCH: nothing is left in the group.
  }
}

function abortError() {
  return new Error('aborted');
}

export function createWorkerBackend({
  tempDir,
  env = process.env,
  cwd,
  modulePath,
  deadlinesMs = {},
  backoffMs = DEFAULT_BACKOFF_MS,
  idleMs = IDLE_EXIT_MS,
  onDisabled,
  onSpawn,
}: WorkerBackendOptions): WorkerBackend {
  const deadlines = {...DEFAULT_DEADLINES_MS, ...deadlinesMs};
  const queue: Job[] = [];
  const inFlight = new Map<number, Job>();
  let child: ChildProcess | null = null;
  // Exits this side asked for (deadline, idle, dispose) are not crashes.
  const expectedExits = new WeakSet<ChildProcess>();
  let nextId = 0;
  let failures: number[] = [];
  // Failures since the last answer, for the backoff step.
  let consecutiveFailures = 0;
  let nextForkAt = 0;
  let forkTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  let disabled: string | null = null;
  let disposed = false;

  const settle = (job: Job, result: JobResult) => {
    // An aborted job is settled with its timer still armed; clearing it here
    // first means no path that finishes a job leaves its deadline running.
    clearTimeout(job.timer);
    if (job.settled) return;
    job.settled = true;
    if (job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    job.resolve(result);
  };

  const failQueued = (reason: string) => {
    for (const job of queue.splice(0)) settle(job, {ok: false, state: 'unavailable', reason});
  };

  const stopChild = () => {
    const current = child;
    if (!current) return;
    child = null;
    expectedExits.add(current);
    killGroup(current);
  };

  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (inFlight.size > 0 || queue.length > 0 || !child) return;
    idleTimer = setTimeout(stopChild, idleMs);
    idleTimer.unref();
  };

  const recordFailure = (reason: string) => {
    const now = Date.now();
    failures = [...failures.filter((at) => now - at < FAILURE_WINDOW_MS), now];
    consecutiveFailures += 1;
    if (failures.length >= MAX_FAILURES && !disabled) {
      disabled = `previews turned off: ${reason}`;
      failQueued(disabled);
      onDisabled?.(reason);
      return;
    }
    nextForkAt = now + backoffMs[Math.min(consecutiveFailures - 1, backoffMs.length - 1)]!;
  };

  // Jobs that were in flight with one that failed get one more try in the
  // next worker; after that they fail with `reason`.
  const requeueOthers = (reason: string) => {
    for (const job of [...inFlight.values()]) {
      inFlight.delete(job.id);
      clearTimeout(job.timer);
      if (job.settled) continue;
      if (job.requeued) settle(job, {ok: false, state: 'error', reason});
      else {
        job.requeued = true;
        queue.push(job);
      }
    }
  };

  const onExit = (exited: ChildProcess, code: number | null, signal: NodeJS.Signals | null, stderrTail: string) => {
    killGroup(exited);
    if (child === exited) child = null;
    if (expectedExits.has(exited) || disposed) return;
    const detail = stderrTail.split('\n').map((line) => line.trim()).find((line) => /^[A-Za-z]*Error\b/.test(line));
    const reason = `media worker exited (${signal ? `signal ${signal}` : `code ${code}`})${detail ? `: ${detail}` : ''}`;
    for (const job of [...inFlight.values()]) {
      inFlight.delete(job.id);
      clearTimeout(job.timer);
      settle(job, {ok: false, state: 'error', reason});
    }
    recordFailure(reason);
    pump();
  };

  const spawnChild = () => {
    const dir = tempDir();
    const workerTemp = path.join(dir, 'worker');
    fs.mkdirSync(workerTemp, {recursive: true, mode: 0o700});
    const resolved = modulePath ?? resolveWorkerModule();
    const spawned = fork(resolved, [], {
      execArgv: workerExecArgv(resolved),
      // TMPDIR sends anything the worker's process tree writes to temp into
      // the session's dir, which is removed at exit.
      env: {...env, TMPDIR: workerTemp, BRANCH_REVIEW_MEDIA_TMP: dir},
      ...(cwd ? {cwd} : {}),
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      detached: killsProcessGroup,
    });
    let stderrTail = '';
    spawned.stderr?.setEncoding('utf8');
    spawned.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    spawned.on('message', (message: {id?: number} & JobResult) => {
      if (typeof message?.id !== 'number') return;
      const job = inFlight.get(message.id);
      if (!job) return;
      inFlight.delete(message.id);
      clearTimeout(job.timer);
      consecutiveFailures = 0;
      const {id: _id, ...result} = message;
      settle(job, result as JobResult);
      pump();
    });
    spawned.on('error', () => undefined);
    // 'close' fires after IPC and stderr drained, so an answer sent just
    // before exiting is never mistaken for a crash.
    spawned.on('close', (code, signal) => onExit(spawned, code, signal, stderrTail));
    // The worker never keeps the UI process alive on its own: not the child
    // handle, not the IPC channel, and not the stderr pipe, whose open
    // socket would hold the process up until the idle stop.
    spawned.unref();
    (spawned as unknown as {channel?: {unref(): void}}).channel?.unref();
    (spawned.stderr as Socket | null)?.unref();
    if (spawned.pid) onSpawn?.(spawned.pid);
    return spawned;
  };

  // A job dropped by the UI still counts: the worker missed its deadline.
  const onDeadline = (job: Job) => {
    // A deadline whose job is no longer in flight in the current worker is
    // stale: it must not kill a later worker or count as a failure.
    if (!inFlight.has(job.id) || job.child !== child) return;
    inFlight.delete(job.id);
    settle(job, {ok: false, state: 'error', reason: 'timed out'});
    stopChild();
    requeueOthers('timed out');
    recordFailure('timed out');
    pump();
  };

  function pump() {
    if (disposed) return;
    if (disabled) {
      failQueued(disabled);
      return;
    }
    clearTimeout(idleTimer);
    while (inFlight.size < MAX_IN_FLIGHT && queue.length > 0) {
      if (!child) {
        const wait = nextForkAt - Date.now();
        if (wait > 0) {
          clearTimeout(forkTimer);
          forkTimer = setTimeout(pump, wait);
          forkTimer.unref();
          return;
        }
        try {
          child = spawnChild();
        } catch (error) {
          const reason = `media worker failed to start (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
          for (const job of queue.splice(0)) settle(job, {ok: false, state: 'error', reason});
          recordFailure(reason);
          return;
        }
      }

      queue.sort((left, right) => left.priority - right.priority || left.id - right.id);
      // One video job at a time: the worker runs one ffmpeg at a time, and a
      // second video job sent now would wait there with its deadline running.
      const videoBusy = [...inFlight.values()].some((each) => each.type === 'video');
      const next = queue.findIndex((each) => !(videoBusy && each.type === 'video'));
      if (next < 0) break;
      const [job] = queue.splice(next, 1) as [Job];
      if (job.settled) continue;
      inFlight.set(job.id, job);
      job.child = child;
      job.timer = setTimeout(() => onDeadline(job), deadlines[job.type]);
      job.timer.unref();
      try {
        child.send({id: job.id, type: job.type, ...job.request});
      } catch {
        // The worker is going away; its close event fails or re-queues this.
      }
    }
    scheduleIdle();
  }

  function submit<T extends JobResult>(type: JobType, request: Job['request'], signal: AbortSignal, priority = 1): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      if (disposed || disabled) {
        resolve({ok: false, state: 'unavailable', reason: disabled ?? 'previews turned off'} as T);
        return;
      }
      nextId += 1;
      const job: Job = {
        id: nextId,
        type,
        request,
        priority,
        signal,
        resolve: resolve as (result: JobResult) => void,
        reject,
        requeued: false,
        settled: false,
      };
      // A job dropped by the UI: queued, it never runs; in flight, its answer
      // is ignored, and the worker is left to finish it within its deadline.
      job.onAbort = () => {
        if (job.settled) return;
        job.settled = true;
        const queued = queue.indexOf(job);
        if (queued >= 0) queue.splice(queued, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', job.onAbort, {once: true});
      queue.push(job);
      pump();
    });
  }

  return {
    inspect: (request, signal, priority) => submit<InspectResult>('inspect', request, signal, priority),
    render: (request, signal, priority) => submit<RenderResult>('render', request, signal, priority),
    video: (request, signal, priority) => submit<VideoResult>('video', request, signal, priority),
    exportCopy: (request, signal) => submit<ExportResult>('exportCopy', request, signal, -1),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(forkTimer);
      clearTimeout(idleTimer);
      stopChild();
      for (const job of [...queue.splice(0), ...inFlight.values()]) {
        clearTimeout(job.timer);
        settle(job, {ok: false, state: 'unavailable', reason: 'previews turned off'});
      }
      inFlight.clear();
    },
    disabledReason: () => disabled,
  };
}
