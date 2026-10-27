import {Worker} from 'node:worker_threads';
import type {DiffRange} from '../git.js';
import type {ReviewModel} from './model.js';

type WorkerRefreshOptions = {
  cwd: string;
  requestedBranch: string;
  requestedBase: string;
  width: number;
  previousFingerprint?: string | null;
};

type WorkerRefreshResult = {
  range: DiffRange;
  fingerprint: string;
  review?: ReviewModel;
};

type WorkerRefreshMessage =
  | ({id: number; ok: true} & WorkerRefreshResult)
  | {id: number; ok: false; error: string};

let requestId = 0;

export function refreshReviewInWorker(options: WorkerRefreshOptions): Promise<WorkerRefreshResult> {
  const id = requestId += 1;
  const worker = new Worker(new URL('./refreshWorker.js', import.meta.url), {
    execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type')),
  });

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', handleMessage);
      worker.off('error', handleError);
      void worker.terminate();
    };

    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const handleMessage = (message: WorkerRefreshMessage) => {
      if (message.id !== id) return;
      cleanup();

      if (message.ok) {
        resolve({
          range: message.range,
          fingerprint: message.fingerprint,
          review: message.review,
        });
        return;
      }

      reject(new Error(message.error));
    };

    worker.on('message', handleMessage);
    worker.on('error', handleError);
    worker.postMessage({
      id,
      ...options,
    });
  });
}
