import {cellWidth, truncateEnd} from '../ui/text.js';
import {KITTY_DIACRITICS} from './kittyDiacritics.js';
import type {GraphicsCaps, MediaFormat, MediaRef, MediaSpan, MediaViewState, SideInfo, SideName, SideState} from './types.js';

// Where a media file's rows go and how big its boxes are. Pure: the plan is a
// function of the file, what inspect found out about each side (pixel size,
// bytes), the view and the pane. It never depends on whether pixels have been
// drawn, so a picture arriving never changes the row count and never moves
// the text around it.

export type Layout = {
  innerWidth: number;
  viewportRows: number;
  caps: GraphicsCaps;
  // False when the session does not watch the repo (`--no-watch`): no
  // refresh will bring a file that changed on disk back in. Defaults to true.
  watching?: boolean;
};

export type Box = {
  cols: number;
  rows: number;
  // The picture's size in pixels inside the box (the rest is transparent
  // padding up to cols × cell width by rows × cell height).
  drawPx: {w: number; h: number};
  // Upscaled by a whole factor: sharp edges instead of a blur.
  nearest: boolean;
  // The fraction of the source size drawn, before any upscale.
  scale: number;
  upscale: number;
  // Cells before the box that centre it in the columns it was fitted to.
  leftPad: number;
};

export type BoxRole = 'after' | 'before' | 'diff' | 'strip-before' | 'strip-after';
export type BoxOp = 'fit' | 'difference' | 'blocks' | 'blocksDifference' | 'video';

export type BoxSpec = {
  // Names one content at one geometry for one cell size; an image id is
  // bound to it for its whole life.
  imageKey: string;
  role: BoxRole;
  side?: SideName;
  cols: number;
  rows: number;
  // Cells from the pane's inner left edge to the box.
  leftPad: number;
  drawPx: {w: number; h: number};
  nearest: boolean;
  op: BoxOp;
  // Video strips: how many frames across.
  frames?: number;
};

export type Tone = 'plain' | 'dim' | 'before' | 'after' | 'difference' | 'active' | 'error' | 'smaller' | 'larger' | 'changed';
export type TextPart = {text: string; tone: Tone};

export type PlanTextRow = {
  type: 'text';
  role: 'tabs' | 'label' | 'table' | 'timestamps' | 'details' | 'reason' | 'loading';
  // Text placed at cell columns, left to right.
  pieces: Array<{at: number; parts: TextPart[]}>;
  // Text set flush right, dropped when it does not fit.
  right?: TextPart[];
  spans?: MediaSpan[];
};

export type PlanBoxRow = {
  type: 'box';
  // Every box this row crosses (two side by side); a box shorter than the
  // row's index leaves its cells blank.
  boxes: BoxSpec[];
  boxRow: number;
  // A click on the row swaps the side flip mode shows.
  swap?: boolean;
};

export type PlanRow = PlanTextRow | PlanBoxRow;

export type MediaPlan = {
  rows: PlanRow[];
  // Boxes not on screen in this view that should be sent ahead: the hidden
  // flip side, so a swap is instant.
  prefetch: BoxSpec[];
  // The text view: a details table instead of the picture.
  textView: boolean;
};

const MAX_BOX_CELLS = KITTY_DIACRITICS.length;
const TINY_MIN_COLS = 8;
const MAX_UPSCALE = 8;
const BLOCK_MAX_COLS = 60;
const BLOCK_MAX_ROWS = 20;
const SIDE_GAP = 3;
const MIN_HALF_COLS = 16;
const VIDEO_MIN_FRAME_COLS = 12;
const VIDEO_GAP = 1;
const VIDEO_MIN_ROWS = 3;
const VIDEO_MAX_ROWS = 12;
const MINUS = '−';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/**
 * The box for an image of `px` pixels within `maxCols` × `maxRows` cells:
 * never enlarged except a tiny image (under 8 cells wide) by a whole factor,
 * aspect kept, at least one cell, at most the 297 cells the placeholder
 * marks can address. Block previews use square half-cell pixels instead,
 * within 60 × 20 cells.
 */
