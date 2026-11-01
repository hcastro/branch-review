import {isUtf8} from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import {
  FileTooLargeError,
  gitBlobId,
  grepTreeFilesOperation,
  localBlobOperation,
  matchingBlobId,
  objectFormatOperation,
  readWorktreeBytes,
  runOperationAsync,
  type ObjectFormat,
  type TreeEntry,
} from '../git.js';
import {createLru} from '../media/lru.js';
import {isFormat, magicFormat, sniffImage} from '../media/worker/sniff.js';
import {isMarkdownName} from './classify.js';
import {anchorTarget, markdownAnchors, type AssetAnswer, type LinkAnswer, type RefusedReason} from './markdown.js';
import {RENDER_LIMIT} from './source.js';
import {createTreeReader, type RunOperation, type TreeIndex} from './tree.js';
import type {AssetSide, AssetSides, WorktreeChange} from './sides.js';

export {reviewAssetSides, reviewPaths, type AssetSide, type AssetSides, type WorktreeChange} from './sides.js';

// The asset rule: which images a page inlines. An image is inlined only when
// its path stays inside the repo, it is a regular file (never a symlink or a
// submodule), and git tracks it on that side of the diff or the review
// changed it. Its bytes are proven to be the ones git or the review named.
// Every other image is a card saying why GitHub won't show it either:
// untracked, ignored, a case mismatch, an LFS pointer. Ignored files are
// never read, and in a partial clone nothing is fetched: a blob the clone
// lacks is a card, and so is every image on a git too old to promise that.

const MIB = 1024 * 1024;
// One image's most inlined bytes; an SVG's, as the media reader reads them.
const IMAGE_LIMIT = 8 * MIB;
const SVG_LIMIT = 4 * MIB;
// An LFS pointer is a short text file that starts like this.
const LFS_POINTER = 'version https://git-lfs.github.com/spec/';
const LFS_POINTER_MAX_BYTES = 1024;
// Verified bytes held for the session: the asset cache.
const CACHE_BYTES = 64 * MIB;
// Reads at once: a page with dozens of images reads several side by side
// without starting dozens of git processes.
const MAX_READS = 6;
// How long the search for markdown that shows a changed image may take, and
// how many files it may find.
const EMBEDDERS_MS = 2_000;
const MAX_EMBEDDERS = 40;
// The anchors of markdown files outside the review that links point into,
// by blob id: a few hundred bytes of ids each.
const MAX_ANCHOR_SETS = 256;

/**
 * How long one page's image lookups may take, from the start of its render,
 * where a deadline of 5 seconds stops a render that runs longer.
 */
export const LOOKUP_BUDGET_MS = 3_000;

// Why an image couldn't be read, in words of our own: an error's own text
// can carry an absolute path, and a page never shows one.
const UNREADABLE = {
  file: "can't read the file",
  git: "can't read it from git",
  mismatch: "doesn't match git: changed since the review read it, or by a git filter",
  late: 'took too long to read',
} as const;

// Where an image's bytes are, or why there are none.
type Located =
  | {kind: 'blob'; path: string; oid: string}
  | {kind: 'file'; path: string; id: string; untracked?: true}
  | {kind: 'refused'; reason: RefusedReason; hint?: string};

type Answered = {answer: AssetAnswer; identity: string};

type Verified = {bytes: Buffer; oid: string};

function refused(reason: RefusedReason, hint?: string): Extract<Located, {kind: 'refused'}> {
  return {kind: 'refused', reason, ...(hint ? {hint} : {})};
}

const unreadable = (hint: string): AssetAnswer => ({kind: 'refused', reason: 'unreadable', hint});

// `logo.png vs Logo.png`, or the whole paths when a folder differs.
function caseHint(written: string, actual: string) {
  return path.posix.dirname(written) === path.posix.dirname(actual)
    ? `${path.posix.basename(written)} vs ${path.posix.basename(actual)}`
    : `${written} vs ${actual}`;
}

const MIME: Record<string, string> = {png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml'};

// The type the bytes are, from their first bytes, for the formats a
// browser draws in an `<img>`: never from the name, which the repo picks.
function imageType(bytes: Buffer): {mime: string; format?: Parameters<typeof sniffImage>[1]} | null {
  // An SVG has no magic bytes: its root element near the start is the proof.
  const format = magicFormat(bytes) ?? (isFormat(bytes, 'svg') ? 'svg' : null);
  if (format && MIME[format]) return {mime: MIME[format]!, format};
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return {mime: 'image/bmp'};
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x00000100) return {mime: 'image/x-icon'};
  return null;
}

