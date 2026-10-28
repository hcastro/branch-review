import fs from 'node:fs';
import {Worker} from 'node:worker_threads';
// The asynchronous refresh runs git and delta without blocking this process
// and reports progress per file and per chunk of tool output.
import {refreshReview} from './review/build.js';

type RefreshRequest = {
  id: number;
  cwd: string;
  requestedBranch: string;
  requestedBase: string;
  width: number;
  previousFingerprint?: string | null;
};

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

const groupKill = process.platform !== 'win32';
// The parent gives each refresh process its own temp dir; the private index
// copy goes there.
const tempDir = process.env.BRANCH_REVIEW_TMPDIR;

// While this thread is busy (a synchronous step), it cannot see the IPC
// channel close. A small thread checks whether the parent is still there
// and, once it is gone, removes this refresh's temp dir and kills this
// process's group (this process and the git or delta it is waiting on). A
// parent killed outright runs no cleanup, so nobody else would remove it.
const PARENT_CHECK_SOURCE = `
const fs = require('node:fs');
const {workerData} = require('node:worker_threads');
setInterval(() => {
  if (process.ppid === workerData.parentPid) return;
  if (workerData.tempDir) {
    try { fs.rmSync(workerData.tempDir, {recursive: true, force: true}); } catch {}
  }
  try { process.kill(workerData.group ? -workerData.pid : workerData.pid, 'SIGKILL'); } catch {}
}, workerData.intervalMs);
`;
const parentCheck = new Worker(PARENT_CHECK_SOURCE, {
  eval: true,
  workerData: {
    parentPid: process.ppid,
    pid: process.pid,
    group: groupKill,
    tempDir,
    intervalMs: 250,
  },
});
parentCheck.unref();

const parentGone = new AbortController();
let answered = false;

// A closed channel before the answer means the parent is gone: stop the git
// or delta the refresh started, remove the temp dir and end the group. After
// the answer it is this process's own disconnect, and it simply exits.
process.once('disconnect', () => {
  if (answered) process.exit(0);
  parentGone.abort();
  if (tempDir) {
    try {
      fs.rmSync(tempDir, {recursive: true, force: true});
    } catch {
      // The parent-check thread tries again.
    }
  }
  try {
    process.kill(groupKill ? -process.pid : process.pid, 'SIGKILL');
  } catch {
    process.exit(0);
  }
});

// The parent only needs to know the refresh is still moving, so progress
// goes out at most this often however fast tool output arrives. A report
// that comes too soon is sent at the end of the interval instead, so the
// parent never sees a gap longer than the real one.
const PROGRESS_INTERVAL_MS = 200;
let lastProgressAt = 0;
let trailingProgress: NodeJS.Timeout | undefined;

function sendProgress(id: number) {
  lastProgressAt = Date.now();
  // The IPC write goes out at once, even while the rest of the refresh keeps
  // this thread busy.
  send!({id, progress: true});
}

function reportProgress(id: number) {
  const wait = lastProgressAt + PROGRESS_INTERVAL_MS - Date.now();
  // Checked before the pending timer: a synchronous step keeps the timer
  // from firing, and its later reports must still go out.
  if (wait <= 0) {
    clearTimeout(trailingProgress);
    trailingProgress = undefined;
    sendProgress(id);
    return;
  }
  if (trailingProgress) return;
  trailingProgress = setTimeout(() => {
    trailingProgress = undefined;
    if (!answered) sendProgress(id);
  }, wait);
  trailingProgress.unref();
}

// One request per process: answer, then drop the IPC channel so the process
// exits on its own.
process.once('message', async (request: RefreshRequest) => {
  let message: object;
  try {
    reportProgress(request.id);
    const result = await refreshReview({
      cwd: request.cwd,
      requestedBranch: request.requestedBranch,
      requestedBase: request.requestedBase,
      width: request.width,
      previousFingerprint: request.previousFingerprint ?? null,
      onProgress: () => reportProgress(request.id),
      signal: parentGone.signal,
    });
    message = {
      id: request.id,
      ok: true,
      range: result.range,
      fingerprint: result.fingerprint,
      branchName: result.branchName,
      ...(result.review === undefined ? {} : {review: result.review}),
    };
  } catch (error) {
    message = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stderr: errorStderr(error),
    };
  }

  answered = true;
  send(message, undefined, {}, () => process.disconnect());
});
