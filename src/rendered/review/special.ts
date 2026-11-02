import type {FileStatus} from '../../git.js';
import {sizeText} from '../image.js';

// A card with no diff to show draws one line in its place, in GitHub's
// words: a binary or empty file, a rename or a mode change with nothing
// else, a submodule, a Git LFS pointer, a diff the page can't carry, or
// one git couldn't print. The UI process reads which from the review's
// patch (review/request.ts), the worker adds the size limit and checks a
// pointer against its whole side (review/build.ts), and the page and the
// export's text report say it with these words alone.

export type CardSpecial =
  | {kind: 'binary'}
  | {kind: 'empty'}
  | {kind: 'renamed'}
  | {kind: 'mode'; from: string; to: string}
  // The submodule's commits on each side, a side it is missing from left out.
  | {kind: 'submodule'; before?: string; after?: string}
  // The size the pointer says the stored file is, when it says one.
  | {kind: 'lfs'; bytes?: number}
  // A folded diff the page can't carry, by its own size: `tooLarge` is past
  // the page's whole budget alone, and `noRoom` would fit it but for the
  // diffs before it. A deleted file's says it was deleted, as its fold does.
  | {kind: 'tooLarge'; bytes: number}
  | {kind: 'noRoom'; bytes: number}
  | {kind: 'deleted'}
  | {kind: 'unreadable'; reason: string}
  | {kind: 'none'};

/** A piece of a card's line: words, or a name or commit drawn as code. */
export type SpecialPart = string | {code: string};

const short = (commit: string) => ({code: commit.slice(0, 7)});

/**
 * What the card says: `words`, the line itself, and `note`, what follows it
 * after a dot, such as where a renamed file was.
 */
export function specialParts(special: CardSpecial, file: {status: FileStatus; oldPath?: string}): {words: SpecialPart[]; note?: SpecialPart[]} {
  switch (special.kind) {
    case 'binary':
      return {words: ['Binary file not shown.']};
    case 'empty':
      return {words: [file.status === 'added' || file.status === 'untracked' ? 'Empty file added.' : file.status === 'deleted' ? 'Empty file deleted.' : 'Empty file.']};
    case 'renamed':
      return {words: ['File renamed without changes.'], ...(file.oldPath ? {note: ['renamed from ', {code: file.oldPath}]} : {})};
    case 'mode':
      return {words: [`File mode changed from ${special.from} to ${special.to}.`]};
    case 'submodule': {
      const {before, after} = special;
      if (before && after) return {words: ['Submodule updated from ', short(before), ' to ', short(after), '.']};
      if (after) return {words: ['Submodule added at ', short(after), '.']};
      return {words: ['Submodule removed', ...(before ? [', it was at ', short(before)] : []), '.']};
    }
    case 'lfs':
      return {words: ['Git LFS file not shown.'], ...(special.bytes !== undefined ? {note: [sizeText(special.bytes)]} : {})};
    case 'tooLarge':
      return {words: ['This diff is too large to show here. Open the file to see it.'], note: [sizeText(special.bytes)]};
    case 'noRoom':
      return {words: ['This page has no room left for this diff. Open the file to see it.'], note: [sizeText(special.bytes)]};
    case 'deleted':
      return {words: ['This file was deleted.']};
    case 'unreadable':
      return {words: [`This file's diff couldn't be read: ${special.reason}`]};
    case 'none':
      return {words: ['No changes to show.']};
  }
}

/** The card's line as plain text, its note left out. */
export function specialText(special: CardSpecial, file: {status: FileStatus; oldPath?: string}) {
  return specialParts(special, file).words.map((part) => (typeof part === 'string' ? part : part.code)).join('');
}

/**
 * Whether the card's line counts are lines of the file's text: only for a
 * diff the page can't carry. A submodule's and a Git LFS pointer's lines
 * are git's own, and the other kinds have none.
 */
export function countsText(special: CardSpecial) {
  return special.kind === 'tooLarge' || special.kind === 'noRoom' || special.kind === 'deleted';
}

// A Git LFS pointer, as the spec defines one: `key value` lines, the
// version first and the rest sorted by key, an `oid` and a `size` among
// them, under 1024 bytes in all.
const LFS_VERSION = 'version https://git-lfs.github.com/spec/v1';
const LFS_LINE = /^(ext-\d+-[a-z0-9]+|oid|size) (\S+)$/;
const LFS_VALUES: Record<string, RegExp> = {oid: /^sha256:[0-9a-f]{64}$/, size: /^\d{1,15}$/};

/** The size of the file a pointer's lines stand for, or undefined when they are no pointer. */
export function lfsPointerSize(lines: readonly string[]): number | undefined {
  if (lines[0] !== LFS_VERSION || Buffer.byteLength(`${lines.join('\n')}\n`) >= 1024) return undefined;
  const values = new Map<string, string>();
  let previous = '';
  for (const line of lines.slice(1)) {
    const [, key, value] = LFS_LINE.exec(line) ?? [];
    if (!key || key <= previous || !(LFS_VALUES[key]?.test(value!) ?? true)) return undefined;
    previous = key;
    values.set(key, value!);
  }
  return values.has('oid') && values.has('size') ? Number(values.get('size')) : undefined;
}
