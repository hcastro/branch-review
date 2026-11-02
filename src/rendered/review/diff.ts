// A changed file's diff as the Review in browser page draws it: its hunks
// as the review read them from git, each line with its numbers on both
// sides, and the HTML its text is drawn with. Pure, with no Node imports:
// the page script bundles it too, to draw the split view and the context a
// reader expands from the same lines the page arrived with.

export type LineKind = ' ' | '+' | '-';

/** One line of a hunk: its kind, its number on the base (`o`) and the reviewed (`n`) side, and its text. */
export type HunkLine = {t: LineKind; o?: number; n?: number; text: string};

/** One hunk: where it starts on each side, how many lines it covers there, and the function context git printed after its `@@`. */
export type Hunk = {oldStart: number; oldLines: number; newStart: number; newLines: number; context: string; lines: HunkLine[]};

/** A line as the page draws it: `h` is its text as HTML, escaped, with syntax and word marks. */
export type DrawnLine = {t: LineKind; o?: number; n?: number; h: string};

export type DrawnHunk = Omit<Hunk, 'lines'> & {lines: DrawnLine[]};

/**
 * Everything a card's source diff needs on the page. `context` is the
 * reviewed side's lines as HTML, from line 1, which expanding the gaps
 * between hunks reveals; null when the page doesn't carry them, and then
 * `contextNote` says why: `budget` when the file is past what a page
 * embeds, so the control asks the reader to open the file, else nothing
 * can be expanded. `total`: the reviewed side's line count, when it was
 * read, which says how far the last gap runs.
 */
export type CardDiff = {hunks: DrawnHunk[]; context: string[] | null; contextNote?: 'budget'; total?: number};

// git ends a line only at `\n`, so the function context can hold a lone `\r`.
const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@([^\n]*)$/;

/**
 * The hunks of a file, from each block's text as the review holds it: the
 * `@@` header, then its lines. A `\ No newline at end of file` note is no
 * line of the file, and a bare empty line is a blank context line, as git
 * prints one with diff.suppressBlankEmpty. A line's `\r` before its `\n`
 * is the file's line end, not its text.
 */
export function parseHunks(blocks: ReadonlyArray<{rawDiff: string}>): Hunk[] {
  const hunks: Hunk[] = [];
  for (const block of blocks) {
    const lines = block.rawDiff.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const match = HEADER.exec(lines[0] ?? '');
    if (!match) continue;
    const count = (value: string | undefined) => (value === undefined ? 1 : Number(value));
    const hunk: Hunk = {oldStart: Number(match[1]), oldLines: count(match[2]), newStart: Number(match[3]), newLines: count(match[4]), context: match[5]!.trim(), lines: []};
    let old = firstLine(hunk.oldStart, hunk.oldLines);
    let next = firstLine(hunk.newStart, hunk.newLines);
    for (const raw of lines.slice(1)) {
      const marker = raw[0] ?? ' ';
      if (marker === '\\') continue;
      const text = raw.slice(1).replace(/\r$/, '');
      if (marker === '+') hunk.lines.push({t: '+', n: next++, text});
      else if (marker === '-') hunk.lines.push({t: '-', o: old++, text});
      else hunk.lines.push({t: ' ', o: old++, n: next++, text});
    }
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * A hunk's first line on one side. A side with no lines in the hunk names
 * the line before the change, so the next one is where it would be.
 */
export function firstLine(start: number, lines: number) {
  return lines === 0 ? start + 1 : start;
}

/**
 * Where a changed line differs from the line it replaced: the span between
 * what they share at the start and at the end, widened to whole words, on
 * each side. Null when they share too little for a highlight to help. A
 * blank line shares nothing with the line it was paired with, whose real
 * counterpart is elsewhere, so neither gets a mark.
 */
export function wordRange(before: string, after: string): [[number, number], [number, number]] | null {
  if (before.trim() === '' || after.trim() === '') return null;
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  if (prefix + suffix < Math.min(before.length, after.length) * 0.4) return null;
  if (prefix + suffix === before.length && prefix + suffix === after.length) return null;
  const word = (char: string | undefined) => char !== undefined && /\w/.test(char);
  while (prefix > 0 && word(before[prefix - 1]) && (word(before[prefix]) || word(after[prefix]))) prefix -= 1;
  while (suffix > 0 && word(before[before.length - suffix]) && (word(before[before.length - suffix - 1]) || word(after[after.length - suffix - 1]))) suffix -= 1;
  return [[prefix, before.length - suffix], [prefix, after.length - suffix]];
}

/**
 * The word ranges of a hunk's paired lines, by line index: each run of
 * removed lines is paired, in order, with the run of added lines right
 * after it, as GitHub pairs them.
 */
export function pairedRanges(lines: readonly HunkLine[]): Map<number, [number, number]> {
  const ranges = new Map<number, [number, number]>();
  for (let index = 0; index < lines.length;) {
    if (lines[index]!.t !== '-') {
      index += 1;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (index < lines.length && lines[index]!.t === '-') removed.push(index++);
    while (index < lines.length && lines[index]!.t === '+') added.push(index++);
    for (let pair = 0; pair < Math.min(removed.length, added.length); pair += 1) {
      const range = wordRange(lines[removed[pair]!]!.text, lines[added[pair]!]!.text);
      if (!range) continue;
      ranges.set(removed[pair]!, range[0]);
      ranges.set(added[pair]!, range[1]);
    }
  }
  return ranges;
}

/** Text as HTML: the characters that would open a tag or an entity, or end an attribute, escaped. */
export function escapeText(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * `html` (escaped text inside our spans, as escapeText and the highlighter
 * write it) with the characters from `start` to `end` of its text wrapped
 * in the word mark. The mark closes before each tag inside the range and
 * opens again after it, so it never crosses a span the syntax colors drew.
 */
export function markRange(html: string, start: number, end: number) {
  if (end <= start) return html;
  const open = '<span class="x">';
  let out = '';
  let at = 0;
  let inside = false;
  for (let index = 0; index < html.length;) {
    if (at === start && !inside) {
      out += open;
      inside = true;
    }
    if (at === end && inside) {
      out += '</span>';
      inside = false;
    }
    const char = html[index]!;
    if (char === '<') {
      const close = html.indexOf('>', index) + 1;
      out += inside ? `</span>${html.slice(index, close)}${open}` : html.slice(index, close);
      index = close;
      continue;
    }
    const length = char === '&' ? html.indexOf(';', index) + 1 - index : 1;
    out += html.slice(index, index + length);
    index += length;
    at += 1;
  }
  if (inside) out += '</span>';
  // A mark that opened right before a tag and closed after it holds nothing.
  return out.replace(/<span class="x"><\/span>/g, '');
}

/**
 * A hunk drawn: each line's HTML from the side it is on (`oldHtml` or
 * `newHtml`, by its number, when the whole side was highlighted; else its
 * own text, escaped), with the word mark where a paired line differs.
 */
export function drawHunk(hunk: Hunk, html: {old?: (line: number) => string | undefined; new?: (line: number) => string | undefined} = {}): DrawnHunk {
  const ranges = pairedRanges(hunk.lines);
  const {lines, ...rest} = hunk;
  return {
    ...rest,
    lines: lines.map((line, index) => {
      const drawn = (line.t === '-' ? html.old?.(line.o!) : html.new?.(line.n!)) ?? escapeText(line.text);
      const range = ranges.get(index);
      return {t: line.t, ...(line.o !== undefined ? {o: line.o} : {}), ...(line.n !== undefined ? {n: line.n} : {}), h: range ? markRange(drawn, range[0], range[1]) : drawn};
    }),
  };
}
