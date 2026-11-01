import type {PlanRow, TextPart, Tone} from '../media/layout.js';
import {GUTTER_COLS, pageRows, tileRange, type PageGeometry} from './tileGeometry.js';

// The rows a rendered page takes in the diff pane: one box row for every
// row of the page, up to MAX_PAGE_ROWS, each naming its tile and its row in it.
// The change marks are not in the pixels: they are gutter text left of the
// sheet, in the palette's colors, so NO_COLOR applies, `[` and `]` land on
// exact rows, and a mark that changes needs no new tile. Pure.

/** Where a page's parts are, in CSS pixels from its top, as Chromium laid it out. */
export type PageLayout = {
  heightCss: number;
  /** The page's top-level blocks, list items and table rows, with the source lines each came from. */
  blocks: LayoutBlock[];
  /** The `− 1 paragraph removed` markers. */
  removed: LayoutBox[];
  links: LayoutLink[];
  /** Every element id a `#anchor` can name, with its top. */
  anchors: Array<{id: string; top: number}>;
};

export type LayoutBox = {top: number; bottom: number};
export type LayoutBlock = LayoutBox & {id: string; lines?: readonly [number, number]; mark?: 'added' | 'modified'};
export type LayoutLink = LayoutBox & {href: string; left: number; right: number};

export type PaneMark = 'added' | 'modified' | 'removed';

const MARK_TONES: Record<PaneMark, Tone> = {added: 'after', modified: 'changed', removed: 'before'};
const MARK_GLYPHS: Record<PaneMark, string> = {added: '▌', modified: '▌', removed: '┆'};

/** The CSS pixels pane row `row` of the page covers. */
export function rowSpan(geometry: PageGeometry, row: number): LayoutBox {
  const {cellPx, dpr} = geometry;
  return {top: (row * cellPx.h) / dpr, bottom: ((row + 1) * cellPx.h) / dpr};
}

/** The pane row a CSS position on the page falls in. */
export function rowAt(geometry: PageGeometry, css: number) {
  return Math.max(0, Math.floor((css * geometry.dpr) / geometry.cellPx.h + 1e-6));
}

/**
 * Each pane row's mark: the change a marked block or a removed marker
 * crossing it shows. A row two blocks cross shows the stronger: modified
 * over added, and either over a removed marker beside it.
 */
export function rowMarks(layout: PageLayout, geometry: PageGeometry, rows: number): Array<PaneMark | null> {
  const marks: Array<PaneMark | null> = Array(rows).fill(null);
  const rank: Record<PaneMark, number> = {removed: 1, added: 2, modified: 3};
  const put = (box: LayoutBox, mark: PaneMark) => {
    if (box.bottom <= box.top) return;
    const last = Math.min(rows - 1, rowAt(geometry, box.bottom - 1e-3));
    for (let row = rowAt(geometry, box.top); row <= last; row += 1) {
      const known = marks[row];
      if (!known || rank[mark] > rank[known]) marks[row] = mark;
    }
  };
  for (const box of layout.removed) put(box, 'removed');
  for (const block of layout.blocks) if (block.mark) put(block, block.mark);
  return marks;
}

/** The gutter for a row with `mark`, GUTTER_COLS cells. */
export function gutterLead(mark: PaneMark | null): TextPart[] {
  if (!mark) return [{text: ' '.repeat(GUTTER_COLS), tone: 'plain'}];
  return [{text: ' ', tone: 'plain'}, {text: MARK_GLYPHS[mark], tone: MARK_TONES[mark]}, {text: ' ', tone: 'plain'}];
}

/** The page's box rows: `tileKey` names tile `index` at this geometry. No viewport cap; at most MAX_PAGE_ROWS. */
export function planRenderedRows(layout: PageLayout, geometry: PageGeometry, tileKey: (index: number) => string): PlanRow[] {
  const rows = pageRows(geometry, layout.heightCss);
  const marks = rowMarks(layout, geometry, rows);
  const plan: PlanRow[] = [];
  for (let row = 0; row < rows; row += 1) {
    const index = Math.floor(row / geometry.tileRows);
    const range = tileRange(index, rows, geometry);
    plan.push({
      type: 'box',
      boxes: [{
        imageKey: tileKey(index),
        role: 'after',
        cols: geometry.sheetCols,
        rows: range.rows,
        leftPad: geometry.leftPad,
        drawPx: {w: range.width, h: range.height},
        nearest: false,
        op: 'fit',
      }],
      boxRow: row - range.first,
      lead: gutterLead(marks[row]!),
    });
  }
  return plan;
}
