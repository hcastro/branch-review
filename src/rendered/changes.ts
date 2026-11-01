import type {ReviewFile} from '../review/model.js';

// What changed in a markdown file, read from the hunks git already printed,
// and which rendered blocks that touches. The page must never mark a block
// the diff didn't touch, so every rule here errs toward "modified" or no
// mark rather than a confident wrong one.

/**
 * One run of changed lines in a hunk. A `+` run alone is `added`, `-` then
 * `+` is `modified`, a `-` run alone is `removed`. Line numbers are 1-based
 * and inclusive. `anchorLine` is the after-side line the change sits at: its
 * first line, or for a removal the line that now follows the removed text.
 */
export type ChangeGroup = {
  id: string;
  kind: 'added' | 'modified' | 'removed';
  after: readonly [number, number] | null;
  base: readonly [number, number] | null;
  anchorLine: number;
  /** The base side's text for this run, without diff markers. */
  removedLines: readonly string[];
};

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The change runs of a file's hunks. A new or deleted file has none: its page
 * carries a banner, since a bar on every block would say nothing.
 */
export function changeGroups(file: Pick<ReviewFile, 'status' | 'blocks'>): ChangeGroup[] {
  if (file.status === 'added' || file.status === 'untracked' || file.status === 'deleted') return [];

  const groups: ChangeGroup[] = [];
  for (const block of file.blocks) {
    const lines = block.rawDiff.split('\n');
    const header = HUNK_HEADER.exec(lines[0] ?? '');
    if (!header) continue;
    // A side with no lines names the line before the hunk, so its first
    // line is one further on.
    let baseLine = Number(header[1]) + (header[2] === '0' ? 1 : 0);
    let afterLine = Number(header[3]) + (header[4] === '0' ? 1 : 0);
    // Typed by assertion: the closure below resets both, which TypeScript's
    // narrowing can't follow.
    let removed = null as {start: number; lines: string[]} | null;
    let added = null as {start: number; end: number} | null;

    const flush = () => {
      if (!removed && !added) return;
      const id = `g${groups.length}`;
      const base = removed ? [removed.start, removed.start + removed.lines.length - 1] as const : null;
      const removedLines = removed?.lines ?? [];
      if (added) {
        groups.push({id, kind: removed ? 'modified' : 'added', after: [added.start, added.end], base, anchorLine: added.start, removedLines});
      } else {
        groups.push({id, kind: 'removed', after: null, base, anchorLine: afterLine, removedLines});
      }
      removed = null;
      added = null;
    };

    for (const line of lines.slice(1)) {
      const marker = line[0];
      if (marker === '-') {
        // Git prints a run's removals before its additions; a removal after
        // an addition starts a new run.
        if (added) flush();
        removed ??= {start: baseLine, lines: []};
        removed.lines.push(line.slice(1));
        baseLine += 1;
      } else if (marker === '+') {
        if (added) added.end = afterLine;
        else added = {start: afterLine, end: afterLine};
        afterLine += 1;
      } else if (marker === '\\') {
        continue;
      } else if (marker === ' ') {
        flush();
        baseLine += 1;
        afterLine += 1;
      }
    }
    flush();
  }
  return groups;
}

/**
 * The base side's text, rebuilt from the after side and the change runs:
 * each run's after lines swapped back for the lines it replaced. The hunks
 * hold every changed line, so this is the base file line for line, and a
 * base block's source and positions can be read from it without asking git.
 */
export function baseText(afterSource: string, groups: readonly ChangeGroup[]): string {
  const after = afterSource.split('\n');
  const out: string[] = [];
  let next = 0;
  for (const group of groups) {
    const start = (group.after ? group.after[0] : group.anchorLine) - 1;
    out.push(...after.slice(next, start), ...group.removedLines);
    next = group.after ? group.after[1] : start;
  }
  out.push(...after.slice(next));
  return out.join('\n');
}

/**
 * A rendered block the marks can land on: a top-level block, a list item or
 * a table row, in document order. `parent` is the nearest enclosing block in
 * the same list, so a child always comes after its parent. `footnote` is a
 * footnote definition's item, which renders at the end of the page wherever
 * its source sits.
 */
export type MarkableBlock = {
  lines: readonly [number, number];
  parent: number | null;
  tag: string;
  /** The block's source text, for pairing an edited block with its old self. */
  text: string;
  footnote: boolean;
};

/** One side of the diff: its blocks and its source lines. */
export type MarkSide = {blocks: readonly MarkableBlock[]; lines: readonly string[]};

