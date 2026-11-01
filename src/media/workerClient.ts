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
} from './backend.js';

// The UI side of a forked worker. One long-lived child process does the
// work, a few jobs at a time, nearest-the-viewport first. Every job has a
// deadline; a worker that misses one, or dies, is killed with its whole
// process group and started again after a backoff. Three such failures in a
// minute turn that worker off for the session, so a file that hangs or
// crashes it can never make the app spin. Each worker (media previews, the
// rendered view) has its own instance, so one turning off leaves the other
// serving.

const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000];
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES = 3;
const IDLE_EXIT_MS = 60_000;
const STDERR_TAIL_LIMIT = 4096;

const killsProcessGroup = process.platform !== 'win32';

/** A job that got no answer from the worker: it timed out, the worker died, or the worker is off. */
export type WorkerFailure = {ok: false; state: 'stale' | 'error' | 'unavailable'; reason: string};

/** Each job type's request and answer. */
export type JobMap = Record<string, {request: object; result: object}>;

/** What tells one worker from another. */
export type ForkedWorkerSpec<Type extends string> = {
  // The worker's entry: `<entry>.js` beside the bundled CLI, or
  // `src/<entry>.ts` running from source.
  entry: 'mediaWorker' | 'renderedWorker';
  // Names the worker in failures: `media worker exited (code 3)`.
  label: string;
  // What every job is told once the worker is off: `previews turned off`.
  offLabel: string;
  // The worker's own temp dir, inside the session dir.
  tempSubdir: string;
  deadlinesMs: Record<Type, number>;
  maxInFlight: number;
  // Job types that may run only this many at a time.
  perTypeLimit?: Partial<Record<Type, number>>;
  // Job types that count as one toward their limit, by a shared name: the
  // rendered worker's layout and tile jobs take turns with one browser.
  limitGroups?: Partial<Record<Type, string>>;
};

export type ForkedWorkerOptions<Type extends string> = {
  // The session's temp dir, made on first use; the worker's own temp files
  // go in its `tempSubdir`.
  tempDir: () => string;
  env?: NodeJS.ProcessEnv;
  // Where the worker runs: the repo root.
  cwd?: string;
  modulePath?: string;
  deadlinesMs?: Partial<Record<Type, number>>;
  backoffMs?: readonly number[];
  idleMs?: number;
  // Called once, when failures turn the worker off.
  onDisabled?: (reason: string) => void;
  // Called right after each fork with the new worker's pid.
  onSpawn?: (pid: number) => void;
};

export type ForkedWorker<Jobs extends JobMap> = {
  // `priority`: lower runs first.
  submit<T extends keyof Jobs & string>(type: T, request: Jobs[T]['request'], signal: AbortSignal, priority?: number): Promise<Jobs[T]['result'] | WorkerFailure>;
  // Gives the queued job submitted with `signal` a new priority. A job
  // already sent to the worker keeps running as it is.
  prioritize(signal: AbortSignal, priority: number): void;
  // Ends the worker at once (exit hook): synchronous.
  dispose(): void;
  // Why the worker is off for the session, or null.
  disabledReason(): string | null;
};

type Job = {
  id: number;
  type: string;
  request: object;
  priority: number;
  signal: AbortSignal;
  resolve: (result: object) => void;
  reject: (error: Error) => void;
  requeued: boolean;
  settled: boolean;
  timer?: NodeJS.Timeout;
  // The worker this job was last sent to, so a deadline that outlives it
  // never touches a later worker.
  child?: ChildProcess;
  onAbort?: () => void;
};