export function fitBox(px: {w: number; h: number}, maxCols: number, maxRows: number, caps: GraphicsCaps): Box {
  const width = Math.max(1, px.w);
  const height = Math.max(1, px.h);
  if (caps.protocol === 'blocks') return fitBlocks(width, height, maxCols, maxRows);

  const cell = caps.cellPx;
  const colsCap = clamp(Math.floor(maxCols), 1, MAX_BOX_CELLS);
  const rowsCap = clamp(Math.floor(maxRows), 1, MAX_BOX_CELLS);
  const scale = Math.min(1, (colsCap * cell.w) / width, (rowsCap * cell.h) / height);

  let upscale = 1;
  if (scale === 1 && width < TINY_MIN_COLS * cell.w) {
    upscale = Math.min(MAX_UPSCALE, Math.floor((TINY_MIN_COLS * cell.w) / width));
    while (upscale > 1 && (width * upscale > colsCap * cell.w || height * upscale > rowsCap * cell.h)) upscale -= 1;
    upscale = Math.max(1, upscale);
  }

  const drawW = Math.min(Math.max(1, Math.round(width * scale * upscale)), colsCap * cell.w);
  const drawH = Math.min(Math.max(1, Math.round(height * scale * upscale)), rowsCap * cell.h);
  const cols = clamp(Math.ceil(drawW / cell.w), 1, colsCap);
  const rows = clamp(Math.ceil(drawH / cell.h), 1, rowsCap);
  return {
    cols,
    rows,
    drawPx: {w: drawW, h: drawH},
    nearest: upscale > 1,
    scale,
    upscale,
    leftPad: Math.max(0, Math.floor((Math.floor(maxCols) - cols) / 2)),
  };
}

// One cell is one pixel wide and two tall (the upper and lower half block).
function fitBlocks(width: number, height: number, maxCols: number, maxRows: number): Box {
  const colsCap = clamp(Math.floor(maxCols), 1, BLOCK_MAX_COLS);
  const rowsCap = clamp(Math.floor(maxRows), 1, BLOCK_MAX_ROWS);
  const tiny = width < TINY_MIN_COLS;
  let cols = tiny ? Math.min(TINY_MIN_COLS, colsCap) : Math.min(colsCap, width);
  let rows = Math.max(1, Math.round((cols * height) / width / 2));
  if (rows > rowsCap) {
    rows = rowsCap;
    cols = clamp(Math.round((rows * 2 * width) / height), 1, colsCap);
  }

  return {
    cols,
    rows,
    drawPx: {w: cols, h: rows * 2},
    nearest: cols > width,
    scale: Math.min(1, cols / width),
    upscale: cols > width ? cols / width : 1,
    leftPad: Math.max(0, Math.floor((Math.floor(maxCols) - cols) / 2)),
  };
}