/**
 * `was` lists the base blocks a modified block replaced, for its `before`
 * view. `groups` is empty for a block whose text didn't change.
 */
export type BlockMark = {kind: 'added' | 'modified'; groups: string[]; was: number[]};

/**
 * Base blocks that are gone, shown as one marker before after block
 * `before`, or at the end of the page's body when null.
 */
export type Removal = {group: ChangeGroup; before: number | null; blocks: number[]};

/**
 * Which blocks each change touches, read from both sides. A line belongs to
 * the deepest block that spans it, and only non-blank lines count, so blank
 * lines alone never mark anything.
 *
 * An after block that kept a line with words on it existed before: a change
 * in it, or in the base block that line came from, makes it `modified`, and
 * that base block is its `before` view. A kept code fence or table rule
 * doesn't count, since a new block can reuse the old one's closing fence.
 *
 * A block made only of changed lines is new text. When the run that made it
 * also took text away, the run's new blocks and its removed blocks are
 * paired in order by kind and wording, the way a reader would match them: a
 * pair is one `modified` block, a new block left over is `added`, and a
 * removed block left over becomes a marker where it was. Blocks pair only
 * when their wording mostly matches, or one holds the other's whole
 * wording, as a sentence extended in place does, so a new block is never
 * shown as an edit of unrelated old text. A run that only added lines
 * makes `added` blocks.
 *
 * An after block whose text didn't change is `modified` when one of its
 * lines shows an image whose content changed (`imageLines`), with its base
 * block as the `before` view.
 *
 * A table's delimiter row counts as part of its header row, so a table is
 * marked by its rows, the way a list is by its items.
 */
