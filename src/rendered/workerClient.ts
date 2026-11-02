import {createForkedWorker, type ForkedWorkerOptions, type ForkedWorkerSpec} from '../media/workerClient.js';
import {BROWSER_JOB_DEADLINES_MS, type RenderedBackend, type RenderedJobs} from './backend.js';

// The UI side of the rendered worker: the same supervision as the media
// worker's, with its own deadlines and its own three strikes. A renderer
// that keeps hanging turns the rendered view off and leaves image previews
// running, and the reverse.

const RENDERED_WORKER: ForkedWorkerSpec<keyof RenderedJobs> = {
  entry: 'renderedWorker',
  label: 'page worker',
  offLabel: 'Preview and Review in browser turned off',
  tempSubdir: 'rendered-worker',
  deadlinesMs: {
    fragment: 5_000,
    // The whole branch: the worker stops coloring and rendering cards well
    // before this, and draws the rest plain or on their way.
    review: 30_000,
    // Its git grep stops itself at 2 seconds.
    embedders: 4_000,
    // Each includes a cold Chromium start: a tile after the browser closed
    // for idling starts it again. The worker keeps the browser inside them,
    // so a browser that hangs costs a browser strike and not one of the
    // worker's.
    ...BROWSER_JOB_DEADLINES_MS,
  },
  maxInFlight: 2,
  // Layouts and tiles take turns with the worker's one browser, waiting
  // here rather than in the worker, so a job's deadline starts with its turn.
  perTypeLimit: {layout: 1, tile: 1},
  limitGroups: {layout: 'browser', tile: 'browser'},
};

export type RenderedBackendOptions = ForkedWorkerOptions<keyof RenderedJobs>;

export function createRenderedBackend(options: RenderedBackendOptions): RenderedBackend {
  const worker = createForkedWorker<RenderedJobs>(RENDERED_WORKER, options);
  return {
    fragment: (request, signal, priority) => worker.submit('fragment', request, signal, priority),
    prioritize: worker.prioritize,
    // Ahead of every fragment: the page is what someone is waiting for.
    review: (request, signal) => worker.submit('review', request, signal, -1),
    embedders: (request, signal) => worker.submit('embedders', request, signal, 1),
    layout: (request, signal, priority = 0) => worker.submit('layout', request, signal, priority),
    tile: (request, signal, priority) => worker.submit('tile', request, signal, priority),
    dispose: worker.dispose,
    disabledReason: worker.disabledReason,
  };
}