const isLfsPointer = (bytes: Buffer) => bytes.length <= LFS_POINTER_MAX_BYTES && bytes.subarray(0, LFS_POINTER.length).toString('latin1') === LFS_POINTER;

const limitFor = (repoPath: string) => (/\.svg$/i.test(repoPath) ? SVG_LIMIT : IMAGE_LIMIT);

// Runs at most `count` tasks at once, in the order they were asked for.
function createLimiter(count: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < count) active += 1;
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      // A finished task hands its slot straight to the next one waiting.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

// Whether two places hold the same content: the same id (one may be
// abbreviated, as a patch prints it), or the same refusal.
function sameContent(left: Located, right: Located) {
  const idOf = (located: Located) => (located.kind === 'blob' ? located.oid : located.kind === 'file' ? located.id : null);
  const [one, other] = [idOf(left), idOf(right)];
  if (one !== null && other !== null) return one.startsWith(other) || other.startsWith(one);
  return left.kind === 'refused' && right.kind === 'refused' && left.reason === right.reason && left.hint === right.hint;
}

export function createAssetResolver({cwd, run = runOperationAsync, embeddersMs = EMBEDDERS_MS}: {cwd: string; run?: RunOperation; embeddersMs?: number}) {
  const trees = createTreeReader({cwd, run});
  const verified = createLru<Verified>(CACHE_BYTES, (entry) => entry.bytes.byteLength);
  const limit = createLimiter(MAX_READS);
  // Link checks wait for their own turns, so a page with hundreds of links
  // never starts hundreds of git processes, nor holds up its images.
  const checks = createLimiter(MAX_READS);
  let root: Promise<string> | null = null;
  let format: Promise<ObjectFormat> | null = null;
  // Names an answer that is no answer to hold: each one differs from every
  // other identity, so a fragment that showed it renders again next time.
  let retries = 0;
  const retryIdentity = () => `retry:${(retries += 1)}`;

  const objectFormat = () => {
    if (!format) {
      format = run(objectFormatOperation(cwd));
      format.catch(() => {
        format = null;
      });
    }
    return format;
  };

  // A path git doesn't hold here: a case mismatch, a link in the way, or
  // what the work tree has under that name.
  async function miss(index: TreeIndex, repoPath: string, epoch: number): Promise<Located> {
    const match = index.caseMatch(repoPath);
    if (match) return refused('caseMismatch', caseHint(repoPath, match));
    const link = index.linkAbove(repoPath);
    if (link) return refused(link.mode === '160000' ? 'submodule' : 'symlink');
    const state = await trees.untrackedState(repoPath, epoch);
    return refused(state ?? 'missing');
  }

  function inTree(index: TreeIndex, repoPath: string, epoch: number): Promise<Located> | Located {
    const entry = index.get(repoPath);
    if (!entry) return miss(index, repoPath, epoch);
    if (entry.mode === '120000') return refused('symlink');
    if (entry.mode === '160000') return refused('submodule');
    return {kind: 'blob', path: repoPath, oid: entry.oid};
  }

  async function locate(sides: AssetSides, side: AssetSide, repoPath: string): Promise<Located> {
    if (side === 'base' || 'tree' in sides.after) {
      const ref = side === 'base' ? sides.base : (sides.after as {tree: string}).tree;
      if (ref === null) return refused('missing');
      return inTree(await trees.tree(ref, sides.epoch), repoPath, sides.epoch);
    }

    const changes = sides.after.worktree;
    const base = sides.base === null ? null : await trees.tree(sides.base, sides.epoch);
    const change = changes.find((each) => each.path === repoPath);
    const mode = change?.mode;
    if (change && mode === null) return refused('missing');
    if (mode === 'unreadable') return refused('unreadable', UNREADABLE.file);
    if (mode === 'symlink' || mode === 'submodule') return refused(mode);
    if (change?.id) return {kind: 'file', path: repoPath, id: change.id, ...(change.untracked ? {untracked: true as const} : {})};
    // Unchanged by the review, or a pure rename: on disk as the base holds it.
    const entry = base?.get(change?.from ?? repoPath);
    if (entry && (entry.mode === '100644' || entry.mode === '100755')) return {kind: 'file', path: repoPath, id: entry.oid};
    if (entry) return refused(entry.mode === '160000' ? 'submodule' : 'symlink');

    // A path the review deleted or moved away is no case match.
    const gone = new Set(changes.filter((each) => each.mode === null).map((each) => each.path));
    const lower = repoPath.toLowerCase();
    const match = changes.find((each) => each.mode !== null && each.path.toLowerCase() === lower)?.path ?? base?.caseMatch(repoPath);
    if (match && !gone.has(match)) return refused('caseMismatch', caseHint(repoPath, match));
    const linked = changes.find((each) => (each.mode === 'symlink' || each.mode === 'submodule') && repoPath.startsWith(`${each.path}/`));
    if (linked) return refused(linked.mode as 'symlink' | 'submodule');
    const link = base?.linkAbove(repoPath);
    if (link) return refused(link.mode === '160000' ? 'submodule' : 'symlink');
    return refused((await trees.untrackedState(repoPath, sides.epoch)) ?? 'missing');
  }

  // Checks a work tree file is a regular file inside the repo before any
  // byte is read, so the card can say which rule it broke.
  async function checkWorktreeFile(repoPath: string): Promise<AssetAnswer | null> {
    const absolute = path.join(cwd, repoPath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(absolute);
    } catch {
      return {kind: 'refused', reason: 'missing'};
    }
    if (stat.isSymbolicLink()) return {kind: 'refused', reason: 'symlink'};
    if (!stat.isFile()) return {kind: 'refused', reason: 'missing'};
    if (stat.size > limitFor(repoPath)) return {kind: 'refused', reason: 'tooLarge'};
    try {
      root ??= fs.promises.realpath(cwd);
      const [repoRoot, parent] = await Promise.all([root, fs.promises.realpath(path.dirname(absolute))]);
      if (parent !== repoRoot && !parent.startsWith(`${repoRoot}${path.sep}`)) return {kind: 'refused', reason: 'outside'};
    } catch {
      return {kind: 'refused', reason: 'missing'};
    }
    return null;
  }

  // A blob as git holds it. Nothing is fetched (see localBlobOperation).
  async function readBlob(oid: string, max: number): Promise<Verified | AssetAnswer> {
    let bytes: Buffer | null;
    try {
      bytes = await run(localBlobOperation(cwd, oid, max));
    } catch {
      return unreadable(UNREADABLE.git);
    }
    if (bytes === null) return {kind: 'refused', reason: 'tooLarge'};
    const full = gitBlobId(bytes, await objectFormat());
    return full.startsWith(oid) ? {bytes, oid: full} : unreadable(UNREADABLE.git);
  }

  // A work tree file, read once: its bytes must be the content `id` names.
  // A file they don't match isn't read again: the next review names what it
  // holds then.
  async function readFile(repoPath: string, id: string, max: number): Promise<Verified | AssetAnswer> {
    let bytes: Buffer;
    try {
      bytes = await readWorktreeBytes(cwd, repoPath, max);
    } catch (error) {
      return error instanceof FileTooLargeError ? {kind: 'refused', reason: 'tooLarge'} : unreadable(UNREADABLE.file);
    }
    const oid = matchingBlobId(bytes, id, await objectFormat());
    if (oid) return {bytes, oid};
    // A checked-out LFS file is the object itself, while git holds its
    // pointer: GitHub shows that pointer's card.
    const held = await run(localBlobOperation(cwd, id, LFS_POINTER_MAX_BYTES)).catch(() => null);
    return held && isLfsPointer(held) ? {kind: 'refused', reason: 'lfs'} : unreadable(UNREADABLE.mismatch);
  }

  async function load(located: Extract<Located, {kind: 'blob' | 'file'}>): Promise<AssetAnswer> {
    const max = limitFor(located.path);
    if (located.kind === 'file') {
      const problem = await checkWorktreeFile(located.path);
      if (problem) return problem;
    }
    const key = located.kind === 'blob' ? `blob|${located.oid}` : `file|${located.path}|${located.id}`;
    let read: Verified | AssetAnswer | undefined = verified.get(key);
    if (!read) {
      read = await limit(() => (located.kind === 'blob' ? readBlob(located.oid, max) : readFile(located.path, located.id, max)));
      if ('bytes' in read) verified.set(key, read);
    }
    if ('kind' in read) return read;
    const {bytes, oid} = read;
    if (isLfsPointer(bytes)) return {kind: 'refused', reason: 'lfs'};
    const type = imageType(bytes);
    if (!type) return {kind: 'refused', reason: 'notImage'};
    const sniffed = type.format ? sniffImage(bytes, type.format) : null;
    return {
      kind: 'embed',
      mime: type.mime,
      dataUrl: `data:${type.mime};base64,${bytes.toString('base64')}`,
      oid,
      ...(sniffed?.ok ? {width: sniffed.width, height: sniffed.height} : {}),
      ...(located.kind === 'file' && located.untracked ? {untracked: true as const} : {}),
    };
  }

  // What an answer depends on, without reading any bytes: the same identity
  // later means the same answer.
  const identityOf = (located: Located) => (located.kind === 'blob' ? `blob:${located.oid}`
    : located.kind === 'file' ? `file:${located.id}${located.untracked ? ':untracked' : ''}` : `no:${located.reason}:${located.hint ?? ''}`);

  // A read that failed for a reason of the moment, such as a file nobody
  // may read, a git that failed, or a file caught mid-rewrite, is tried
  // again next time.
  const passing = (answer: AssetAnswer) => answer.kind === 'refused' && answer.reason === 'unreadable' && (answer.hint === UNREADABLE.file || answer.hint === UNREADABLE.git || answer.hint === UNREADABLE.mismatch);

  // The anchors of a markdown blob, read once. Null when it can't be read
  // as text within the render limit: nothing to check it against.
  // A read that fails is asked again next time.
  const anchorSets = createLru<Promise<ReadonlySet<string> | null>>(MAX_ANCHOR_SETS, () => 1);
  function blobAnchors(oid: string): Promise<ReadonlySet<string> | null> {
    let ids = anchorSets.get(oid);
    if (!ids) {
      ids = checks(() => run(localBlobOperation(cwd, oid, RENDER_LIMIT))).then(async (bytes) => (bytes && isUtf8(bytes) ? new Set(await markdownAnchors(bytes.toString('utf8'))) : null));
      anchorSets.set(oid, ids);
      ids.catch(() => anchorSets.delete(oid));
    }
    return ids;
  }

  // What the trees and the review's change list say of a link, and, where
  // only a git process can say more, how to ask it (`checked`).
  type LinkStages = {known: LinkAnswer; checked?: () => Promise<LinkAnswer>};

  // A link into a markdown file git holds, at a heading: one GitHub
  // wouldn't find there is a bad anchor. A file that can't be read is a
  // link that works.
  function intoFile(entry: TreeEntry | undefined, repoPath: string, hash: string | undefined): LinkStages {
    if (!hash || !entry || (entry.mode !== '100644' && entry.mode !== '100755') || !isMarkdownName(repoPath)) return {known: {kind: 'outside'}};
    return {
      known: {kind: 'outside'},
      checked: async () => {
        const ids = await blobAnchors(entry.oid);
        return ids && anchorTarget(ids, hash) === null ? {kind: 'badAnchor'} : {kind: 'outside'};
      },
    };
  }

  // Whether GitHub would find a file or folder a link names on the after
  // side: one git holds, or one the review shows, is there; and, for a
  // markdown file the review didn't change, the heading `hash` names. A
  // path in neither is missing, which git can only refine: the work tree
  // may hold it untracked or ignored.
  async function linkStages(sides: AssetSides, repoPath: string, hash?: string): Promise<LinkStages> {
    const found = (index: TreeIndex | null) => Boolean(index && (index.get(repoPath) || index.hasFolder(repoPath)));
    if (!('worktree' in sides.after)) {
      const index = await trees.tree(sides.after.tree, sides.epoch);
      if (found(index) || index.linkAbove(repoPath)) return intoFile(index.get(repoPath), repoPath, hash);
      const match = index.caseMatch(repoPath);
      if (match) return {known: {kind: 'caseMismatch', hint: caseHint(repoPath, match)}};
    } else {
      const changes = sides.after.worktree;
      const change = changes.find((each) => each.path === repoPath);
      if (change) return {known: change.mode === null ? {kind: 'missing'} : change.untracked ? {kind: 'untracked'} : {kind: 'outside'}};
      const base = sides.base === null ? null : await trees.tree(sides.base, sides.epoch);
      const gone = new Set(changes.filter((each) => each.mode === null).map((each) => each.path));
      const under = (each: WorktreeChange) => each.mode !== null && each.path.startsWith(`${repoPath}/`);
      // A folder only the base holds is on disk while a file of it is: the
      // work tree may have deleted every one.
      const folderStays = () => !base?.get(repoPath) && base?.hasFolder(repoPath) ? base.someUnder(repoPath, (file) => !gone.has(file)) : true;
      // Unchanged by the review: on disk as the base holds it.
      if (changes.some(under) || ((found(base) || base?.linkAbove(repoPath)) && folderStays())) return intoFile(base?.get(repoPath), repoPath, hash);
      const lower = repoPath.toLowerCase();
      const match = changes.find((each) => each.mode !== null && each.path.toLowerCase() === lower)?.path ?? base?.caseMatch(repoPath);
      if (match && !gone.has(match)) return {known: {kind: 'caseMismatch', hint: caseHint(repoPath, match)}};
    }
    return {known: {kind: 'missing'}, checked: async () => ({kind: (await checks(() => trees.untrackedState(repoPath, sides.epoch))) ?? 'missing'})};
  }

  return {
    /**
     * The markdown files the review didn't change that hold any of `names`
     * (images' file names), with the blob each one is. A file the review
     * didn't change is on the after side as the after ref holds it, or, in
     * a work tree review, as the base holds it, which is what the diff
     * found on disk. One bounded `git grep` finds them; a search that fails
     * or runs past its time (`embeddersMs`, 2 seconds by default) finds
     * none. Each one is only a candidate: its render tells whether it shows
     * a changed image.
     */
    async embedders(sides: AssetSides, names: readonly string[], skip: ReadonlySet<string>): Promise<Array<{path: string; oid: string}>> {
      const ref = 'tree' in sides.after ? sides.after.tree : sides.base;
      if (ref === null || names.length === 0) return [];
      // The base tree holds files the work tree has since deleted or moved away.
      const gone = new Set('worktree' in sides.after ? sides.after.worktree.filter((each) => each.mode === null).map((each) => each.path) : []);
      try {
        const oid = await trees.treeOid(ref, sides.epoch);
        const index = await trees.tree(ref, sides.epoch);
        const found = await run(grepTreeFilesOperation(cwd, oid, [...new Set(names)]), {signal: AbortSignal.timeout(embeddersMs)});
        return found.filter((file) => isMarkdownName(file) && !skip.has(file) && !gone.has(file)).flatMap((file) => {
          const entry = index.get(file);
          return entry && (entry.mode === '100644' || entry.mode === '100755') ? [{path: file, oid: entry.oid}] : [];
        }).slice(0, MAX_EMBEDDERS);
      } catch {
        return [];
      }
    },
    /**
     * How a link to a repo path the review didn't render resolves on the
     * after side: a file or folder git holds, or no such file, or one git
     * doesn't track or ignores, or one whose capitals differ; or, into a
     * markdown file git holds, a heading `hash` names that isn't there.
     * `known` is what the trees and the review's change list say, with no
     * git process of its own; `checked` adds what only git can tell: that
     * a missing file is untracked or ignored, and the headings of a
     * markdown file. Neither rejects: a lookup that fails is a link that
     * works.
     */
    linkTarget(sides: AssetSides, repoPath: string, hash?: string): {known: Promise<LinkAnswer>; checked: Promise<LinkAnswer>} {
      const works: LinkAnswer = {kind: 'outside'};
      const stages = linkStages(sides, repoPath, hash);
      return {
        known: stages.then((stage) => stage.known, () => works),
        checked: stages.then((stage) => (stage.checked ? stage.checked() : stage.known)).catch(() => works),
      };
    },
    /** How the image resolves on that side. Never throws: a failure is a card. */
    async answer(sides: AssetSides, side: AssetSide, repoPath: string): Promise<Answered> {
      try {
        const located = await locate(sides, side, repoPath);
        if (located.kind === 'refused') return {answer: {kind: 'refused', reason: located.reason, ...(located.hint ? {hint: located.hint} : {})}, identity: identityOf(located)};
        const answer = await load(located);
        return {answer, identity: passing(answer) ? retryIdentity() : identityOf(located)};
      } catch {
        return {answer: unreadable(UNREADABLE.git), identity: retryIdentity()};
      }
    },
    async identity(sides: AssetSides, side: AssetSide, repoPath: string) {
      try {
        return identityOf(await locate(sides, side, repoPath));
      } catch {
        return retryIdentity();
      }
    },
    /**
     * Whether the image shows other content after the review than on the
     * base side, from the ids git and the review name, with no bytes read;
     * and what each side's answer depends on. `basePath` is where the base
     * side has it, when a move took it from there.
     */
    async compare(sides: AssetSides, repoPath: string, basePath = repoPath): Promise<{changed: boolean; base: string; after: string}> {
      try {
        const [base, after] = await Promise.all([locate(sides, 'base', basePath), locate(sides, 'after', repoPath)]);
        return {changed: !sameContent(base, after), base: identityOf(base), after: identityOf(after)};
      } catch {
        // Unknown is no change: a wrong mark is worse than a missing one.
        return {changed: false, base: retryIdentity(), after: retryIdentity()};
      }
    },
  };
}

