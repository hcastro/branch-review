import {createHash} from 'node:crypto';
import {createLru} from '../../media/lru.js';
import type {WorkerFailure} from '../../media/workerClient.js';
import {createAssetResolver, pageLookups, type AssetResolver, type AssetSides, type AssetUse} from '../assets.js';
import type {FragmentRequest, FragmentResult, FragmentSummary, PageResult, RenderedWorkerRequest} from '../backend.js';
import {renderMarkdown, type RenderInput, type RenderedFragment} from '../markdown.js';
import {assembleFilePage, type PageBody} from '../page.js';
import {createSourceReader, oneLine, pageBody} from '../source.js';

// The rendered worker's jobs, with no process of its own, so tests can run
// them in place. Repo text is read, rendered and assembled here; the UI gets
// back counts and finished pages. Fragments are held by key, so writing a
// page or a new rail costs no second render.

const FRAGMENT_CACHE_BYTES = 32 * 1024 * 1024;

type Held = {body: PageBody; summary: FragmentSummary; uses: AssetUse[]};

// JavaScript strings take two bytes a character.
function heldBytes(held: Held) {
  const body = held.body;
  const text = body.kind === 'rendered' ? body.fragment.html : body.kind === 'tooLarge' ? body.head : body.kind === 'failed' ? body.source : '';
  return text.length * 2 + 1024;
}

export function summarize(body: PageBody, uses: readonly AssetUse[] = []): FragmentSummary {
  // Lookups finish in whatever order git answers them, so the signature
  // reads them sorted and once each: the same images, the same signature.
  const named = [...new Set(uses.map((use) => JSON.stringify([use.side, use.path, use.identity])))].sort();
  const assets = named.length === 0 ? '' : createHash('sha256').update(JSON.stringify(named)).digest('hex').slice(0, 20);
  const empty: Pick<RenderedFragment, 'changes' | 'differences' | 'blocks' | 'headings' | 'links'> = {changes: {changed: 0, removed: 0}, differences: [], blocks: [], headings: [], links: []};
  if (body.kind === 'rendered') {
    const {changes, differences, blocks, headings, links} = body.fragment;
    return {kind: 'rendered', changes, differences, blocks, headings, links, assets};
  }
  return {kind: body.kind, ...empty, assets, ...(body.kind === 'failed' ? {reason: body.reason} : {})};
}

type HandlerOptions = {
  render?: (input: RenderInput) => Promise<RenderedFragment>;
  sleep?: (ms: number) => Promise<void>;
  // How long a page's image lookups may take, for a process whose jobs
  // have a deadline (pageLookups).
  lookupBudgetMs?: number;
};

export function createRenderedHandler({render = renderMarkdown, sleep, lookupBudgetMs}: HandlerOptions = {}) {
  const sources = createSourceReader(sleep ? {sleep} : {});
  const resolvers = new Map<string, AssetResolver>();
  const held = createLru<Held>(FRAGMENT_CACHE_BYTES, heldBytes);

  const resolverFor = (cwd: string) => {
    let resolver = resolvers.get(cwd);
    if (!resolver) {
      resolver = createAssetResolver({cwd});
      resolvers.set(cwd, resolver);
    }
    return resolver;
  };

  // A held fragment is current while every image it looked up would still
  // get the same answer: the key covers the file's own text, not the
  // images it embeds.
  const current = async (entry: Held, cwd: string, sides: AssetSides) => {
    const resolver = resolverFor(cwd);
    for (const use of entry.uses) {
      if (await resolver.identity(sides, use.side, use.path) !== use.identity) return false;
    }
    return true;
  };

  async function fragment(request: FragmentRequest): Promise<Held> {
    const known = held.get(request.key);
    if (known && await current(known, request.cwd, request.assets)) return known;

    const uses: AssetUse[] = [];
    const lookups = pageLookups(resolverFor(request.cwd), request.assets, request.status === 'deleted', uses, lookupBudgetMs === undefined ? {} : {budgetMs: lookupBudgetMs});
    // Own keys only: a link to `constructor` names no file in the review.
    const link: RenderInput['link'] = (repoPath) => (Object.hasOwn(request.links, repoPath) ? request.links[repoPath]! : {kind: 'outside'});
    const body = await pageBody(
      () => sources.read(request.cwd, request.source),
      (source) => render({path: request.path, ...(request.oldPath ? {basePath: request.oldPath} : {}), source, groups: request.groups, ...lookups, link}),
    );
    const entry: Held = {body, summary: summarize(body, uses), uses};
    // A failure can depend on the moment (a file mid-write), so it is
    // rendered again next time rather than held.
    if (body.kind !== 'failed') held.set(request.key, entry);
    return entry;
  }

  return {
    async handle(message: RenderedWorkerRequest): Promise<FragmentResult | PageResult> {
      try {
        if (message.type === 'fragment') {
          const {type: _type, ...request} = message;
          return {ok: true, summary: (await fragment(request)).summary};
        }
        const {body, summary} = 'fragment' in message.content ? await fragment(message.content.fragment) : {body: message.content.body, summary: summarize(message.content.body)};
        const html = assembleFilePage({title: message.title, file: {...message.file, body}, rail: message.rail});
        return {ok: true, html, summary};
      } catch (error) {
        return {ok: false, state: 'error', reason: oneLine(error)} satisfies WorkerFailure;
      }
    },
  };
}
