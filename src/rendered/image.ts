import type {FileStatus} from '../git.js';
import type {AssetAnswer, RefusedReason} from './markdown.js';

// An image or SVG file's own page: both sides of the file as the review
// shows them, each inlined under the asset rule or a card saying why not,
// with their sizes. SVG goes in as an `<img>` data URI, as GitHub shows it,
// so no script in it runs and it loads nothing.

/** One side of the file: the picture inlined, or the card in its place. */
export type ImageSide =
  | {kind: 'shown'; dataUrl: string; mime: string; bytes: number; width?: number; height?: number}
  | {kind: 'card'; reason: RefusedReason; hint?: string};

export type ImageBody = {format: 'raster' | 'svg'; before: ImageSide | null; after: ImageSide | null};

/** What the overview and the file head say of each side. */
export type ImageFacts = {before?: SideFacts; after?: SideFacts};
type SideFacts = {bytes: number; width?: number; height?: number} | {card: RefusedReason};

const decodedBytes = (dataUrl: string) => Buffer.byteLength(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

function sideOf(answer: AssetAnswer): ImageSide {
  if (answer.kind === 'embed') {
    return {kind: 'shown', dataUrl: answer.dataUrl, mime: answer.mime, bytes: decodedBytes(answer.dataUrl), ...(answer.width && answer.height ? {width: answer.width, height: answer.height} : {})};
  }
  // A lookup that reads no local image says so, as the markdown pages do.
  if (answer.kind === 'skipped') return {kind: 'card', reason: 'unreadable', hint: 'not embedded'};
  return {kind: 'card', reason: answer.reason, ...(answer.hint ? {hint: answer.hint} : {})};
}

/**
 * The file's two sides. A new file has no base side and a deleted one no
 * after side; a moved file's base side is at `oldPath`. `asset` and
 * `baseAsset` are the page lookups (pageLookups), which read the after and
 * the base side.
 */
export async function imageBody({format, path, oldPath, status, asset, baseAsset}: {
  format: ImageBody['format'];
  path: string;
  oldPath?: string;
  status: FileStatus;
  asset: (repoPath: string) => Promise<AssetAnswer>;
  baseAsset: (repoPath: string) => Promise<AssetAnswer>;
}): Promise<ImageBody> {
  const isNew = status === 'added' || status === 'untracked';
  const [before, after] = await Promise.all([
    isNew ? null : baseAsset(oldPath ?? path).then(sideOf),
    status === 'deleted' ? null : asset(path).then(sideOf),
  ]);
  return {format, before, after};
}

const factsOf = (side: ImageSide): SideFacts => (side.kind === 'card' ? {card: side.reason} : {bytes: side.bytes, ...(side.width && side.height ? {width: side.width, height: side.height} : {})});

export function imageFacts(body: ImageBody): ImageFacts {
  return {...(body.before ? {before: factsOf(body.before)} : {}), ...(body.after ? {after: factsOf(body.after)} : {})};
}

/** `84 KB`, `1.2 MB`, `512 B`. */
export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sideText(side: SideFacts) {
  if ('card' in side) return 'not shown';
  return side.width && side.height ? `${side.width}×${side.height} · ${sizeText(side.bytes)}` : sizeText(side.bytes);
}

/** Each side's dimensions and size: `1200×480 · 84 KB → 1200×520 · 91 KB`, or one side alone. */
export function describeImage(facts: ImageFacts): string {
  const {before, after} = facts;
  if (before && after) return `${sideText(before)} → ${sideText(after)}`;
  const only = after ?? before;
  return only ? sideText(only) : '';
}