/** Byte counts as people read them: 232 KB, 6.1 KB, 4.1 MB. */
export function formatBytes(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const shown = unit === 0 || value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

const FORMAT_LABELS: Record<MediaFormat, string> = {
  png: 'PNG', jpeg: 'JPEG', gif: 'GIF', webp: 'WebP', avif: 'AVIF', svg: 'SVG', mp4: 'MP4', mov: 'MOV', webm: 'WebM',
};

export function formatLabel(format: MediaFormat) {
  return FORMAT_LABELS[format];
}

const pixels = (info: Pick<SideInfo, 'width' | 'height'>) => `${info.width} × ${info.height}`;
const part = (text: string, tone: Tone = 'plain'): TextPart => ({text, tone});
const textRow = (role: PlanTextRow['role'], parts: TextPart[], extra: Partial<PlanTextRow> = {}): PlanTextRow => ({type: 'text', role, pieces: [{at: 0, parts}], ...extra});

/** What a side whose bytes changed on disk after the build says. */
export function staleReason(watching = true) {
  return watching ? 'changed on disk · refreshing' : 'changed on disk · restart to see it';
}

function reasonFor(state: SideState, watching?: boolean) {
  if (state.status === 'stale') return staleReason(watching);
  if (state.status === 'error') return state.reason;
  return '';
}

function imageKey(ref: MediaRef, role: BoxRole, cols: number, rows: number, caps: GraphicsCaps, suffix = '') {
  return `${ref.contentKey}|${role}|${cols}x${rows}|${caps.cellPx.w}x${caps.cellPx.h}${suffix}`;
}

function boxSpec(ref: MediaRef, role: 'before' | 'after' | 'diff', box: Box, offset: number, layout: Layout, geometry?: {cols: number; rows: number; leftPad: number}): BoxSpec {
  const cols = geometry?.cols ?? box.cols;
  const rows = geometry?.rows ?? box.rows;
  const blocks = layout.caps.protocol === 'blocks';
  return {
    imageKey: imageKey(ref, role, cols, rows, layout.caps),
    role,
    ...(role === 'diff' ? {} : {side: role}),
    cols,
    rows,
    leftPad: offset + (geometry?.leftPad ?? box.leftPad),
    drawPx: box.drawPx,
    nearest: box.nearest,
    op: role === 'diff' ? (blocks ? 'blocksDifference' : 'difference') : blocks ? 'blocks' : 'fit',
  };
}

function boxRowsFor(boxes: BoxSpec[], extra: Partial<PlanBoxRow> = {}): PlanBoxRow[] {
  const height = Math.max(0, ...boxes.map((box) => box.rows));
  return Array.from({length: height}, (_, boxRow) => ({type: 'box', boxes, boxRow, ...extra}));
}

// The dim note after a picture's label: how big it is drawn.
function shownNote(box: Box, caps: GraphicsCaps) {
  if (caps.protocol === 'blocks') return `block preview · ${box.cols} × ${box.rows} cells · o opens the real image`;
  if (box.upscale > 1) return `shown at ${box.upscale}×`;
  if (box.scale === 1) return 'shown at 100%';
  return `${box.drawPx.w} × ${box.drawPx.h} px shown`;
}

// An added or deleted SVG has one picture; a modified one names its sides,
// as an image does.
function sideLabel(ref: MediaRef, side: SideName) {
  const picture = ref.kind === 'svg' && !(ref.before && ref.after);
  return part(picture ? 'picture' : side, picture ? 'plain' : side);
}

function tabRow(view: MediaViewState): PlanTextRow {
  const tabs = [
    ['compare.sideBySide', '1 Side by side', 'sideBySide'],
    ['compare.flip', '2 Flip', 'flip'],
    ['compare.difference', '3 Difference', 'difference'],
  ] as const;
  const parts: TextPart[] = [];
  const spans: MediaSpan[] = [];
  let column = 0;
  for (const [index, [id, label, mode]] of tabs.entries()) {
    if (index > 0) {
      parts.push(part('  '));
      column += 2;
    }
    const active = view.compare === mode;
    const text = active ? `[${label}]` : label;
    parts.push(part(text, active ? 'active' : 'plain'));
    spans.push({id, start: column, end: column + cellWidth(text)});
    column += cellWidth(text);
  }
  return textRow('tabs', parts, {spans});
}

// One side alone: its label, then its box. `note` explains why only this
// side shows when the file has two.
function singlePlan(ref: MediaRef, side: SideName, info: SideInfo, layout: Layout, maxRows: number, note?: string): PlanRow[] {
  const box = fitBox({w: info.width, h: info.height}, layout.innerWidth, maxRows, layout.caps);
  const left = [sideLabel(ref, side)];
  if (ref.kind === 'svg') left.push(part(' · rendered from the SVG source', 'dim'));
  if (note) left.push(part(` · ${note}`, 'error'));
  return [
    textRow('label', left, {right: [part(shownNote(box, layout.caps), 'dim')]}),
    ...boxRowsFor([boxSpec(ref, side, box, 0, layout)]),
  ];
}

function sideBySidePlan(ref: MediaRef, before: SideInfo, after: SideInfo, layout: Layout): PlanRow[] {
  const {innerWidth: inner, viewportRows: vp, caps} = layout;
  const half = Math.floor((inner - SIDE_GAP) / 2);
  const label = (side: SideName, info: SideInfo) => [sideLabel(ref, side), part(` ${pixels(info)} · ${formatBytes(info.bytes)}`, 'dim')];

  if (half < MIN_HALF_COLS) {
    const rows = Math.max(3, Math.floor((vp - 4) / 2));
    const beforeBox = fitBox({w: before.width, h: before.height}, inner, rows, caps);
    const afterBox = fitBox({w: after.width, h: after.height}, inner, rows, caps);
    return [
      textRow('label', label('before', before)),
      ...boxRowsFor([boxSpec(ref, 'before', beforeBox, 0, layout)]),
      textRow('label', label('after', after)),
      ...boxRowsFor([boxSpec(ref, 'after', afterBox, 0, layout)]),
    ];
  }

  const rows = Math.max(4, vp - 3);
  const beforeBox = fitBox({w: before.width, h: before.height}, half, rows, caps);
  const afterBox = fitBox({w: after.width, h: after.height}, half, rows, caps);
  const right = half + SIDE_GAP;
  return [
    {type: 'text', role: 'label', pieces: [{at: 0, parts: label('before', before)}, {at: right, parts: label('after', after)}]},
    ...boxRowsFor([boxSpec(ref, 'before', beforeBox, 0, layout), boxSpec(ref, 'after', afterBox, right, layout)]),
  ];
}

// Both sides fitted on their own, then given the same box, so a swap only
// changes which id the cells name.
function flipPlan(ref: MediaRef, before: SideInfo, after: SideInfo, view: MediaViewState, layout: Layout): {rows: PlanRow[]; prefetch: BoxSpec[]} {
  const rowsCap = Math.max(4, layout.viewportRows - 3);
  const boxes = {
    before: fitBox({w: before.width, h: before.height}, layout.innerWidth, rowsCap, layout.caps),
    after: fitBox({w: after.width, h: after.height}, layout.innerWidth, rowsCap, layout.caps),
  };
  const cols = Math.max(boxes.before.cols, boxes.after.cols);
  const rows = Math.max(boxes.before.rows, boxes.after.rows);
  const geometry = {cols, rows, leftPad: Math.max(0, Math.floor((layout.innerWidth - cols) / 2))};
  const shown = view.flipSide;
  const hidden: SideName = shown === 'after' ? 'before' : 'after';
  return {
    rows: [
      textRow('label', [sideLabel(ref, shown), part(' · 2 or click swaps', 'dim')]),
      ...boxRowsFor([boxSpec(ref, shown, boxes[shown], 0, layout, geometry)], {swap: true}),
    ],
    prefetch: [boxSpec(ref, hidden, boxes[hidden], 0, layout, geometry)],
  };
}

// The share of the image that changed, as people read it: a sliver of
// change never rounds down to none.
function changedShare(ratio: number) {
  const percent = Math.round(ratio * 100);
  return percent === 0 ? 'under 1% of the image' : `${percent}% of the image`;
}

function differencePlan(ref: MediaRef, before: SideInfo, after: SideInfo, layout: Layout, changedRatio?: number): PlanRow[] {
  const canvas = {w: Math.max(before.width, after.width), h: Math.max(before.height, after.height)};
  const box = fitBox(canvas, layout.innerWidth, Math.max(4, layout.viewportRows - 3), layout.caps);
  const sizesDiffer = before.width !== after.width || before.height !== after.height;
  // The ratio comes with the drawn difference; until then the label says
  // only what the marks mean.
  const note = changedRatio === 0
    ? 'no visible pixel change (bytes differ)'
    : `changed pixels marked${changedRatio === undefined ? '' : ` · ${changedShare(changedRatio)}`}${sizesDiffer ? ' · sizes differ, aligned top-left' : ''}`;
  // Next to the label rather than flush right, so a narrow pane cuts the
  // note short instead of dropping it.
  return [
    textRow('label', [part('difference', 'difference'), part(`  ${note}`, 'dim')]),
    ...boxRowsFor([boxSpec(ref, 'diff', box, 0, layout)]),
  ];
}

function detailsPlan(ref: MediaRef, states: Partial<Record<SideName, SideState>>, watching?: boolean): PlanRow[] {
  const present = (['before', 'after'] as const).filter((side) => ref[side]);
  const value = (pick: (info: SideInfo) => string) => present.map((side) => {
    const state = states[side] ?? {status: 'pending'};
    return state.status === 'ready' ? pick(state.info) : state.status === 'pending' ? '…' : reasonFor(state, watching);
  }).join(' → ');
  const row = (name: string, text: string) => textRow('details', [part(name.padEnd(9), 'dim'), part(text)]);
  return [
    row('format', formatLabel(ref.format)),
    row('pixels', value(pixels)),
    row('bytes', value((info) => formatBytes(info.bytes))),
    row('frames', value((info) => String(info.frames))),
    row('ids', present.map((side) => ref[side]!.abbrevId).join(' → ')),
  ];
}

function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function signed(value: number, text: string) {
  return `${value < 0 ? MINUS : '+'}${text}`;
}

const CODEC_LABELS: Record<string, string> = {h264: 'H.264', hevc: 'HEVC', h265: 'HEVC', vp8: 'VP8', vp9: 'VP9', av1: 'AV1', prores: 'ProRes', mpeg4: 'MPEG-4'};

// The table's columns, dropped from the right when the pane is narrow.
const VIDEO_COLUMNS = [
  {name: 'length', at: 9},
  {name: 'size', at: 21},
  {name: 'resolution', at: 36},
  {name: 'codec', at: 50},
  {name: 'frame rate', at: 58},
] as const;

function videoTable(ref: MediaRef, present: SideName[], infos: Partial<Record<SideName, SideInfo>>, inner: number): PlanRow[] {
  const columns = VIDEO_COLUMNS.filter((column, index) => index < 3 || column.at + column.name.length + 2 <= inner);
  const header: PlanTextRow = {type: 'text', role: 'table', pieces: columns.map((column) => ({at: column.at, parts: [part(column.name, 'dim')]}))};
  const before = infos.before;
  const rows = present.map((side): PlanTextRow => {
    const info = infos[side]!;
    const meta = info.video;
    const other = side === 'after' && before ? before : undefined;
    const pending = meta === undefined ? '…' : '–';
    const cells: Record<string, TextPart[]> = {
      length: meta ? [part(duration(meta.durationMs))] : [part(pending, 'dim')],
      size: [part(formatBytes(info.bytes))],
      resolution: meta ? [part(`${meta.width} × ${meta.height}`)] : [part(pending, 'dim')],
      codec: meta ? [part(CODEC_LABELS[meta.codec.toLowerCase()] ?? meta.codec)] : [part(pending, 'dim')],
      'frame rate': meta ? [part(`${Math.round(meta.fps)} fps`)] : [part(pending, 'dim')],
    };
    if (other) {
      const otherMeta = other.video;
      if (meta && otherMeta && meta.durationMs !== otherMeta.durationMs) {
        const delta = Math.round((meta.durationMs - otherMeta.durationMs) / 1000);
        if (delta !== 0) cells.length!.push(part(` ${signed(delta, `${Math.abs(delta)} s`)}`, delta < 0 ? 'smaller' : 'larger'));
      }
      const bytes = info.bytes - other.bytes;
      if (bytes !== 0) cells.size!.push(part(` ${signed(bytes, formatBytes(Math.abs(bytes)))}`, bytes < 0 ? 'smaller' : 'larger'));
      if (meta && otherMeta && (meta.width !== otherMeta.width || meta.height !== otherMeta.height || meta.codec !== otherMeta.codec || Math.round(meta.fps) !== Math.round(otherMeta.fps))) {
        cells[columns.at(-1)!.name]!.push(part(' changed', 'changed'));
      }
    }
    return {
      type: 'text',
      role: 'table',
      pieces: [{at: 0, parts: [part(side, side)]}, ...columns.map((column) => ({at: column.at, parts: cells[column.name]!}))],
    };
  });
  return [header, ...rows];
}

type StripGeometry = {frames: 2 | 4; frameCols: number; cols: number; rows: number};

// Frames are boxes of an assumed 16:9, so the row count never waits on
// ffprobe; other aspects letterbox inside the frame.
function stripGeometry(inner: number, caps: GraphicsCaps, oneStrip: boolean): StripGeometry {
  const frames: 2 | 4 = !oneStrip && inner >= 4 * VIDEO_MIN_FRAME_COLS + 3 * VIDEO_GAP ? 4 : 2;
  const frameCols = Math.max(1, Math.floor((inner - (frames - 1) * VIDEO_GAP) / frames));
  const ideal = Math.round((frameCols * 9 / 16) * caps.cellPx.w / caps.cellPx.h);
  const rows = clamp(ideal, VIDEO_MIN_ROWS, oneStrip ? VIDEO_MAX_ROWS * 2 : VIDEO_MAX_ROWS);
  return {frames, frameCols, cols: Math.min(MAX_BOX_CELLS, frames * frameCols + (frames - 1) * VIDEO_GAP), rows: Math.min(MAX_BOX_CELLS, rows)};
}

function stripBox(ref: MediaRef, side: SideName, geometry: StripGeometry, caps: GraphicsCaps): BoxSpec {
  const role = side === 'before' ? 'strip-before' : 'strip-after';
  return {
    imageKey: imageKey(ref, role, geometry.cols, geometry.rows, caps, `|f${geometry.frames}`),
    role,
    side,
    cols: geometry.cols,
    rows: geometry.rows,
    leftPad: 0,
    drawPx: {w: geometry.cols * caps.cellPx.w, h: geometry.rows * caps.cellPx.h},
    nearest: false,
    op: 'video',
    frames: geometry.frames,
  };
}

function stripRows(ref: MediaRef, side: SideName, info: SideInfo, geometry: StripGeometry, layout: Layout): PlanRow[] {
  const meta = info.video;
  const times: Array<{at: number; parts: TextPart[]}> = Array.from({length: geometry.frames}, (_, index) => ({
    at: index * (geometry.frameCols + VIDEO_GAP),
    parts: [part(meta ? duration((meta.durationMs * (index + 0.5)) / geometry.frames) : meta === undefined ? '…' : '', 'dim')],
  }));
  return [
    textRow('label', [part(side, side), part(` · ${geometry.frames} frames, evenly spaced`, 'dim')]),
    ...boxRowsFor([stripBox(ref, side, geometry, layout.caps)]),
    {type: 'text', role: 'timestamps', pieces: times},
  ];
}

function videoPlan(ref: MediaRef, present: SideName[], states: Partial<Record<SideName, SideState>>, view: MediaViewState, layout: Layout): {rows: PlanRow[]; prefetch: BoxSpec[]} {
  const infos: Partial<Record<SideName, SideInfo>> = {};
  for (const side of present) {
    const state = states[side];
    if (state?.status === 'ready') infos[side] = state.info;
  }
  const ready = present.filter((side) => infos[side]);
  const oneStrip = view.compare === 'flip' && ready.length === 2;
  const geometry = stripGeometry(layout.innerWidth, layout.caps, oneStrip);
  const shown = oneStrip ? [view.flipSide] : present;

  const rows: PlanRow[] = [...videoTable(ref, ready, infos, layout.innerWidth)];
  for (const side of shown) {
    const info = infos[side];
    if (info) rows.push(...stripRows(ref, side, info, geometry, layout));
    else rows.push(textRow('reason', [part(`${side} · ${reasonFor(states[side]!, layout.watching)}`, 'error')]));
  }
  const hidden = oneStrip ? present.find((side) => side !== view.flipSide) : undefined;
  return {rows, prefetch: hidden ? [stripBox(ref, hidden, geometry, layout.caps)] : []};
}

/**
 * The rows a media file shows in place of today's placeholder line (or, for
 * an SVG with source hunks, before its first hunk). The first row is always
 * text, so the file can still be the active one at the top of the viewport.
 */
export function planMedia(
  ref: MediaRef,
  sides: Partial<Record<SideName, SideState>>,
  view: MediaViewState,
  layout: Layout,
  // What drawing found out: the share of a difference's pixels that changed.
  // It only changes label text, never the rows.
  drawn: {changedRatio?: number} = {},
): MediaPlan {
  const present = (['before', 'after'] as const).filter((side) => ref[side]);
  const states = Object.fromEntries(present.map((side) => [side, sides[side] ?? {status: 'pending'}])) as Partial<Record<SideName, SideState>>;

  if (view.textView) {
    return {rows: ref.kind === 'svg' ? [] : detailsPlan(ref, states, layout.watching), prefetch: [], textView: true};
  }

  if (present.some((side) => states[side]!.status === 'pending')) {
    return {rows: [textRow('loading', [part('loading preview…', 'dim')])], prefetch: [], textView: false};
  }

  if (ref.kind === 'video') return {...videoPlan(ref, present, states, view, layout), textView: false};

  const ready = present.filter((side) => states[side]!.status === 'ready');
  const info = (side: SideName) => (states[side] as Extract<SideState, {status: 'ready'}>).info;
  if (ready.length === 0) {
    const failed = present[0]!;
    const prefix = present.length === 2 ? `${failed}: ` : '';
    return {rows: [textRow('reason', [part(`${prefix}${reasonFor(states[failed]!, layout.watching)}`, 'error')])], prefetch: [], textView: false};
  }

  if (present.length === 1) {
    return {rows: singlePlan(ref, present[0]!, info(present[0]!), layout, Math.max(4, layout.viewportRows - 2)), prefetch: [], textView: false};
  }

  const tabs = tabRow(view);
  const rowsCap = Math.max(4, layout.viewportRows - 3);
  if (ready.length === 1) {
    const shown = ready[0]!;
    const failed = present.find((side) => side !== shown)!;
    const note = `${failed}: ${reasonFor(states[failed]!, layout.watching)}`;
    return {rows: [tabs, ...singlePlan(ref, shown, info(shown), layout, rowsCap, note)], prefetch: [], textView: false};
  }

  const before = info('before');
  const after = info('after');
  if (view.compare === 'flip') {
    const flip = flipPlan(ref, before, after, view, layout);
    return {rows: [tabs, ...flip.rows], prefetch: flip.prefetch, textView: false};
  }
  if (view.compare === 'difference') return {rows: [tabs, ...differencePlan(ref, before, after, layout, drawn.changedRatio)], prefetch: [], textView: false};
  return {rows: [tabs, ...sideBySidePlan(ref, before, after, layout)], prefetch: [], textView: false};
}

/** A plan row's text without styling, `width` cells at most; box rows have none. */
export function planRowText(row: PlanRow, width: number) {
  if (row.type === 'box') return '';
  let out = '';
  for (const piece of row.pieces) {
    const text = piece.parts.map((entry) => entry.text).join('');
    const used = cellWidth(out);
    out += used < piece.at ? ' '.repeat(piece.at - used) : out ? ' ' : '';
    out += text;
  }
  if (row.right) {
    const right = row.right.map((entry) => entry.text).join('');
    const used = cellWidth(out);
    if (used + 2 + cellWidth(right) <= width) out += ' '.repeat(width - used - cellWidth(right)) + right;
  }
  return truncateEnd(out, width);
}

