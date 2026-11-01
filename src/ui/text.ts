import stringWidth from 'string-width';
import {escapeHiddenCharacters} from '../controlChars.js';

// Terminal-cell measurement and display escaping shared by the section
// builder and the Ink UI. Ink measures with string-width, so everything that
// pads, wraps, truncates or maps mouse columns must measure the same way.

// Printable ASCII, plus the symbols delta and the panes draw on nearly every
// row: box drawing (the gutter `│`, frames), `⋮`, `•` and `…`. Each of these
// is its own grapheme next to any other one and one cell wide in
// string-width, so text made only of them is as wide as it is long.
// string-width costs tens of microseconds on a diff row, which adds up to
// seconds on a large diff.
export const SINGLE_CELL_TEXT = /^[\x20-\x7E\u2022\u2026\u22EE\u2500-\u257F]*$/;
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

export type Grapheme = {text: string; width: number};

export function cellWidth(text: string): number {
  return SINGLE_CELL_TEXT.test(text) ? text.length : stringWidth(text);
}

// Splits plain text (no escape sequences) into grapheme clusters with their
// cell widths, so a surrogate pair or combining sequence is never split.
export function graphemes(text: string): Grapheme[] {
  if (SINGLE_CELL_TEXT.test(text)) {
    return Array.from(text, (char) => ({text: char, width: 1}));
  }

  return Array.from(segmenter.segment(text), ({segment}) => ({text: segment, width: stringWidth(segment)}));
}

// Keeps the end of `text`, prefixed with an ellipsis, within `maxWidth` cells.
export function truncateStart(text: string, maxWidth: number): string {
  if (cellWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return '';
  if (maxWidth === 1) return '…';

  const parts = graphemes(text);
  let kept = '';
  let width = 0;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    if (width + part.width > maxWidth - 1) break;
    kept = part.text + kept;
    width += part.width;
  }

  return `…${kept}`;
}

// Keeps the start of `text`, followed by an ellipsis, within `maxWidth` cells.
export function truncateEnd(text: string, maxWidth: number): string {
  if (cellWidth(text) <= maxWidth) return text;
  if (maxWidth <= 0) return '';
  if (maxWidth === 1) return '…';

  let kept = '';
  let width = 0;
  for (const part of graphemes(text)) {
    if (width + part.width > maxWidth - 1) break;
    kept += part.text;
    width += part.width;
  }

  return `${kept}…`;
}

// Makes repo-derived text (paths, ref names, error messages) safe to draw:
// control, bidi and invisible format characters become visible markers
// instead of reaching the terminal. Copy payloads must keep using the
// original text.
export function toDisplayText(text: string): string {
  return escapeHiddenCharacters(text);
}

const SGR_RESET = '\u001B[0m';

/** One terminal cell's grapheme, its width, and the SGR style active there. */
export type StyledCell = {
  char: string;
  width: number;
  style: string;
};

// Splits an ANSI line into one cell per grapheme, each carrying its terminal
// width and the SGR style active at that point.
export function toStyledCells(line: string) {
  const parts = line.split(/(\x1B\[[0-9;:]*[A-Za-z])/);
  const cells: StyledCell[] = [];
  let style = '';

  for (const part of parts) {
    if (!part) continue;
    if (/^\x1B\[[0-9;:]*[A-Za-z]$/.test(part)) {
      style = part === SGR_RESET ? '' : style + part;
      continue;
    }

    for (const grapheme of graphemes(part)) {
      cells.push({char: grapheme.text, width: grapheme.width, style});
    }
  }

  return cells;
}

export function renderStyledCells(cells: StyledCell[]) {
  let output = '';
  let style = '';

  for (const cell of cells) {
    if (cell.style !== style) {
      output += cell.style || SGR_RESET;
      style = cell.style;
    }

    output += cell.char;
  }

  return output + SGR_RESET;
}
