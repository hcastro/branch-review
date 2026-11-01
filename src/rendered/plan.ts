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
/** A box on the page, in CSS pixels from its top-left. */
export type LayoutRect = {left: number; right: number; top: number; bottom: number};
/** A link and the boxes it draws: one per line its text runs over, and its images. */
export type LayoutLink = {href: string; rects: LayoutRect[]};

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
 * The pane rows a box stands for: those whose vertical centers it holds,
 * or, for a box that holds no row's center, the one row it overlaps most
 * (the earlier on a tie). A box that only grazes a row leaves it to what
 * the row mostly shows. Empty for an empty box.
 */
export function rowsOf(box: LayoutBox, geometry: PageGeometry, rows: number): readonly [number, number] | null {
  if (box.bottom <= box.top || rows <= 0) return null;
  const height = geometry.cellPx.h / geometry.dpr;
  // Row r's center is (r + 0.5) * height: the first at or below the top,
  // the last above the bottom.
  const first = Math.max(0, Math.ceil(box.top / height - 0.5 - 1e-9));
  const last = Math.min(rows - 1, Math.ceil(box.bottom / height - 0.5 - 1e-9) - 1);
  if (first <= last) return [first, last];
  let best = -1;
  let most = 0;
  for (let row = Math.max(0, Math.floor(box.top / height)); row <= Math.min(rows - 1, Math.floor(box.bottom / height)); row += 1) {
    const overlap = Math.min(box.bottom, (row + 1) * height) - Math.max(box.top, row * height);
    if (overlap > most + 1e-9) {
      most = overlap;
      best = row;
    }
  }
  return best < 0 ? null : [best, best];
}

/**
 * Each pane row's mark: the change a marked block or a removed marker
 * shows there, by rowsOf: a block marks the rows it mostly fills, never a
 * row of an unchanged neighbor it grazes. A row two of them claim shows
 * the stronger: modified over added, and either over a removed marker.
 */
export function rowMarks(layout: PageLayout, geometry: PageGeometry, rows: number): Array<PaneMark | null> {
  const marks: Array<PaneMark | null> = Array(rows).fill(null);
  const rank: Record<PaneMark, number> = {removed: 1, added: 2, modified: 3};
  const put = (box: LayoutBox, mark: PaneMark) => {
    const span = rowsOf(box, geometry, rows);
    if (!span) return;
    for (let row = span[0]; row <= span[1]; row += 1) {
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
