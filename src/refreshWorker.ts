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

// One request per process: answer, then drop the IPC channel so the process
// exits on its own.
process.once('message', (request: RefreshRequest) => {
  let message: object;
  try {
    const range = resolveRefs(request.cwd, request.requestedBranch, request.requestedBase);
    const fingerprint = getReviewFingerprint(request.cwd, range);
    const branchName = getCurrentBranchName(request.cwd);
    message = fingerprint === request.previousFingerprint
      ? {id: request.id, ok: true, range, fingerprint, branchName}
      : {
        id: request.id,
        ok: true,
        range,
        fingerprint,
        branchName,
        review: buildReviewModel({cwd: request.cwd, range, width: request.width}),
      };
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
