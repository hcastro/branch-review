import {visibleWidth} from '../sections.js';
import {palette} from './palette.js';
import {truncateEnd} from './text.js';

// What a reader new to branch-review is told about its keys: the `?`
// overlay listing every key in plain words, grouped, and the one-time tip
// the footer shows the first time a file can use Preview or Review in
// browser. Pure text, laid out to a width, so the app only decides when
// each one shows.

type KeyGroup = {title: string; keys: ReadonlyArray<readonly [string, string]>};

/** The overlay's groups. `preview`: whether `v` draws a markdown file's page in this terminal. */
export function keyHelpGroups({preview}: {preview: boolean}): KeyGroup[] {
  return [
    {title: 'Move around', keys: [
      ['↑ ↓', 'Previous or next file'],
      ['j k', 'Scroll one line'],
      ['g G', 'Go to the top or the bottom'],
      ['[ ]', 'Previous or next block'],
      ['Enter Space', 'Fold or unfold the block'],
      ['t', 'Show or hide the file tree'],
      ['q Esc Ctrl+C', 'Quit'],
    ]},
    {title: 'Copy', keys: [
      ['y', "The file's path"],
      ['Y', "The file's absolute path"],
      ['d', "The file's diff"],
      ['f', 'The whole file'],
      ['c', "The block's added code"],
      ['p', "The block's diff"],
      ['b', 'The block as a prompt, with file and line'],
      ['T', 'The list of changed files'],
    ]},
    {title: 'Preview and browser', keys: [
      ['v', preview ? 'Preview a markdown file as GitHub shows it, and back' : 'Preview a markdown file as GitHub shows it, in Ghostty, cmux, or Kitty'],
      ['r', "Review this file's changes in the browser"],
      ['R', 'All files in the browser'],
      ['[ ]', 'In a Preview: the previous or next change'],
      ['c', "In a Preview: copy the block's markdown"],
      ['p b', "In a Preview: copy the change's diff or prompt"],
    ]},
    {title: 'Images and video', keys: [
      ['1 2 3', 'Side by side, flip, or difference'],
      ['2', 'In flip: show the other version'],
      ['o', 'Open it in the default viewer or player'],
      ['O', 'Show it in Quick Look, on macOS'],
      ['v', "An image or video's details, or an SVG's source"],
      ['1 2', 'On a video: both frame strips, or one'],
    ]},
  ];
}

const COLUMN_GAP = 4;
// The narrowest a right column may be cut to before the groups go into one.
const MIN_COLUMN = 40;
const KEY_HELP_TITLE = 'Keys';
const KEY_HELP_CLOSE = 'Esc or ? closes';

// The key column fits the longest keys of any row, so every action lines up.
function keyWidthOf(groups: readonly KeyGroup[]) {
  return Math.max(...groups.flatMap((group) => group.keys.map(([key]) => visibleWidth(key))));
}

// One group as lines: its title, then a key and what it does per line, the
// words cut to `width`.
function groupLines(group: KeyGroup, width: number, keyWidth: number) {
  const sgr = palette.sgr;
  return [
    `${sgr.cyanBold}${group.title}${sgr.reset}`,
    ...group.keys.map(([key, what]) => `${sgr.magentaBright}${key.padEnd(keyWidth)}${sgr.reset} ${truncateEnd(what, Math.max(1, width - keyWidth - 1))}`),
  ];
}

// Groups one under the other, a blank line between each.
function stack(groups: readonly KeyGroup[], width: number, keyWidth: number) {
  return groups.flatMap((group, index) => [...(index > 0 ? [''] : []), ...groupLines(group, width, keyWidth)]);
}

// The cells the widest line of `groups` takes.
const widestOf = (groups: readonly KeyGroup[], keyWidth: number) => Math.max(...groups.flatMap((group) => [visibleWidth(group.title), ...group.keys.map(([, what]) => keyWidth + 1 + visibleWidth(what))]));

/**
 * The overlay's lines for an inner box `width` cells wide: a title row,
 * then the groups in two columns where the second keeps room to read,
 * else in one.
 */
export function keyHelpLines(groups: readonly KeyGroup[], width: number): string[] {
  const sgr = palette.sgr;
  const title = `${sgr.bold}${KEY_HELP_TITLE}${sgr.reset}${sgr.gray} · ${KEY_HELP_CLOSE}${sgr.reset}`;
  const keyWidth = keyWidthOf(groups);
  const half = Math.ceil(groups.length / 2);
  const leftWidth = widestOf(groups.slice(0, half), keyWidth);
  const rightWidth = Math.min(widestOf(groups.slice(half), keyWidth), width - leftWidth - COLUMN_GAP);
  if (rightWidth < MIN_COLUMN) return [title, '', ...stack(groups, width, keyWidth)];
  const left = stack(groups.slice(0, half), leftWidth, keyWidth);
  const right = stack(groups.slice(half), rightWidth, keyWidth);
  const rows = Array.from({length: Math.max(left.length, right.length)}, (_, index) => {
    const cell = left[index] ?? '';
    return right[index] ? `${cell}${' '.repeat(leftWidth + COLUMN_GAP - visibleWidth(cell))}${right[index]}` : cell;
  });
  return [title, '', ...rows];
}

/**
 * The one-time tip for the file in view, naming only what works on it:
 * `preview`, `v` draws its page here; `browser`, `r` opens it. Null when
 * neither does.
 */
export function firstTip({preview, browser}: {preview: boolean; browser: boolean}): string | null {
  if (preview && browser) return 'Tip: press v to preview this file as GitHub shows it, or r to open its changes in the browser';
  if (preview) return 'Tip: press v to preview this file as GitHub shows it';
  if (browser) return "Tip: press r to open this file's changes in the browser";
  return null;
}
