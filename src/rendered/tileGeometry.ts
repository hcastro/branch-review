import {KITTY_DIACRITICS} from '../media/kittyDiacritics.js';

// How a rendered page is cut into tiles for the diff pane. A tile is drawn
// with Kitty placeholder cells, and the terminal scales an image to fill its
// cells, so each tile is exactly as many device pixels as its cells hold:
// the sheet's columns times the cell width across, its rows times the cell
// height down. Blur only comes from that scaling, so nothing here ever asks
// for it. The page's scale defaults to the one that makes GitHub's 16 px
// body text as tall as one terminal cell, so the page reads at the size of
// the diff it replaces. Pure: cell size from the terminal's own answer.

/** The gutter's cells, left of the sheet: a space, the change mark, a space. */
export const GUTTER_COLS = 3;
/** A tile's rows, and the rows of a page whose 40-row tiles came out too large. */
export const TILE_ROWS = 40;
export const SHORT_TILE_ROWS = 20;
/** A tile PNG larger than this is cut again at SHORT_TILE_ROWS. */
export const MAX_TILE_PNG_BYTES = 3.5 * 1024 * 1024;
// GitHub lays a file out at most this wide.
const PAGE_CSS_WIDTH = 980;
// The cells a placeholder can address, and the most pixels a terminal takes
// on one side of an image.
const MAX_TILE_CELLS = KITTY_DIACRITICS.length;
const MAX_TILE_PX = 16_384;
// Narrower than this, a page can't be read, and the pane keeps the diff.
const MIN_SHEET_COLS = 16;
const MIN_DPR = 0.5;
const MAX_DPR = 4;
// The CSS height of GitHub's body text, which the type-matched scale fits to a cell.
const BODY_TEXT_PX = 16;

/** `type`: the page's text as tall as the terminal's; a number: that scale. */
export type DprMode = 'type' | number;

export type PageGeometry = {
  cellPx: {w: number; h: number};
  dpr: number;
  /** The cells the sheet spans across. */
  sheetCols: number;
  /** Cells from the pane's inner left edge to the sheet: the gutter, then the letterbox. */
  leftPad: number;
  /** The page's layout width, in CSS pixels. */
  cssWidth: number;
  tileRows: number;
};

/** A tile's rows on the page, and its box in device and CSS pixels. */
export type TileRange = {index: number; first: number; rows: number; y: number; height: number; width: number; cssY: number; cssHeight: number};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** The scale, in quarter steps, at which 16 CSS pixels are one cell high. */
export function typeMatchedDpr(cellH: number) {
  return clamp(Math.round((cellH / BODY_TEXT_PX) * 4) / 4, MIN_DPR, MAX_DPR);
}

/**
 * The sheet for a pane `innerCols` cells wide, or null when it is too
 * narrow to read a page in. The sheet is GitHub's measure or the pane less
 * its gutter, whichever is narrower, and sits centered in what is left.
 */
export function tileGeometry(innerCols: number, cellPx: {w: number; h: number}, dprMode: DprMode = 'type', tileRows = TILE_ROWS): PageGeometry | null {
  const dpr = dprMode === 'type' ? typeMatchedDpr(cellPx.h) : clamp(dprMode, MIN_DPR, MAX_DPR);
  const room = innerCols - GUTTER_COLS;
  const sheetCols = Math.min(room, Math.floor((PAGE_CSS_WIDTH * dpr) / cellPx.w), MAX_TILE_CELLS, Math.floor(MAX_TILE_PX / cellPx.w));
  if (sheetCols < MIN_SHEET_COLS) return null;
  return {
    cellPx: {w: cellPx.w, h: cellPx.h},
    dpr,
    sheetCols,
    leftPad: GUTTER_COLS + Math.floor((room - sheetCols) / 2),
    cssWidth: (sheetCols * cellPx.w) / dpr,
    tileRows: Math.max(1, Math.min(tileRows, MAX_TILE_CELLS, Math.floor(MAX_TILE_PX / cellPx.h))),
  };
}

/**
 * The most rows a page takes in the pane, 250 tiles of 40. The repo's HTML
 * can make a page as tall as Chromium allows (a table cell millions of
 * pixels high), and a row a pixel row costs to plan and scroll, so a page
 * past it is drawn to here and the rest opens with `r`.
 */
export const MAX_PAGE_ROWS = 10_000;

// The page's device height in whole cells.
function pageCells(geometry: PageGeometry, heightCss: number) {
  // A hair under a whole cell is that cell, never one more from float error.
  return Math.max(1, Math.ceil((heightCss * geometry.dpr) / geometry.cellPx.h - 1e-6));
}

/** The pane rows a page of `heightCss` takes: its device height in whole cells, at most MAX_PAGE_ROWS. */
export function pageRows(geometry: PageGeometry, heightCss: number) {
  return Math.min(MAX_PAGE_ROWS, pageCells(geometry, heightCss));
}

/** Whether a page is taller than the pane draws. */
export function pageCut(geometry: PageGeometry, heightCss: number) {
  return pageCells(geometry, heightCss) > MAX_PAGE_ROWS;
}

export function tileCount(geometry: PageGeometry, rows: number) {
  return Math.ceil(rows / geometry.tileRows);
}

/**
 * Tile `index` of a page `rows` rows tall. Every number comes from the
 * index itself, never from the tile before it, so no rounding adds up down
 * a long page; the last tile is shorter.
 */
export function tileRange(index: number, rows: number, geometry: PageGeometry): TileRange {
  const {cellPx, dpr, sheetCols, tileRows} = geometry;
  const first = index * tileRows;
  const count = Math.max(0, Math.min(tileRows, rows - first));
  const y = first * cellPx.h;
  const height = count * cellPx.h;
  return {index, first, rows: count, y, height, width: sheetCols * cellPx.w, cssY: y / dpr, cssHeight: height / dpr};
}

/** Names the geometry in tile keys: new cells, scale or width mean new tiles. */
export function geometryKey(geometry: PageGeometry) {
  return `${geometry.sheetCols}x${geometry.cellPx.w}x${geometry.cellPx.h}@${geometry.dpr}:${geometry.tileRows}`;
}
