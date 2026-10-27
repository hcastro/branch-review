import {parentPort} from 'node:worker_threads';
import {getReviewFingerprint, resolveRefs} from './git.js';
import {buildReviewModel} from './review/build.js';

type RefreshRequest = {
  id: number;
  cwd: string;
  requestedBranch: string;
  requestedBase: string;
  width: number;
  previousFingerprint?: string | null;
};

if (!parentPort) {
  throw new Error('refreshWorker must run inside a worker thread');
}

parentPort.on('message', (request: RefreshRequest) => {
  try {
    const range = resolveRefs(request.cwd, request.requestedBranch, request.requestedBase);
    const fingerprint = getReviewFingerprint(request.cwd, range);
    if (fingerprint === request.previousFingerprint) {
      parentPort?.postMessage({
        id: request.id,
        ok: true,
        range,
        fingerprint,
      });
      return;
    }

    const review = buildReviewModel({
      cwd: request.cwd,
      range,
      width: request.width,
    });

    parentPort?.postMessage({
      id: request.id,
      ok: true,
      range,
      fingerprint,
      review,
    });
  } catch (error) {
    parentPort?.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
