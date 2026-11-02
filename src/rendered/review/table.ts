import {escapeText, firstLine, type CardDiff, type DrawnLine} from './diff.js';
import {icon} from './icons.js';

// A card's source diff as a table, unified or split, with the unchanged
// lines between its hunks folded into expandable gaps. Pure, with no Node
// imports: the page draws its first, unified, table with it, and the page
// script draws every table after that, so the two never disagree.

/** How many lines one click reveals, next to the hunk it opens toward. */
export const EXPAND_STEP = 5;

/**
 * Unchanged lines of the reviewed side that no hunk shows, `from` to `to`
 * (empty when `to < from`), whose base side number is theirs plus `delta`.
 * One before each hunk, and a trailing one after the last when the file's
 * length is known.
 */
export type Gap = {from: number; to: number; delta: number; trailing: boolean};

export function gapsOf(card: CardDiff): Gap[] {
  const gaps: Gap[] = [];
  let newEnd = 0;
  let oldEnd = 0;
  for (const hunk of card.hunks) {
    const newFirst = firstLine(hunk.newStart, hunk.newLines);
    const oldFirst = firstLine(hunk.oldStart, hunk.oldLines);
    gaps.push({from: newEnd + 1, to: newFirst - 1, delta: oldFirst - newFirst, trailing: false});
    newEnd = newFirst + hunk.newLines - 1;
    oldEnd = oldFirst + hunk.oldLines - 1;
  }
  const total = card.total ?? card.context?.length;
  if (total !== undefined && card.hunks.length > 0) gaps.push({from: newEnd + 1, to: total, delta: oldEnd - newEnd, trailing: true});
  return gaps;
}

const size = (gap: Gap) => Math.max(0, gap.to - gap.from + 1);

// Whether the page carries the lines a gap would reveal.
const carries = (card: CardDiff, gap: Gap) => card.context !== null && card.context.length >= gap.to;

/**
 * `shown` after one click on gap `index`: five more lines, or the rest of
 * a gap between hunks once five or fewer are left. A gap whose lines the
 * page doesn't carry stays as it is.
 */
export function expandGap(card: CardDiff, shown: readonly number[], index: number): number[] {
  const gap = gapsOf(card)[index];
  const next = [...shown];
  if (!gap || !carries(card, gap)) return next;
  const left = size(gap) - (next[index] ?? 0);
  next[index] = (next[index] ?? 0) + (gap.trailing || left > EXPAND_STEP ? Math.min(EXPAND_STEP, left) : left);
  return next;
}

export type TableRow =
  | {kind: 'line'; line: DrawnLine; gap?: number; revealed?: true}
  // A hunk's header, with the control that reveals gap `gap` above it (or
  // below the last hunk), if any: `dir` is its icon, null for none.
  | {kind: 'hunk'; gap: number; dir: 'up' | 'down' | 'unfold' | null; remaining: number; text: string; disabled?: true};

/** The rows of a card's table with `shown` lines of each gap revealed: a gap between hunks opens upward, from the hunk under it. */
export function tableRows(card: CardDiff, shown: readonly number[]): TableRow[] {
  const rows: TableRow[] = [];
  const gaps = gapsOf(card);
  const contextLine = (gap: Gap, index: number, n: number): TableRow => ({kind: 'line', line: {t: ' ', o: n + gap.delta, n, h: card.context![n - 1]!}, gap: index, revealed: true});
  for (const [index, gap] of gaps.entries()) {
    const length = size(gap);
    const open = Math.min(shown[index] ?? 0, length);
    const left = length - open;
    const can = carries(card, gap);
    const disabled = !can && card.contextNote === 'budget' ? {disabled: true as const} : {};
    if (gap.trailing) {
      for (let n = gap.from; n < gap.from + open; n += 1) rows.push(contextLine(gap, index, n));
      if (left > 0 && (can || disabled.disabled)) rows.push({kind: 'hunk', gap: index, dir: 'down', remaining: left, text: '', ...disabled});
      continue;
    }
    if (left > 0 || index === 0) {
      const dir = left === 0 || (!can && !disabled.disabled) ? null : index === 0 || left > EXPAND_STEP ? 'up' : 'unfold';
      rows.push({kind: 'hunk', gap: index, dir, remaining: left, text: '', ...(left > 0 ? disabled : {})});
    }
    for (let n = gap.to - open + 1; n <= gap.to; n += 1) rows.push(contextLine(gap, index, n));
    for (const line of card.hunks[index]!.lines) rows.push({kind: 'line', line});
  }
  // Each header counts the rows under it, as they stand now, as git would
  // for that stretch, with the function context git printed for its hunk.
  for (const [at, row] of rows.entries()) {
    if (row.kind !== 'hunk' || gaps[row.gap]!.trailing) continue;
    const under: DrawnLine[] = [];
    for (let next = at + 1; next < rows.length && rows[next]!.kind === 'line'; next += 1) under.push((rows[next] as Extract<TableRow, {kind: 'line'}>).line);
    const hunk = card.hunks[row.gap]!;
    const old = under.filter((line) => line.o !== undefined);
    const now = under.filter((line) => line.n !== undefined);
    const range = `@@ -${old[0]?.o ?? hunk.oldStart},${old.length} +${now[0]?.n ?? hunk.newStart},${now.length} @@`;
    row.text = hunk.context ? `${range} ${hunk.context}` : range;
  }
  return rows;
}