export function markBlocks(after: MarkSide, base: MarkSide, groups: readonly ChangeGroup[], imageLines: ReadonlySet<number> = new Set()): {marks: Array<BlockMark | null>; removals: Removal[]} {
  after = {...after, blocks: withDelimiterRows(after.blocks)};
  base = {...base, blocks: withDelimiterRows(base.blocks)};
  const afterOwner = owners(after.blocks);
  const baseOwner = owners(base.blocks);
  const afterGroup = lineGroups(groups, (group) => group.after);
  const baseGroup = lineGroups(groups, (group) => group.base);
  const toBase = unchangedLines(groups, Math.max(0, ...after.blocks.map((block) => block.lines[1])));

  const marks: Array<BlockMark | null> = after.blocks.map(() => null);
  const counterparts = new Set<number>();
  // New after blocks and gone base blocks, per run that both added and removed text.
  const fresh = new Map<string, number[]>();
  const gone = new Map<string, number[]>();

  after.blocks.forEach((block, index) => {
    const owned = ownedLines(block, index, afterOwner, after.lines);
    if (owned.length === 0) return;
    const changed = owned.filter((line) => afterGroup.has(line));
    const kept = owned.filter((line) => !afterGroup.has(line));
    const anchors = changed.length === 0 ? kept : kept.filter((line) => hasWords(after.lines[line - 1]));

    if (anchors.length > 0) {
      const was = [...new Set(anchors.map((line) => baseOwner.get(toBase.get(line)!)).filter((owner): owner is number => owner !== undefined))].sort((a, b) => a - b);
      const touching = new Set(changed.map((line) => afterGroup.get(line)!.id));
      for (const baseIndex of was) {
        counterparts.add(baseIndex);
        for (const line of ownedLines(base.blocks[baseIndex]!, baseIndex, baseOwner, base.lines)) {
          const group = baseGroup.get(line);
          if (group) touching.add(group.id);
        }
      }
      if (touching.size > 0) marks[index] = {kind: 'modified', groups: [...touching], was};
      else if (owned.some((line) => imageLines.has(line))) marks[index] = {kind: 'modified', groups: [], was};
      return;
    }

    const touching = [...new Set(changed.map((line) => afterGroup.get(line)!))];
    const mixed = touching.find((group) => group.kind === 'modified');
    if (mixed) push(fresh, mixed.id, index);
    else marks[index] = {kind: 'added', groups: touching.map((group) => group.id), was: []};
  });

  base.blocks.forEach((block, index) => {
    if (counterparts.has(index)) return;
    const owned = ownedLines(block, index, baseOwner, base.lines);
    const changed = owned.filter((line) => baseGroup.has(line));
    // A base block that kept a line with words still exists on the after
    // side, under another block's ownership; it was never removed.
    if (changed.length === 0 || owned.some((line) => !baseGroup.has(line) && hasWords(base.lines[line - 1]))) return;
    push(gone, baseGroup.get(changed[0]!)!.id, index);
  });

  // Runs the diff split only at blank lines are one change: git lines up a
  // rewritten section by its blank lines, so a heading that stayed can land
  // in one run while its old copy sits in the next. Their blocks pair as one.
  const blankBetween = (left: ChangeGroup, right: ChangeGroup) => {
    const from = left.after ? left.after[1] + 1 : left.anchorLine;
    const to = right.after ? right.after[0] - 1 : right.anchorLine - 1;
    for (let line = from; line <= to; line += 1) if ((after.lines[line - 1] ?? '').trim() !== '') return false;
    return true;
  };
  const regions: ChangeGroup[][] = [];
  for (const group of groups) {
    if (group.kind === 'added') continue;
    const region = regions.at(-1);
    if (region && blankBetween(region.at(-1)!, group)) region.push(group);
    else regions.push([group]);
  }
  const freshGroup = new Map([...fresh].flatMap(([id, indexes]) => indexes.map((index) => [index, id] as const)));
  const goneGroup = new Map(groups.flatMap((group) => (gone.get(group.id) ?? []).map((index) => [index, group] as const)));

  const removals: Removal[] = [];
  // What each block of a run looks like, read once, not once per pair.
  const baseLikeness = new Map<number, BlockLikeness>();
  const afterLikeness = new Map<number, BlockLikeness>();
  const numbering = new Map<string, number>();
  for (const region of regions) {
    const last = region.at(-1)!;
    for (const index of region.flatMap((group) => gone.get(group.id) ?? [])) if (!baseLikeness.has(index)) baseLikeness.set(index, blockLikeness(base.blocks[index]!, numbering));
    for (const index of region.flatMap((group) => fresh.get(group.id) ?? [])) if (!afterLikeness.has(index)) afterLikeness.set(index, blockLikeness(after.blocks[index]!, numbering));
    const ops = align(
      region.flatMap((group) => gone.get(group.id) ?? []),
      region.flatMap((group) => fresh.get(group.id) ?? []),
      (baseIndex, afterIndex) => pairScore(base.blocks[baseIndex]!, after.blocks[afterIndex]!, baseLikeness.get(baseIndex)!, afterLikeness.get(afterIndex)!),
    );
    // Removed blocks go before the next block of the run, the way the diff
    // prints `-` lines before `+` lines; with none left, after the run.
    let run: number[] = [];
    const flush = (next: number | undefined) => {
      if (run.length === 0) return;
      const footnote = base.blocks[run[0]!]!.footnote;
      const anchor = next === undefined ? (last.after ? last.after[1] + 1 : last.anchorLine) : after.blocks[next]!.lines[0];
      const target = next === undefined ? afterOwner.get(anchor) : next;
      const point = insertionPoint(after.blocks, target, anchor, footnote);
      removals.push({group: goneGroup.get(run[0]!)!, blocks: run, before: point === null ? null : keepOutOfContainer(after.blocks, point, base.blocks, run)});
      run = [];
    };
    for (const op of ops) {
      if (op.base !== undefined && op.after === undefined) {
        run.push(op.base);
        continue;
      }
      flush(op.after);
      const group = freshGroup.get(op.after!)!;
      if (op.base === undefined) marks[op.after!] = {kind: 'added', groups: [group], was: []};
      else marks[op.after!] = {kind: 'modified', groups: [...new Set([group, goneGroup.get(op.base)!.id])], was: [op.base]};
    }
    flush(undefined);
  }

  return {marks, removals};
}

// The blocks with each table's header row widened over the delimiter row
// under it, the one line the table would otherwise own. A table's header
// row is its first block.
function withDelimiterRows(blocks: readonly MarkableBlock[]): MarkableBlock[] {
  return blocks.map((block, index) => (isHeaderRow(blocks, index) ? {...block, lines: [block.lines[0], block.lines[1] + 1]} : block));
}

function isHeaderRow(blocks: readonly MarkableBlock[], index: number) {
  const parent = blocks[index]!.parent;
  return parent !== null && parent === index - 1 && blocks[parent]!.tag === 'table';
}

function owners(blocks: readonly MarkableBlock[]) {
  const owner = new Map<number, number>();
  blocks.forEach((block, index) => {
    for (let line = block.lines[0]; line <= block.lines[1]; line += 1) owner.set(line, index);
  });
  return owner;
}