export type AssetResolver = ReturnType<typeof createAssetResolver>;

/**
 * An image a render looked up, and what its answer depended on; or a link
 * it checked, with the answer it gave as its identity (LATE_IDENTITY when
 * the check ran out of time), so a held fragment can ask each link again.
 */
export type AssetUse = {kind: 'asset'; side: AssetSide; path: string; identity: string}
  | {kind: 'link'; side: 'after'; path: string; hash?: string; identity: string};

/** The identity of a link check's answer: the same answer, the same identity. */
export const linkIdentity = (answer: LinkAnswer) => JSON.stringify(answer);

/** The identity of a lookup that ran out of time: no image has it, so a page that used it renders again. */
export const LATE_IDENTITY = 'late';

/**
 * The image lookups for one page's render. The page's own text is the
 * after side, or for a deleted file the base side; `before` views and
 * removed markers are always the base side. Each lookup is recorded in
 * `uses`, so a held fragment can tell later whether an image it shows
 * changed. Under a render deadline, the lookups share one budget,
 * `budgetMs` from now: past it an image is a card and a change goes
 * unmarked, so a slow git costs cards, never the page.
 */
export function pageLookups(resolver: AssetResolver, sides: AssetSides, deleted: boolean, uses: AssetUse[] = [], {budgetMs}: {budgetMs?: number} = {}) {
  const ends = budgetMs === undefined ? null : Date.now() + budgetMs;
  // Every lookup started, answered in time or not, for `settled`.
  const started: Array<Promise<unknown>> = [];
  const inTime = <T>(work: Promise<T>, late: T) => (started.push(work), ends === null ? work : new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(late), Math.max(0, ends - Date.now()));
    timer.unref?.();
    void work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  }));
  // LATE_IDENTITY is no identity the resolver gives, so a page that showed a
  // late card renders again next time.
  const lookup = (side: AssetSide) => async (repoPath: string) => {
    const {answer, identity} = await inTime(resolver.answer(sides, side, repoPath), {answer: unreadable(UNREADABLE.late), identity: LATE_IDENTITY});
    uses.push({kind: 'asset', side, path: repoPath, identity});
    return answer;
  };
  return {
    asset: lookup(deleted ? 'base' : 'after'),
    baseAsset: lookup('base'),
    // Out of time, a link says what the trees alone tell of it, or, before
    // they answer, nothing at all: no claim without an answer. Either way
    // the page renders again for git's word. Every answer is recorded, so a
    // held fragment asks it again for the next review.
    async linkTarget(repoPath: string, hash?: string): Promise<LinkAnswer> {
      const {known, checked} = resolver.linkTarget(sides, repoPath, hash);
      const answer = await inTime<LinkAnswer | null>(checked, null);
      uses.push({kind: 'link', side: 'after', path: repoPath, ...(hash === undefined ? {} : {hash}), identity: answer ? linkIdentity(answer) : LATE_IDENTITY});
      if (answer) return answer;
      return (await inTime<LinkAnswer | null>(known, null)) ?? {kind: 'unchecked'};
    },
    async assetChanged(repoPath: string, basePath = repoPath) {
      const {changed, base, after} = await inTime(resolver.compare(sides, repoPath, basePath), {changed: false, base: LATE_IDENTITY, after: LATE_IDENTITY});
      uses.push({kind: 'asset', side: 'base', path: basePath, identity: base}, {kind: 'asset', side: 'after', path: repoPath, identity: after});
      return changed;
    },
    /**
     * Settles once every lookup started so far has, the late ones
     * included: their answers are then at hand to a render that asks again.
     */
    settled: async () => {
      await Promise.allSettled(started);
    },
  };
}
