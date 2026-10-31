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

/** `was` lists the base blocks a modified block replaced, for its `before` view. */
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
 * removed block left over becomes a marker where it was. A run that only
 * added lines makes `added` blocks.
 *
 * A table's delimiter row counts as part of its header row, so a table is
 * marked by its rows, the way a list is by its items.
 */
export function markBlocks(after: MarkSide, base: MarkSide, groups: readonly ChangeGroup[]): {marks: Array<BlockMark | null>; removals: Removal[]} {
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

  const removals: Removal[] = [];
  for (const group of groups) {
    if (group.kind === 'added') continue;
    const ops = align(gone.get(group.id) ?? [], fresh.get(group.id) ?? [], (baseIndex, afterIndex) => pairScore(base.blocks[baseIndex]!, after.blocks[afterIndex]!));
    // Removed blocks go before the next block of the run, the way the diff
    // prints `-` lines before `+` lines; with none left, after the run.
    let run: number[] = [];
    const flush = (next: number | undefined) => {
      if (run.length === 0) return;
      const footnote = base.blocks[run[0]!]!.footnote;
      const anchor = next === undefined ? (group.after ? group.after[1] + 1 : group.anchorLine) : after.blocks[next]!.lines[0];
      const target = next === undefined ? afterOwner.get(anchor) : next;
      const point = insertionPoint(after.blocks, target, anchor, footnote);
      removals.push({group, blocks: run, before: point === null ? null : keepOutOfContainer(after.blocks, point, base.blocks, run)});
      run = [];
    };
    for (const op of ops) {
      if (op.base !== undefined && op.after === undefined) {
        run.push(op.base);
        continue;
      }
      flush(op.after);
      if (op.base === undefined) marks[op.after!] = {kind: 'added', groups: [group.id], was: []};
      else marks[op.after!] = {kind: 'modified', groups: [group.id], was: [op.base]};
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

function words(text: string) {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
}

// Blocks of one kind pair, the closer their wording the better; others never.
function pairScore(baseBlock: MarkableBlock, afterBlock: MarkableBlock) {
  if (family(baseBlock) !== family(afterBlock)) return null;
  const left = words(baseBlock.text);
  const right = words(afterBlock.text);
  const shared = [...left].filter((word) => right.has(word)).length;
  const union = left.size + right.size - shared;
  return 1 + (union === 0 ? 1 : shared / union);
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
