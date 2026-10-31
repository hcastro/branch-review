import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import type {FileStatus} from '../git.js';
import {createAssetResolver, LOOKUP_BUDGET_MS, pageLookups, type AssetResolver, type AssetSides} from './assets.js';
import type {ChangeGroup} from './changes.js';
import {renderMarkdown, type LinkAnswer, type RenderedFragment} from './markdown.js';

// `--render-out` renders each file in a worker thread under a deadline. The
// markdown parser is synchronous, and some inputs (thousands of nested list
// levels, a long run of emphasis markers) keep it busy for minutes; only a
// thread can be stopped in the middle of that. One thread serves every file
// in turn and is replaced after it's stopped.

/**
 * One file to render. Links resolve from `links` by repo path; any other
 * path is outside the review. Images follow the asset rule on `assets`.
 */
export type RenderJob = {cwd: string; path: string; oldPath?: string; status: FileStatus; source: string; groups: ChangeGroup[]; links: Record<string, LinkAnswer>; assets: AssetSides};

type Reply = {fragment: RenderedFragment} | {error: string};

const THREAD_TAG = 'branch-review-render-thread';

// Running from source (tsx, vitest) this module is a .ts file. tsx's hooks
// don't reach a worker thread, so the thread registers them itself before
// loading it. In the bundle the module is plain JS and loads directly.
function startWorker(modulePath: string) {
  if (!modulePath.endsWith('.ts')) return new Worker(modulePath, {workerData: THREAD_TAG, stdout: true, stderr: true});
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href;
  const boot = `import(${JSON.stringify(tsx)}).then(({register}) => { register(); return import(${JSON.stringify(pathToFileURL(modulePath).href)}); });`;
  return new Worker(boot, {eval: true, workerData: THREAD_TAG, stdout: true, stderr: true});
}

export function createRenderThread({deadlineMs}: {deadlineMs: number}) {
  let current: Promise<Worker> | null = null;

  const start = () => {
    const worker = startWorker(fileURLToPath(import.meta.url));
    return new Promise<Worker>((resolve, reject) => {
      worker.once('message', () => resolve(worker));
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('the render thread stopped while starting')));
    });
  };

  const stop = () => {
    const stopping = current;
    current = null;
    return stopping?.then((worker) => worker.terminate(), () => undefined);
  };

  return {
    /** The fragment, or a one-line error for a file that threw or ran past the deadline. */
    async render(job: RenderJob): Promise<RenderedFragment> {
      current ??= start();
      let worker: Worker;
      try {
        worker = await current;
      } catch (error) {
        current = null;
        throw error;
      }
      return new Promise<RenderedFragment>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        const onMessage = (reply: Reply) => {
          finish();
          if ('error' in reply) reject(new Error(reply.error));
          else resolve(reply.fragment);
        };
        // A thread that crashed or ran out of memory is replaced for the next file.
        const onError = (error: Error) => {
          finish();
          void stop();
          reject(error);
        };
        const onExit = () => onError(new Error('the render thread stopped'));
        const timer = setTimeout(() => {
          finish();
          void stop();
          reject(new Error('took too long to render'));
        }, deadlineMs);
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.postMessage(job);
      });
    },
    async close() {
      await stop();
    },
  };
}

// The thread's side. One resolver per repo, so each tree is listed once for
// the whole run.
if (!isMainThread && workerData === THREAD_TAG) {
  const port = parentPort!;
  const resolvers = new Map<string, AssetResolver>();
  port.on('message', (job: RenderJob) => {
    let resolver = resolvers.get(job.cwd);
    if (!resolver) {
      resolver = createAssetResolver({cwd: job.cwd});
      resolvers.set(job.cwd, resolver);
    }
    renderMarkdown({
      path: job.path,
      ...(job.oldPath ? {basePath: job.oldPath} : {}),
      status: job.status,
      source: job.source,
      groups: job.groups,
      // Within the render deadline, so a slow git costs cards, not the page.
      ...pageLookups(resolver, job.assets, job.status === 'deleted', [], {budgetMs: LOOKUP_BUDGET_MS}),
      // Own keys only: a link to `constructor` names no file in the review.
      link: (repoPath) => (Object.hasOwn(job.links, repoPath) ? job.links[repoPath]! : {kind: 'outside'}),
    }).then(
      (fragment) => port.postMessage({fragment} satisfies Reply),
      (error: unknown) => port.postMessage({error: error instanceof Error ? error.message : String(error)} satisfies Reply),
    );
  });
  port.postMessage('ready');
}