function ownedLines(block: MarkableBlock, index: number, owner: Map<number, number>, source: readonly string[]) {
  const lines: number[] = [];
  for (let line = block.lines[0]; line <= block.lines[1]; line += 1) {
    if (owner.get(line) === index && (source[line - 1] ?? '').trim() !== '') lines.push(line);
  }
  return lines;
}

function hasWords(line: string | undefined) {
  return /[\p{L}\p{N}]/u.test(line ?? '');
}

function lineGroups(groups: readonly ChangeGroup[], range: (group: ChangeGroup) => readonly [number, number] | null) {
  const byLine = new Map<number, ChangeGroup>();
  for (const group of groups) {
    const lines = range(group);
    if (lines) for (let line = lines[0]; line <= lines[1]; line += 1) byLine.set(line, group);
  }
  return byLine;
}

// Each unchanged after line's line number on the base side.
function unchangedLines(groups: readonly ChangeGroup[], lastLine: number) {
  const toBase = new Map<number, number>();
  let afterLine = 1;
  let baseLine = 1;
  const copyUntil = (end: number) => {
    for (; afterLine < end; afterLine += 1, baseLine += 1) toBase.set(afterLine, baseLine);
  };
  for (const group of groups) {
    copyUntil(group.after ? group.after[0] : group.anchorLine);
    if (group.after) afterLine = group.after[1] + 1;
    if (group.base) baseLine = group.base[1] + 1;
  }
  copyUntil(lastLine + 1);
  return toBase;
}

function push(map: Map<string, number[]>, key: string, value: number) {
  map.set(key, [...(map.get(key) ?? []), value]);
}

// Headings of any level, and either kind of list, can stand in for each other.
function family(block: MarkableBlock) {
  const tag = /^h[1-6]$/.test(block.tag) ? 'h' : block.tag === 'ol' ? 'ul' : block.tag;
  return block.footnote ? `footnote ${tag}` : tag;
}

// An image, `![alt](src)`, and a link's destination, `](dest)`: neither is
// part of a block's wording. Read in one pass each, as the regular
// expressions /!\[[^\]]*\]\([^)]*\)/g, /\]\([^)]*\)/g and
// /!\[[^\]]*\]\(\s*<?([^)>\s]*)/g match, without their cost on a block of
// `![` and no `]`, which a regular expression scans to the end from every
// start. Each takes the first `]` after `![` and the first `)` after `(`,
// so a start that fails makes every start before that `]` fail too, and
// one with no closer left ends the search.

// The text with each image as one space.
function withoutImages(text: string): string {
  let out = '';
  let from = 0;
  for (let at = text.indexOf('![', from); at >= 0; at = text.indexOf('![', from)) {
    const close = text.indexOf(']', at + 2);
    if (close < 0) break;
    if (text[close + 1] !== '(') {
      out += text.slice(from, close + 1);
      from = close + 1;
      continue;
    }
    const end = text.indexOf(')', close + 2);
    if (end < 0) break;
    out += `${text.slice(from, at)} `;
    from = end + 1;
  }
  return out + text.slice(from);
}

// The text with each link destination cut down to the `]` before it.
function withoutDestinations(text: string): string {
  let out = '';
  let from = 0;
  for (let at = text.indexOf('](', from); at >= 0; at = text.indexOf('](', from)) {
    const end = text.indexOf(')', at + 2);
    if (end < 0) break;
    out += `${text.slice(from, at)}]`;
    from = end + 1;
  }
  return out + text.slice(from);
}

const SPACE = /\s/;

// Each image's source as written, without a `<` before it.
function imageSources(text: string): string[] {
  const sources: string[] = [];
  let from = 0;
  for (let at = text.indexOf('![', from); at >= 0; at = text.indexOf('![', from)) {
    const close = text.indexOf(']', at + 2);
    if (close < 0) break;
    if (text[close + 1] !== '(') {
      from = close + 1;
      continue;
    }
    let start = close + 2;
    while (start < text.length && SPACE.test(text[start]!)) start += 1;
    if (text[start] === '<') start += 1;
    let end = start;
    while (end < text.length && text[end] !== ')' && text[end] !== '>' && !SPACE.test(text[end]!)) end += 1;
    sources.push(text.slice(start, end));
    from = end;
  }
  return sources;
}

