import type {FileStatus} from '../git.js';
import type {WorkerFailure} from '../media/workerClient.js';
import type {AssetSides} from './assets.js';
import type {ChangeGroup} from './changes.js';
import type {LinkAnswer, RenderedFragment} from './markdown.js';
import type {PageBody, PageInput, RailEntry} from './page.js';
import type {SourceSpec} from './source.js';

// The jobs the UI process asks of the rendered worker, and their answers.
// The UI side only sees this interface, so service tests can answer it in
// process. The worker keeps each fragment's HTML; the UI holds what it needs
// to name pages and label the rail.

/** One markdown file to render, from the side the review shows. */
export type FragmentRequest = {
  cwd: string;
  /** Names the fragment's content: the same key, the same HTML, unless an image it embeds changed. */
  key: string;
  path: string;
  /** Where the file was on the base side, when the review moved it: the base side's images resolve from there. */
  oldPath?: string;
  status: FileStatus;
  source: SourceSpec;
  groups: ChangeGroup[];
  /** How a link to each rendered file resolves; any other repo path is outside the review. */
  links: Record<string, LinkAnswer>;
  assets: AssetSides;
};

/** What the UI keeps of a fragment: its page's state and counts, never its HTML. */
export type FragmentSummary = {
  kind: PageBody['kind'];
  changes: RenderedFragment['changes'];
  differences: RenderedFragment['differences'];
  blocks: RenderedFragment['blocks'];
  headings: RenderedFragment['headings'];
  links: RenderedFragment['links'];
  /** A failed page's one-line reason. */
  reason?: string;
  /** Names the images the page embeds and how each resolved: it changes when one of them does. */
  assets: string;
};

export type FragmentResult = {ok: true; summary: FragmentSummary} | WorkerFailure;

/**
 * One whole page. Its body is the fragment the worker rendered for that
 * request (rendered again if the worker no longer holds it), or a body the
 * UI already knows, such as a file whose render kept timing out.
 */
export type PageRequest = {
  key: string;
  title: PageInput['title'];
  file: {path: string; status: FileStatus; oldPath?: string};
  rail: RailEntry[];
  content: {fragment: FragmentRequest} | {body: PageBody};
};

export type PageResult = {ok: true; html: string; summary: FragmentSummary} | WorkerFailure;

export interface RenderedBackend {
  // `priority`: lower runs first; the active file asks with 0.
  fragment(request: FragmentRequest, signal: AbortSignal, priority?: number): Promise<FragmentResult>;
  // Moves a fragment still waiting for the worker, asked for with `signal`, to `priority`.
  prioritize(signal: AbortSignal, priority: number): void;
  page(request: PageRequest, signal: AbortSignal): Promise<PageResult>;
  // Ends the worker at once (exit hook): synchronous.
  dispose(): void;
  // Why the rendered view is off for the session (the worker kept failing), or null.
  disabledReason(): string | null;
}

export type RenderedJobs = {
  fragment: {request: FragmentRequest; result: FragmentResult};
  page: {request: PageRequest; result: PageResult};
};

export type RenderedWorkerRequest = ({type: 'fragment'} & FragmentRequest) | ({type: 'page'} & PageRequest);
