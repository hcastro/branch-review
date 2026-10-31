import fs from 'node:fs';
import path from 'node:path';
import {
  FileTooLargeError,
  gitBlobId,
  localBlobOperation,
  matchingBlobId,
  objectFormatOperation,
  readWorktreeBytes,
  runOperationAsync,
  type DiffRange,
  type ObjectFormat,
} from '../git.js';
import {patchObjectIds} from '../media/classify.js';
import {createLru} from '../media/lru.js';
import {isFormat, magicFormat, sniffImage} from '../media/worker/sniff.js';
import type {ReviewModel} from '../review/model.js';
import type {AssetAnswer, RefusedReason} from './markdown.js';
import {createTreeReader, type RunOperation, type TreeIndex} from './tree.js';

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

/**
 * A file the work tree review changed, from its patch: the id of its new
 * content and its mode, null when it's gone, or `unreadable` when the
 * review couldn't read its diff. A pure rename names no id; its content is
 * what `from` holds at the base. `untracked`: not part of a push yet.
 */
export type WorktreeChange = {
  path: string;
  id: string | null;
  mode: 'regular' | 'symlink' | 'submodule' | 'unreadable' | null;
  from?: string;
  untracked?: true;
};

/**
 * The two sides of a review, as the asset rule reads them. `base` is a ref
 * (`main...feature` names their merge base, as the diff does). The after
 * side is a ref, or the work tree: there a file the review changed reads
 * from disk under the id its diff named, and every other file is as `base`
 * holds it, which is what the diff found on disk. `epoch` names the review,
 * so answers about the work tree are asked again for the next one.
 */
export type AssetSides = {base: string | null; after: {tree: string} | {worktree: WorktreeChange[]}; epoch: number};

export type AssetSide = 'base' | 'after';

// The mode git printed for a patch's new side, when it is a link.
const LINK_AFTER = /^(?:new file mode|new mode|index [0-9a-f]+\.\.[0-9a-f]+) (120000|160000)$/m;
// Where a patch's header ends: its first hunk, or its binary content.
const PATCH_BODY = /^(?:@@ |GIT binary patch$|Binary files )/m;

/** The asset sides of a review. Pure: reads only the patches. */
export function reviewAssetSides(review: Pick<ReviewModel, 'files'>, range: Pick<DiffRange, 'diffArg' | 'branch' | 'includeWorktree'>, epoch: number): AssetSides {
  if (!range.includeWorktree) return {base: range.diffArg, after: {tree: range.branch}, epoch};
  const changes: WorktreeChange[] = [];
  for (const file of review.files) {
    // A name that isn't UTF-8 names no file a link can reach.
    if (file.pathError) continue;
    if (file.oldPath) changes.push({path: file.oldPath, id: null, mode: null});
    if (file.status === 'deleted') {
      changes.push({path: file.path, id: null, mode: null});
      continue;
    }
    // A diff that failed to load, for a file nobody can read, has no patch.
    const start = file.rawDiff.lastIndexOf('diff --git ');
    if (start < 0) {
      changes.push({path: file.path, id: null, mode: 'unreadable'});
      continue;
    }
    // A file that changed type prints two patches; the last is its new side.
    // Its id and mode are in the header, so the hunks are never searched.
    const patch = file.rawDiff.slice(start);
    const body = patch.search(PATCH_BODY);
    const header = body < 0 ? patch : patch.slice(0, body);
    const id = patchObjectIds(header)?.after ?? null;
    const link = LINK_AFTER.exec(header)?.[1];
    if (link) changes.push({path: file.path, id, mode: link === '160000' ? 'submodule' : 'symlink'});
    else {
      changes.push({
        path: file.path,
        id,
        mode: 'regular',
        ...(id === null && file.oldPath ? {from: file.oldPath} : {}),
        ...(file.status === 'untracked' ? {untracked: true as const} : {}),
      });
    }
  }
  return {base: range.diffArg, after: {worktree: changes}, epoch};
}

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

export function createAssetResolver({cwd, run = runOperationAsync}: {cwd: string; run?: RunOperation}) {
  const trees = createTreeReader({cwd, run});
  const verified = createLru<Verified>(CACHE_BYTES, (entry) => entry.bytes.byteLength);
  const limit = createLimiter(MAX_READS);
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
  // may read or a git that failed, is tried again next time.
  const passing = (answer: AssetAnswer) => answer.kind === 'refused' && answer.reason === 'unreadable' && (answer.hint === UNREADABLE.file || answer.hint === UNREADABLE.git);

  return {
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

/** An image a render looked up, and what its answer depended on. */
export type AssetUse = {side: AssetSide; path: string; identity: string};

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
  const inTime = <T>(work: Promise<T>, late: T) => (ends === null ? work : new Promise<T>((resolve) => {
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
    uses.push({side, path: repoPath, identity});
    return answer;
  };
  return {
    asset: lookup(deleted ? 'base' : 'after'),
    baseAsset: lookup('base'),
    async assetChanged(repoPath: string, basePath = repoPath) {
      const {changed, base, after} = await inTime(resolver.compare(sides, repoPath, basePath), {changed: false, base: LATE_IDENTITY, after: LATE_IDENTITY});
      uses.push({side: 'base', path: basePath, identity: base}, {side: 'after', path: repoPath, identity: after});
      return changed;
    },
  };
}
