import {createForkedWorker, type ForkedWorkerOptions, type ForkedWorkerSpec} from '../media/workerClient.js';
import type {RenderedBackend, RenderedJobs} from './backend.js';

// The UI side of the rendered worker: the same supervision as the media
// worker's, with its own deadlines and its own three strikes. A renderer
// that keeps hanging turns the rendered view off and leaves image previews
// running, and the reverse.

const RENDERED_WORKER: ForkedWorkerSpec<keyof RenderedJobs> = {
  entry: 'renderedWorker',
  label: 'rendered worker',
  offLabel: 'rendered view turned off',
  tempSubdir: 'rendered-worker',
  deadlinesMs: {
    fragment: 5_000,
    // Covers rendering the fragment again when the worker no longer holds it.
    page: 8_000,
    // Its git grep stops itself at 2 seconds.
    embedders: 4_000,
  },
  maxInFlight: 2,
};

export type RenderedBackendOptions = ForkedWorkerOptions<keyof RenderedJobs>;

export function createRenderedBackend(options: RenderedBackendOptions): RenderedBackend {
  const worker = createForkedWorker<RenderedJobs>(RENDERED_WORKER, options);
  return {
    fragment: (request, signal, priority) => worker.submit('fragment', request, signal, priority),
    prioritize: worker.prioritize,
    // Ahead of every fragment: a page is what someone is waiting for.
    page: (request, signal) => worker.submit('page', request, signal, -1),
    embedders: (request, signal) => worker.submit('embedders', request, signal, 1),
    dispose: worker.dispose,
    disabledReason: worker.disabledReason,
  };
}