// The bundle puts cli.js and the workers side by side in dist/; running
// from source (tsx, vitest) a worker is src/<entry>.ts.
function resolveWorkerModule(entry: string, label: string) {
  const candidates = [
    new URL(`./${entry}.js`, import.meta.url),
    new URL(`../${entry}.ts`, import.meta.url),
  ];
  const found = candidates.find((url) => fs.existsSync(fileURLToPath(url)));
  if (!found) throw new Error(`${label} module not found next to the CLI`);
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

export function createForkedWorker<Jobs extends JobMap>(spec: ForkedWorkerSpec<keyof Jobs & string>, {
  tempDir,
  env = process.env,
  cwd,
  modulePath,
  deadlinesMs = {},
  backoffMs = DEFAULT_BACKOFF_MS,
  idleMs = IDLE_EXIT_MS,
  onDisabled,
  onSpawn,
}: ForkedWorkerOptions<keyof Jobs & string>): ForkedWorker<Jobs> {
  const deadlines: Record<string, number> = {...spec.deadlinesMs, ...deadlinesMs};
  const limits: Partial<Record<string, number>> = spec.perTypeLimit ?? {};
  const groups: Partial<Record<string, string>> = spec.limitGroups ?? {};
  const groupOf = (type: string) => groups[type] ?? type;
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

  const settle = (job: Job, result: object) => {
    // An aborted job is settled with its timer still armed; clearing it here
    // first means no path that finishes a job leaves its deadline running.
    clearTimeout(job.timer);
    if (job.settled) return;
    job.settled = true;
    if (job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
    job.resolve(result);
  };

  const failure = (state: WorkerFailure['state'], reason: string): WorkerFailure => ({ok: false, state, reason});

  const failQueued = (reason: string) => {
    for (const job of queue.splice(0)) settle(job, failure('unavailable', reason));
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
      disabled = `${spec.offLabel}: ${reason}`;
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
      if (job.requeued) settle(job, failure('error', reason));
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
    const reason = `${spec.label} exited (${signal ? `signal ${signal}` : `code ${code}`})${detail ? `: ${detail}` : ''}`;
    for (const job of [...inFlight.values()]) {
      inFlight.delete(job.id);
      clearTimeout(job.timer);
      settle(job, failure('error', reason));
    }
    recordFailure(reason);
    pump();
  };

  const spawnChild = () => {
    const dir = tempDir();
    const workerTemp = path.join(dir, spec.tempSubdir);
    fs.mkdirSync(workerTemp, {recursive: true, mode: 0o700});
    const resolved = modulePath ?? resolveWorkerModule(spec.entry, spec.label);
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
    spawned.on('message', (message: {id?: number}) => {
      if (typeof message?.id !== 'number') return;
      const job = inFlight.get(message.id);
      if (!job) return;
      inFlight.delete(message.id);
      clearTimeout(job.timer);
      consecutiveFailures = 0;
      const {id: _id, ...result} = message;
      settle(job, result);
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
    settle(job, failure('error', 'timed out'));
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
    while (inFlight.size < spec.maxInFlight && queue.length > 0) {
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
          const reason = `${spec.label} failed to start (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`;
          for (const job of queue.splice(0)) settle(job, failure('error', reason));
          recordFailure(reason);
          return;
        }
      }

      queue.sort((left, right) => left.priority - right.priority || left.id - right.id);
      // A job type with a limit waits while that many of it are in flight:
      // the media worker runs one ffmpeg at a time, and a second video job
      // sent now would wait there with its deadline running.
      const running = (type: string) => [...inFlight.values()].filter((each) => groupOf(each.type) === groupOf(type)).length;
      const next = queue.findIndex((each) => running(each.type) < (limits[each.type] ?? Infinity));
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

  function submit(type: string, request: object, signal: AbortSignal, priority = 1): Promise<object> {
    return new Promise<object>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      if (disposed || disabled) {
        resolve(failure('unavailable', disabled ?? spec.offLabel));
        return;
      }
      nextId += 1;
      const job: Job = {id: nextId, type, request, priority, signal, resolve, reject, requeued: false, settled: false};
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
    submit: submit as ForkedWorker<Jobs>['submit'],
    prioritize(signal, priority) {
      const job = queue.find((each) => each.signal === signal && !each.settled);
      if (!job) return;
      job.priority = priority;
      pump();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(forkTimer);
      clearTimeout(idleTimer);
      stopChild();
      for (const job of [...queue.splice(0), ...inFlight.values()]) {
        clearTimeout(job.timer);
        settle(job, failure('unavailable', spec.offLabel));
      }
      inFlight.clear();
    },
    disabledReason: () => disabled,
  };
}

type MediaJobs = {
  inspect: {request: InspectRequest; result: InspectResult};
  render: {request: RenderRequest; result: RenderResult};
  video: {request: VideoRequest; result: VideoResult};
  exportCopy: {request: ExportRequest; result: ExportResult};
};

const MEDIA_WORKER: ForkedWorkerSpec<keyof MediaJobs> = {
  entry: 'mediaWorker',
  label: 'media worker',
  offLabel: 'previews turned off',
  tempSubdir: 'worker',
  deadlinesMs: {
    // Covers a partial clone fetching a blob it never had.
    inspect: 10_000,
    render: 8_000,
    // A probe and up to four frames, each with its own shorter deadline.
    video: 30_000,
    exportCopy: 30_000,
  },
  maxInFlight: 2,
  perTypeLimit: {video: 1},
};

export type WorkerBackendOptions = ForkedWorkerOptions<keyof MediaJobs>;

export type WorkerBackend = MediaBackend & {disabledReason(): string | null};

/** The media worker: reads, verifies and decodes image and video bytes. */
export function createWorkerBackend(options: WorkerBackendOptions): WorkerBackend {
  const worker = createForkedWorker<MediaJobs>(MEDIA_WORKER, options);
  return {
    inspect: (request, signal, priority) => worker.submit('inspect', request, signal, priority),
    render: (request, signal, priority) => worker.submit('render', request, signal, priority),
    video: (request, signal, priority) => worker.submit('video', request, signal, priority),
    exportCopy: (request, signal) => worker.submit('exportCopy', request, signal, -1),
    dispose: worker.dispose,
    disabledReason: worker.disabledReason,
  };
}
