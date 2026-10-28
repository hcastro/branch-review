import type {ReviewBlock} from '../review/model.js';
import {toDisplayText} from './text.js';

// Maps the code delta drew for one diff line back to the line's raw text, so
// a mouse selection copies the file's exact bytes: a control character drawn
// as a marker (`^M`, `␛`) is one character, a tab drawn as spaces is one tab.
// The map comes from the raw text and the drawn text together, never from the
// drawn text alone, where a literal `^M` in the source looks like a marker.

// delta replaces each tab with this many spaces; 4 is delta's other common
// setting, tried when 8 does not line up.
const TAB_WIDTHS = [8, 4];

// One block's body lines as the raw diff has them, without the +/-/space
// prefix and in the order delta draws them. `\ No newline at end of file`
// lines are left out: delta draws them without a gutter, as no code row.
export function blockSourceLines(block: Pick<ReviewBlock, 'rawDiff'>): string[] {
  const lines = block.rawDiff.split('\n').slice(1);
  if (lines.at(-1) === '') lines.pop();
  return lines.filter((line) => !line.startsWith('\\')).map((line) => line.slice(1));
}

// For each UTF-16 unit of `drawn`, the range [from, to) of `raw` it shows, or
// null when the two do not line up. Trailing spaces delta added past the end
// of the line map to the empty range at the end.
export function mapDrawnToRaw(raw: string, drawn: string): Array<[number, number]> | null {
  for (const tabWidth of TAB_WIDTHS) {
    const map = alignWithTabWidth(raw, drawn, tabWidth);
    if (map) return map;
  }

  return null;
}

function alignWithTabWidth(raw: string, drawn: string, tabWidth: number) {
  const map: Array<[number, number]> = [];
  let rawIndex = 0;
  let drawnIndex = 0;

  while (rawIndex < raw.length) {
    const char = String.fromCodePoint(raw.codePointAt(rawIndex)!);
    // A character drawn as itself, or as its visible marker.
    const shown = char === '\t'
      ? ' '.repeat(tabWidth)
      : drawn.startsWith(char, drawnIndex) ? char : toDisplayText(char);
    if (!drawn.startsWith(shown, drawnIndex)) return null;

    for (let unit = 0; unit < shown.length; unit += 1) {
      map.push([rawIndex, rawIndex + char.length]);
    }
    rawIndex += char.length;
    drawnIndex += shown.length;
  }

  for (; drawnIndex < drawn.length; drawnIndex += 1) {
    if (drawn[drawnIndex] !== ' ') return null;
    map.push([raw.length, raw.length]);
  }

  return map;
}