// What a block shows, for telling an edit from new text: the letter pairs
// of its words, so `Theme` and `Theming` are close and unrelated sentences
// are far apart. A block that is only images shows its images, so it
// compares by their sources.
export function likeness(text: string): {kind: 'words' | 'images'; parts: Set<string>; words: string[]} {
  const prose = withoutDestinations(withoutImages(text)).toLowerCase();
  const words = prose.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return {kind: 'images', parts: new Set(imageSources(text)), words};
  const parts = new Set<string>();
  for (const word of words) {
    const letters = [...word];
    if (letters.length === 1) parts.add(word);
    for (let at = 0; at + 1 < letters.length; at += 1) parts.add(letters[at]! + letters[at + 1]!);
  }
  return {kind: 'words', parts, words};
}

// A block as pairing reads it: its trimmed text, its row key, its
// likeness and the set of its words.
// `codes`: its parts as numbers, sorted, from one numbering for the whole
// pairing, so two blocks' shared parts are counted in one merge.
type BlockLikeness = {text: string; rowKey: string; likeness: ReturnType<typeof likeness>; wordSet: ReadonlySet<string>; codes: Int32Array};

function blockLikeness(block: MarkableBlock, numbering: Map<string, number>): BlockLikeness {
  const look = likeness(block.text);
  const codes = Int32Array.from(look.parts, (part) => {
    let code = numbering.get(part);
    if (code === undefined) {
      code = numbering.size;
      numbering.set(part, code);
    }
    return code;
  }).sort();
  return {text: block.text.trim(), rowKey: block.tag === 'tr' ? rowKey(block.text) : '', likeness: look, wordSet: new Set(look.words), codes};
}

// How many parts two blocks share.
function sharedParts(left: Int32Array, right: Int32Array) {
  let shared = 0;
  for (let at = 0, other = 0; at < left.length && other < right.length;) {
    if (left[at] === right[other]) {
      shared += 1;
      at += 1;
      other += 1;
    } else if (left[at]! < right[other]!) {
      at += 1;
    } else {
      other += 1;
    }
  }
  return shared;
}

// Whether the shorter wording can run inside the longer at all: its first
// and last words are among the longer's. Most pairs of a rewrite fail here,
// before holds() reads them word by word.
function mayHold(left: BlockLikeness, right: BlockLikeness) {
  const [short, long] = left.likeness.words.length <= right.likeness.words.length ? [left, right] : [right, left];
  const words = short.likeness.words;
  return words.length > 0 && long.wordSet.has(words[0]!) && long.wordSet.has(words.at(-1)!);
}

// Below this share of parts in common, two blocks are different text, not
// an edit of one another.
const MIN_LIKENESS = 0.3;
// The fewest words a block's whole wording needs for it to pair with a
// block that holds that wording and more: fewer could turn up anywhere.
const MIN_HELD_WORDS = 3;

// Whether the shorter wording runs, word for word and in order, inside the
// longer: a sentence extended or cut down in place, however much it grew.
// Knuth-Morris-Pratt over words, so a long paragraph of repeated words
// costs a pass over each side, never their product.
function holds(left: readonly string[], right: readonly string[]) {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  if (short.length < MIN_HELD_WORDS) return false;
  // How far each prefix of `short` overlaps itself, to resume a match without stepping back.
  const overlap = new Int32Array(short.length);
  for (let at = 1, run = 0; at < short.length; at += 1) {
    while (run > 0 && short[at] !== short[run]) run = overlap[run - 1]!;
    if (short[at] === short[run]) run += 1;
    overlap[at] = run;
  }
  for (let at = 0, run = 0; at < long.length; at += 1) {
    while (run > 0 && long[at] !== short[run]) run = overlap[run - 1]!;
    if (long[at] === short[run]) run += 1;
    if (run === short.length) return true;
  }
  return false;
}

// A table row's key: its first cell, which names what the row is about.
function rowKey(text: string) {
  return text.trim().replace(/^\|/, '').split(/(?<!\\)\|/)[0]!.trim().toLowerCase();
}

// Blocks of one kind pair when they look alike, the closer the better, and a
// block whose text is the same on both sides pairs ahead of any other;
// blocks of different kinds never pair. Table rows with the same key pair
// ahead of rows that only look alike: an edited row keeps its first cell,
// and a new row can share most of its other cells with it. Other blocks
// whose old wording runs whole and in order inside the new one pair ahead
// of blocks that only share letters with it: `A nested tip` was extended
// into `A nested tip that changed`, not into `A new nested tip`.
function pairScore(baseBlock: MarkableBlock, afterBlock: MarkableBlock, baseLook: BlockLikeness, afterLook: BlockLikeness) {
  if (family(baseBlock) !== family(afterBlock)) return null;
  if (baseLook.text === afterLook.text) return 3;
  const left = baseLook.likeness;
  const right = afterLook.likeness;
  if (left.kind !== right.kind) return null;
  const shared = sharedParts(baseLook.codes, afterLook.codes);
  const total = left.parts.size + right.parts.size;
  const similarity = total === 0 ? 1 : (2 * shared) / total;
  const held = left.kind === 'words' && mayHold(baseLook, afterLook) && holds(left.words, right.words);
  if (baseBlock.tag === 'tr' && baseLook.rowKey !== '' && baseLook.rowKey === afterLook.rowKey) return 2 + similarity / 2;
  if (baseBlock.tag !== 'tr' && held) return 2 + similarity / 2;
  if (similarity >= MIN_LIKENESS) return 1 + similarity;
  return held ? 1 + MIN_LIKENESS : null;
}