const MARKS = {' ': ' ', '+': '+', '-': '-'} as const;
const KINDS = {' ': '', '+': 'add', '-': 'del'} as const;

function control(row: Extract<TableRow, {kind: 'hunk'}>) {
  if (row.disabled) {
    const words = 'Open the file to see more';
    return `<button type="button" class="exbtn" disabled aria-label="${words}" title="${words}">${icon(row.dir ?? 'unfold')}</button>`;
  }
  if (!row.dir) return '';
  const count = Math.min(EXPAND_STEP, row.remaining);
  const words = row.dir === 'down' ? `Show ${count} more line${count === 1 ? '' : 's'} below` : row.dir === 'unfold' ? `Show the ${row.remaining} hidden line${row.remaining === 1 ? '' : 's'}` : `Show ${count} more line${count === 1 ? '' : 's'} above`;
  return `<button type="button" class="exbtn" data-act="expand" data-g="${row.gap}" aria-label="${words}" title="${words}">${icon(row.dir)}</button>`;
}

const code = (line: DrawnLine) => `<span class="mk">${MARKS[line.t]}</span>${line.h}`;

/**
 * The table's markup. `fresh`: the gap a click just opened, whose lines
 * arrive with a brief tint.
 */
export function tableHtml(card: CardDiff, shown: readonly number[], mode: 'unified' | 'split', fresh?: number): string {
  const rows = tableRows(card, shown);
  const classOf = (row: Extract<TableRow, {kind: 'line'}>) => [KINDS[row.line.t], ...(row.revealed && row.gap === fresh ? ['revealed'] : [])].filter(Boolean).join(' ');
  const attribute = (names: string) => (names ? ` class="${names}"` : '');
  const parts: string[] = [];
  if (mode === 'unified') {
    parts.push('<table class="diff uni"><colgroup><col class="c-ln"><col class="c-ln"><col></colgroup><tbody>');
    for (const row of rows) {
      if (row.kind === 'hunk') {
        parts.push(`<tr class="hdr"><td class="ex" colspan="2">${control(row)}</td><td class="hx">${escapeText(row.text)}</td></tr>`);
        continue;
      }
      const {line} = row;
      parts.push(`<tr${attribute(classOf(row))}><td class="ln" data-n="${line.o ?? ''}"></td><td class="ln" data-n="${line.n ?? ''}"></td><td class="cd">${code(line)}</td></tr>`);
    }
  } else {
    parts.push('<table class="diff split"><colgroup><col class="c-ln"><col><col class="c-ln"><col></colgroup><tbody>');
    const side = (line: DrawnLine | undefined, which: 'o' | 'n') => {
      if (!line) return '<td class="ln emp"></td><td class="cd emp"></td>';
      const kind = KINDS[line.t];
      const named = kind ? ` ${kind}` : '';
      return `<td class="ln${named}" data-n="${line[which] ?? ''}"></td><td class="cd${named}">${code(line)}</td>`;
    };
    for (let at = 0; at < rows.length;) {
      const row = rows[at]!;
      if (row.kind === 'hunk') {
        parts.push(`<tr class="hdr"><td class="ex">${control(row)}</td><td class="hx" colspan="3">${escapeText(row.text)}</td></tr>`);
        at += 1;
        continue;
      }
      if (row.line.t === ' ') {
        parts.push(`<tr${attribute(classOf(row))}>${side(row.line, 'o')}${side(row.line, 'n')}</tr>`);
        at += 1;
        continue;
      }
      const removed: DrawnLine[] = [];
      const added: DrawnLine[] = [];
      const isLine = (index: number) => rows[index]?.kind === 'line';
      while (at < rows.length && isLine(at) && (rows[at] as Extract<TableRow, {kind: 'line'}>).line.t === '-') removed.push((rows[at++] as Extract<TableRow, {kind: 'line'}>).line);
      while (at < rows.length && isLine(at) && (rows[at] as Extract<TableRow, {kind: 'line'}>).line.t === '+') added.push((rows[at++] as Extract<TableRow, {kind: 'line'}>).line);
      for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) parts.push(`<tr>${side(removed[pair], 'o')}${side(added[pair], 'n')}</tr>`);
    }
  }
  parts.push('</tbody></table>');
  return parts.join('');
}
