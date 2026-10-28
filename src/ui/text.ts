import stringWidth from 'string-width';
import {escapeHiddenCharacters} from '../controlChars.js';

// Terminal-cell measurement and display escaping shared by the section
// builder and the Ink UI. Ink measures with string-width, so everything that
// pads, wraps, truncates or maps mouse columns must measure the same way.

const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

export type Grapheme = {text: string; width: number};

export function cellWidth(text: string): number {
  return PRINTABLE_ASCII.test(text) ? text.length : stringWidth(text);
}

// Splits plain text (no escape sequences) into grapheme clusters with their
// cell widths, so a surrogate pair or combining sequence is never split.
export function graphemes(text: string): Grapheme[] {
  if (PRINTABLE_ASCII.test(text)) {
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