type AlignOp = {base?: number; after?: number};

// Past this many cells the pairing table costs more than it's worth, and
// every block of the run reads as removed or added, which is still true.
const ALIGN_CELLS = 250_000;

/**
 * The best in-order pairing of a run's removed and new blocks, as the
 * sequence a reader meets them in: pairs, removed blocks and new blocks,
 * with removed blocks first where the order is free.
 */
function align(gone: readonly number[], fresh: readonly number[], score: (base: number, after: number) => number | null): AlignOp[] {
  const rows = gone.length;
  const cols = fresh.length;
  if (rows * cols > ALIGN_CELLS) return [...gone.map((base) => ({base})), ...fresh.map((after) => ({after}))];
  const best = Array.from({length: rows + 1}, () => new Float64Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      const pair = score(gone[i]!, fresh[j]!);
      best[i]![j] = Math.max(best[i + 1]![j]!, best[i]![j + 1]!, pair === null ? -1 : pair + best[i + 1]![j + 1]!);
    }
  }
  const ops: AlignOp[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < cols) {
    const pair = i < rows && j < cols ? score(gone[i]!, fresh[j]!) : null;
    if (pair !== null && best[i]![j] === pair + best[i + 1]![j + 1]!) {
      ops.push({base: gone[i]!, after: fresh[j]!});
      i += 1;
      j += 1;
    } else if (i < rows && (j === cols || best[i]![j] === best[i + 1]![j])) {
      ops.push({base: gone[i]!});
      i += 1;
    } else {
      ops.push({after: fresh[j]!});
      j += 1;
    }
  }
  return ops;
}

/**
 * Where a removed run's marker goes, given the after block found at its
 * anchor line (or none there): the outermost block that starts at the anchor
 * without spanning the line before it, so a removed list item lands between
 * items of that list and a removed paragraph before a list lands before the
 * list. With no block at the anchor (a blank line, or past the end), the
 * next top-level block. Footnote items render at the page's end whatever
 * their source line, so only a removed footnote lands among them; anything
 * else that would land there goes to the end of the body instead (null).
 */
function insertionPoint(blocks: readonly MarkableBlock[], found: number | undefined, anchor: number, footnote: boolean): number | null {
  if (found === undefined) {
    const following = blocks.findIndex((block) => block.parent === null && block.lines[0] > anchor && block.footnote === footnote);
    return following < 0 ? null : following;
  }
  let index = found;
  for (let parent = blocks[index]!.parent; parent !== null && blocks[parent]!.lines[0] >= anchor; parent = blocks[parent]!.parent) {
    index = parent;
  }
  if (blocks[index]!.footnote !== footnote) {
    const following = blocks.findIndex((block, at) => at > index && block.parent === null && block.footnote === footnote);
    return following < 0 ? null : following;
  }
  return index;
}

/**
 * A removed run goes inside a list or a table, before item or row `point`,
 * only when it was items or rows itself, and never a whole table, which
 * removes its header row too. Anything else goes after the list or table
 * the point sits in, before the next top-level block or at the end of the
 * body (null): the point is a block inside the container, so the removed
 * lines sat past the container's start.
 */
function keepOutOfContainer(blocks: readonly MarkableBlock[], point: number, baseBlocks: readonly MarkableBlock[], run: readonly number[]): number | null {
  const target = blocks[point]!;
  if (target.parent === null) return point;
  if (run.every((index) => baseBlocks[index]!.tag === target.tag && !isHeaderRow(baseBlocks, index))) return point;
  let top = point;
  while (blocks[top]!.parent !== null) top = blocks[top]!.parent!;
  const following = blocks.findIndex((block, at) => at > top && block.parent === null && block.footnote === blocks[top]!.footnote);
  return following < 0 ? null : following;
}
