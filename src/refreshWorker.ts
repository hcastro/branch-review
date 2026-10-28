import {Worker} from 'node:worker_threads';
import {getCurrentBranchName, getReviewFingerprint, resolveRefs} from './git.js';
import {buildReviewModel} from './review/build.js';

type RefreshRequest = {
  id: number;
  cwd: string;
  requestedBranch: string;
  requestedBase: string;
  width: number;
  previousFingerprint?: string | null;
};

// `onFileBuilt` is called once after each file is built; it lets the parent
// tell a large refresh that keeps moving from a stuck one.
type BuildOptions = Parameters<typeof buildReviewModel>[0] & {onFileBuilt?: () => void};

function errorStderr(error: unknown) {
  const stderr = (error as {stderr?: unknown} | null)?.stderr;
  if (typeof stderr === 'string') return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  return undefined;
}

const send = process.send?.bind(process);
if (!send) {
  throw new Error('refreshWorker must run as a forked child process');
}

// The refresh is synchronous, so while it waits on git this thread cannot
// see the IPC channel close. A small thread checks whether the parent is
// still there and, once it is gone, kills this process's group (this process
// and the git or delta it is waiting on).
const PARENT_CHECK_SOURCE = `
const {workerData} = require('node:worker_threads');
setInterval(() => {
  if (process.ppid === workerData.parentPid) return;
  try { process.kill(workerData.group ? -workerData.pid : workerData.pid, 'SIGKILL'); } catch {}
}, workerData.intervalMs);
`;
const parentCheck = new Worker(PARENT_CHECK_SOURCE, {
  eval: true,
  workerData: {
    parentPid: process.ppid,
    pid: process.pid,
    group: process.platform !== 'win32',
    intervalMs: 250,
  },
});
parentCheck.unref();

// When the event loop is free, a closed channel ends the process at once.
process.once('disconnect', () => process.exit(0));

// Sent as a step finishes. The IPC write goes out at once, even while the
// rest of the refresh keeps this thread busy.
function reportProgress(id: number) {
  send!({id, progress: true});
}

// One request per process: answer, then drop the IPC channel so the process
// exits on its own.
process.once('message', (request: RefreshRequest) => {
  let message: object;
  try {
    reportProgress(request.id);
    const range = resolveRefs(request.cwd, request.requestedBranch, request.requestedBase);
    reportProgress(request.id);
    const fingerprint = getReviewFingerprint(request.cwd, range);
    reportProgress(request.id);
    const branchName = getCurrentBranchName(request.cwd);
    if (fingerprint === request.previousFingerprint) {
      message = {id: request.id, ok: true, range, fingerprint, branchName};
    } else {
      const buildOptions: BuildOptions = {
        cwd: request.cwd,
        range,
        width: request.width,
        onFileBuilt: () => reportProgress(request.id),
      };
      message = {id: request.id, ok: true, range, fingerprint, branchName, review: buildReviewModel(buildOptions)};
    }
  } catch (error) {
    message = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: errorStderr(error),
    };
  }

  send(message, undefined, {}, () => process.disconnect());
});
