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
    pressReview: 30_000,
    // Its git grep stops itself at 2 seconds.
    embedders: 4_000,
    // Each includes a cold Chromium start: a tile after the browser closed
    // for idling starts it again. The worker keeps the browser inside them,
    // so a browser that hangs costs a browser strike and not one of the
    // worker's.
    ...BROWSER_JOB_DEADLINES_MS,
  },
  // Fragments and the embedders search share two turns, layouts and tiles
  // one (the worker's one browser), and the whole-branch pages two: a page
  // a pass writes in the background runs only while no other page does,
  // and a press's page beside one, so a page someone is waiting for never
  // waits for a turn, not even behind a slow page the last edit asked for.
  // Each waits here rather than in the worker, so a job's deadline starts
  // with its turn.
  maxInFlight: 5,
  perTypeLimit: {fragment: 2, embedders: 2, layout: 1, tile: 1, review: 1, pressReview: 2},
  limitGroups: {fragment: 'render', embedders: 'render', layout: 'browser', tile: 'browser', review: 'page', pressReview: 'page'},
  sendAs: {pressReview: 'review'},
};

export type RenderedBackendOptions = ForkedWorkerOptions<keyof RenderedJobs>;

export function createRenderedBackend(options: RenderedBackendOptions): RenderedBackend {
  const worker = createForkedWorker<RenderedJobs>(RENDERED_WORKER, options);
  return {
    fragment: (request, signal, priority) => worker.submit('fragment', request, signal, priority),
    prioritize: worker.prioritize,
    // Ahead of every fragment: the page is what someone is waiting for.
    review: (request, signal, press) => worker.submit(press ? 'pressReview' : 'review', request, signal, -1),
    promote: (signal) => worker.promote(signal, 'pressReview'),
    embedders: (request, signal) => worker.submit('embedders', request, signal, 1),
    layout: (request, signal, priority = 0) => worker.submit('layout', request, signal, priority),
    tile: (request, signal, priority) => worker.submit('tile', request, signal, priority),
    dispose: worker.dispose,
    disabledReason: worker.disabledReason,
  };
}
