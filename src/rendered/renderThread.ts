import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import type {FileStatus} from '../git.js';
import {createAssetResolver, LATE_IDENTITY, pageLookups, type AssetResolver, type AssetSides, type AssetUse} from './assets.js';
import type {ChangeGroup} from './changes.js';
import {renderMarkdown, type LinkAnswer, type RenderedFragment} from './markdown.js';

// `--export-html` renders each file in a worker thread under a deadline. The
// markdown parser is synchronous, and some inputs (thousands of nested list
// levels, a long run of emphasis markers) keep it busy for minutes; only a
// thread can be stopped in the middle of that. One thread serves every file
// in turn and is replaced after it's stopped.

/**
 * One file to render. Links resolve from `links` by repo path; any other
 * path resolves against what git holds. Images follow the asset rule on
 * `assets`, their lookups within `budgetMs`. `textUnchanged`: markdown the
 * review didn't change, marked by the images it shows alone.
 */
export type RenderJob = {cwd: string; path: string; oldPath?: string; status: FileStatus; textUnchanged?: true; source: string; groups: ChangeGroup[]; links: Record<string, LinkAnswer>; assets: AssetSides; budgetMs: number};

/**
 * A render, and whether any of its lookups ran out of time: then it shows
 * less than it will once they answer. `settled`: a late render's lookups
 * have all answered in the thread, so a render asked for again finds them
 * at hand. It settles, too, when the thread stops or the deadline passes.
 */
export type RenderThreadResult = {fragment: RenderedFragment; late?: true; settled: Promise<void>};

// Each message names its job, so a late job's word that its lookups
// settled never reads as the answer to the next one.
type Reply = {id: number} & ({fragment: RenderedFragment; late?: true} | {error: string} | {settled: true});

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
  let jobs = 0;

  // Settles when the thread says job `id`'s lookups have, or it stops, or
  // the deadline passes.
  const settledFor = (worker: Worker, id: number) => new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('exit', done);
      worker.off('error', done);
      resolve();
    };
    const onMessage = (reply: Reply) => {
      if (reply.id === id && 'settled' in reply) done();
    };
    const timer = setTimeout(done, deadlineMs);
    timer.unref?.();
    worker.on('message', onMessage);
    worker.once('exit', done);
    worker.once('error', done);
  });

  const start = () => {
    const worker = startWorker(fileURLToPath(import.meta.url));
    return new Promise<Worker>((resolve, reject) => {
      worker.once('message', () => resolve(worker));
      worker.once('error', reject);
      worker.once('exit', () => reject(new Error('the page thread stopped while starting')));
    });
  };

  const stop = () => {
    const stopping = current;
    current = null;
    return stopping?.then((worker) => worker.terminate(), () => undefined);
  };

  return {
    /** The fragment, or a one-line error for a file that threw or ran past the deadline. */
    async render(job: RenderJob): Promise<RenderThreadResult> {
      current ??= start();
      let worker: Worker;
      try {
        worker = await current;
      } catch (error) {
        current = null;
        throw error;
      }
      const id = (jobs += 1);
      return new Promise<RenderThreadResult>((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
        };
        const onMessage = (reply: Reply) => {
          if (reply.id !== id || 'settled' in reply) return;
          finish();
          if ('error' in reply) reject(new Error(reply.error));
          else resolve({fragment: reply.fragment, ...(reply.late ? {late: true as const} : {}), settled: reply.late ? settledFor(worker, id) : Promise.resolve()});
        };
        // A thread that crashed or ran out of memory is replaced for the next file.
        const onError = (error: Error) => {
          finish();
          void stop();
          reject(error);
        };
        const onExit = () => onError(new Error('the page thread stopped'));
        const timer = setTimeout(() => {
          finish();
          void stop();
          reject(new Error('took too long to prepare'));
        }, deadlineMs);
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.postMessage({...job, id});
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
  port.on('message', (job: RenderJob & {id: number}) => {
    let resolver = resolvers.get(job.cwd);
    if (!resolver) {
      resolver = createAssetResolver({cwd: job.cwd});
      resolvers.set(job.cwd, resolver);
    }
    // Within the render deadline, so a slow git costs cards, not the page.
    const uses: AssetUse[] = [];
    const lookups = pageLookups(resolver, job.assets, job.status === 'deleted', uses, {budgetMs: job.budgetMs});
    renderMarkdown({
      path: job.path,
      ...(job.oldPath ? {basePath: job.oldPath} : {}),
      status: job.status,
      ...(job.textUnchanged ? {textUnchanged: true as const} : {}),
      source: job.source,
      groups: job.groups,
      ...lookups,
      // Own keys only: a link to `constructor` names no file in the review.
      link: (repoPath, hash) => (Object.hasOwn(job.links, repoPath) ? job.links[repoPath]! : lookups.linkTarget(repoPath, hash)),
    }).then(
      (fragment) => {
        const late = uses.some((use) => use.identity === LATE_IDENTITY);
        port.postMessage({id: job.id, fragment, ...(late ? {late: true as const} : {})} satisfies Reply);
        // What ran out of time still answers here, into the resolver's caches.
        if (late) void lookups.settled().then(() => port.postMessage({id: job.id, settled: true} satisfies Reply));
      },
      (error: unknown) => port.postMessage({id: job.id, error: error instanceof Error ? error.message : String(error)} satisfies Reply),
    );
  });
  port.postMessage('ready');
}
