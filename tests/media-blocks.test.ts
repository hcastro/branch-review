import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {blockRows, CLEAR_PIXEL, xterm256} from '../src/media/blocks.js';
import type {MediaBackend, RenderRequest, RenderResult} from '../src/media/backend.js';
import {fitBox} from '../src/media/layout.js';
import type {SideRef} from '../src/media/types.js';
import {createWorkerBackend} from '../src/media/workerClient.js';
import {createWorkerHandler} from '../src/media/worker/handler.js';
import {visibleWidth} from '../src/sections.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir} from './core-helpers.js';
import {BLOCKS_CAPS, pngFixture, sgrCodes} from './media-helpers.js';

// The block preview: a picture drawn as coloured half blocks for terminals
// without Kitty placeholders. The worker samples the image down to one pixel
// per cell column and two per row; the UI turns those pixels into `▀` cells.

const ESC = '\u001B';
const backends: MediaBackend[] = [];
afterEach(() => {
  for (const backend of backends.splice(0)) backend.dispose();
  cleanupTempDirs();
});

const RED = 0xff0000;
const BLUE = 0x0000ff;
const GREEN = 0x00ff00;

function cellsOf(pairs: Array<[number, number]>) {
  return Uint32Array.from(pairs.flat());
}

describe('block rows', () => {
  it('draws 24-bit half blocks, top pixel as foreground and bottom as background, sharing an SGR between equal colours', () => {
    const [row] = blockRows(cellsOf([[RED, BLUE], [RED, BLUE], [GREEN, BLUE]]), 3, 1, 3);
    expect(row).toBe(`${ESC}[38;2;255;0;0;48;2;0;0;255m▀▀${ESC}[38;2;0;255;0m▀${ESC}[39;49m`);
  });

  it('maps every colour to the xterm 256-colour cube or grey ramp at depth 2', () => {
    const [row] = blockRows(cellsOf([[RED, BLUE], [RED, BLUE], [GREEN, BLUE]]), 3, 1, 2);
    expect(row).toBe(`${ESC}[38;5;196;48;5;21m▀▀${ESC}[38;5;46m▀${ESC}[39;49m`);
    expect(xterm256(0x000000)).toBe(16);
    expect(xterm256(0xffffff)).toBe(231);
    expect(xterm256(0x5f87af)).toBe(67);
    // Greys go to the grey ramp when it is nearer than the cube.
    expect(xterm256(0x808080)).toBe(244);
    expect(xterm256(0x0d1117)).toBe(233);
  });

  it('leaves pixels outside the picture to the terminal\'s own background', () => {
    const [row] = blockRows(cellsOf([[CLEAR_PIXEL, CLEAR_PIXEL], [RED, CLEAR_PIXEL], [CLEAR_PIXEL, BLUE], [RED, BLUE], [CLEAR_PIXEL, CLEAR_PIXEL]]), 5, 1, 3);
    expect(row).toBe(` ${ESC}[38;2;255;0;0m▀${ESC}[38;2;0;0;255m▄${ESC}[38;2;255;0;0;48;2;0;0;255m▀${ESC}[49m ${ESC}[39;49m`);
    // A row with no picture at all is plain spaces.
    expect(blockRows(cellsOf([[CLEAR_PIXEL, CLEAR_PIXEL], [CLEAR_PIXEL, CLEAR_PIXEL]]), 2, 1, 3)).toEqual(['  ']);
  });

  it('makes one row of exactly cols cells per cell row, at either depth', () => {
    const cols = 7;
    const rows = 4;
    const cells = new Uint32Array(cols * rows * 2).map((_, index) => (index * 0x1f3d5b) & 0xffffff);
    for (const depth of [2, 3] as const) {
      const lines = blockRows(cells, cols, rows, depth);
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(visibleWidth(line)).toBe(cols);
      const codes = lines.flatMap((line) => [...line.matchAll(/\u001B\[([0-9;]*)m/g)].flatMap((match) => sgrCodes(match[1]!)));
      for (const code of codes) {
        if (code[0] === '38' || code[0] === '48') expect(code[1]).toBe(depth === 3 ? '2' : '5');
        else expect(['39', '49']).toContain(code[0]);
      }
    }
  });
});

function blobSide(cwd: string, file: string, side: 'before' | 'after' = 'after'): SideRef {
  const abbrevId = git(cwd, 'rev-parse', '--short', `HEAD:${file}`).trim();
  return {side, source: 'blob', path: file, abbrevId, key: `blob|${file}|${abbrevId}`};
}

function blocksRequest(cwd: string, sides: SideRef[], px: {w: number; h: number}, extra: Partial<RenderRequest> = {}): RenderRequest {
  const box = fitBox(px, 60, 20, BLOCKS_CAPS);
  return {
    cwd,
    op: sides.length === 2 ? 'blocksDifference' : 'blocks',
    sides,
    kind: 'raster',
    format: 'png',
    checker: false,
    colorDepth: 3,
    target: {cols: box.cols, rows: box.rows, cellPx: BLOCKS_CAPS.cellPx, drawPx: box.drawPx, nearest: box.nearest},
    ...extra,
  };
}

function cellsResult(result: unknown) {
  const value = result as RenderResult;
  if (!value.ok || !('cells' in value)) throw new Error(`no cells: ${JSON.stringify(value)}`);
  return value;
}

// The top and bottom pixel of one cell.
const cellAt = (cells: Uint32Array, cols: number, col: number, row: number) => [cells[(row * cols + col) * 2]!, cells[(row * cols + col) * 2 + 1]!];

describe('the blocks render op in the media worker', {timeout: 60_000}, () => {
  const LEFT_RED = (x: number) => (x < 20 ? [255, 0, 0, 255] as const : [0, 0, 255, 255] as const);

  it('samples a PNG down to one pixel per column and two per row, at the box size', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'a.png'), pngFixture(40, 20, LEFT_RED));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler();
    const request = blocksRequest(cwd, [blobSide(cwd, 'a.png')], {w: 40, h: 20});
    expect(request.target).toMatchObject({cols: 40, rows: 10, drawPx: {w: 40, h: 20}});

    const result = cellsResult(await handler.handle({type: 'render', ...request}));
    expect([result.cols, result.rows]).toEqual([40, 10]);
    expect(result.cells).toHaveLength(40 * 10 * 2);
    expect(cellAt(result.cells, 40, 5, 3)).toEqual([RED, RED]);
    expect(cellAt(result.cells, 40, 35, 3)).toEqual([BLUE, BLUE]);
  });

  it('flattens transparency onto the dark pane colour, and leaves the padding outside the picture clear', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'clear.png'), pngFixture(40, 20, [255, 255, 255, 0]));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler();
    const side = blobSide(cwd, 'clear.png');

    const fitted = cellsResult(await handler.handle({type: 'render', ...blocksRequest(cwd, [side], {w: 40, h: 20})}));
    expect(new Set(fitted.cells)).toEqual(new Set([0x0d1117]));

    // A flip box shared with a larger side: 50 × 12 cells around a 40 × 20
    // pixel picture, so 5 clear columns each side and one clear row above
    // and below.
    const padded = blocksRequest(cwd, [side], {w: 40, h: 20}, {target: {cols: 50, rows: 12, cellPx: BLOCKS_CAPS.cellPx, drawPx: {w: 40, h: 20}, nearest: false}});
    const result = cellsResult(await handler.handle({type: 'render', ...padded}));
    expect([result.cols, result.rows]).toEqual([50, 12]);
    expect(cellAt(result.cells, 50, 0, 5)).toEqual([CLEAR_PIXEL, CLEAR_PIXEL]);
    expect(cellAt(result.cells, 50, 49, 5)).toEqual([CLEAR_PIXEL, CLEAR_PIXEL]);
    expect(cellAt(result.cells, 50, 25, 0)).toEqual([CLEAR_PIXEL, CLEAR_PIXEL]);
    expect(cellAt(result.cells, 50, 25, 11)).toEqual([CLEAR_PIXEL, CLEAR_PIXEL]);
    expect(cellAt(result.cells, 50, 5, 1)).toEqual([0x0d1117, 0x0d1117]);
    expect(cellAt(result.cells, 50, 44, 10)).toEqual([0x0d1117, 0x0d1117]);
  });

  it('draws the difference as blocks, with the share that changed', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'before.png'), pngFixture(40, 20, [0, 0, 255, 255]));
    // The left half turns red.
    fs.writeFileSync(path.join(cwd, 'after.png'), pngFixture(40, 20, LEFT_RED));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler();
    const request = blocksRequest(cwd, [blobSide(cwd, 'before.png', 'before'), blobSide(cwd, 'after.png')], {w: 40, h: 20});
    const result = cellsResult(await handler.handle({type: 'render', ...request}));
    expect(result.changedRatio).toBe(0.5);
    const [changed] = cellAt(result.cells, 40, 5, 3);
    const [kept] = cellAt(result.cells, 40, 35, 3);
    // Changed pixels are tinted towards #d2a8ff; the rest is the after image
    // darkened.
    expect(changed! >> 16).toBeGreaterThan(150);
    expect(changed! & 0xff).toBeGreaterThan(150);
    expect(kept).toBe(Math.round(255 * 0.45));
  });

  it('draws an SVG as blocks', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#00ff00"/></svg>');
    commitAll(cwd, 'add');
    const handler = createWorkerHandler();
    const request = blocksRequest(cwd, [blobSide(cwd, 'dot.svg')], {w: 40, h: 20}, {kind: 'svg', format: 'svg'});
    const result = cellsResult(await handler.handle({type: 'render', ...request}));
    expect(cellAt(result.cells, 40, 20, 5)).toEqual([GREEN, GREEN]);
  });

  it('says the image library is missing, with no PNG passed through, since blocks need decoded pixels', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'a.png'), pngFixture(40, 20));
    fs.writeFileSync(path.join(cwd, 'b.png'), pngFixture(40, 20, [0, 0, 0, 255]));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler({loadSharp: () => Promise.reject(new Error('dlopen failed'))});
    const unavailable = {ok: false, state: 'unavailable', reason: 'image library failed to load (dlopen failed)'};
    expect(await handler.handle({type: 'render', ...blocksRequest(cwd, [blobSide(cwd, 'a.png')], {w: 40, h: 20})})).toEqual(unavailable);
    expect(await handler.handle({type: 'render', ...blocksRequest(cwd, [blobSide(cwd, 'a.png', 'before'), blobSide(cwd, 'b.png')], {w: 40, h: 20})})).toEqual(unavailable);
  });

  it('refuses a blocks op with the wrong number of sides', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'a.png'), pngFixture(40, 20));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler();
    const side = blobSide(cwd, 'a.png');
    expect(await handler.handle({type: 'render', ...blocksRequest(cwd, [side], {w: 40, h: 20}), op: 'blocksDifference'})).toMatchObject({ok: false, state: 'error'});
    expect(await handler.handle({type: 'render', ...blocksRequest(cwd, [side, side], {w: 40, h: 20}), op: 'blocks'})).toMatchObject({ok: false, state: 'error'});
  });

  it('sends the cells back across the worker\'s IPC as a typed array', async () => {
    const cwd = initRepo();
    fs.writeFileSync(path.join(cwd, 'a.png'), pngFixture(40, 20, LEFT_RED));
    commitAll(cwd, 'add');
    const tempDir = makeTempDir('branch-review-media-test-');
    const backend = createWorkerBackend({tempDir: () => tempDir});
    backends.push(backend);
    const result = cellsResult(await backend.render(blocksRequest(cwd, [blobSide(cwd, 'a.png')], {w: 40, h: 20}), new AbortController().signal));
    expect(result.cells).toBeInstanceOf(Uint32Array);
    expect(cellAt(result.cells, 40, 5, 3)).toEqual([RED, RED]);
  });

  it('keeps hard nearest-neighbour edges for a tiny icon scaled up to 8 columns', async () => {
    const cwd = initRepo();
    // 2 × 2 px: red, blue on top; blue, red below.
    fs.writeFileSync(path.join(cwd, 'icon.png'), pngFixture(2, 2, (x, y) => ((x + y) % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255])));
    commitAll(cwd, 'add');
    const handler = createWorkerHandler();
    const request = blocksRequest(cwd, [blobSide(cwd, 'icon.png')], {w: 2, h: 2});
    expect(request.target).toMatchObject({cols: 8, rows: 4, nearest: true});
    const result = cellsResult(await handler.handle({type: 'render', ...request}));
    expect(cellAt(result.cells, 8, 0, 0)).toEqual([RED, RED]);
    expect(cellAt(result.cells, 8, 7, 0)).toEqual([BLUE, BLUE]);
    expect(cellAt(result.cells, 8, 0, 3)).toEqual([BLUE, BLUE]);
    // Every source pixel becomes a 4 × 4 square of pure colour. The corners
    // above stay pure under any filter; the cells along the middle edges
    // turn purple unless the scale is nearest-neighbour.
    const source = (x: number, py: number) => ((Math.floor(x / 4) + Math.floor(py / 4)) % 2 === 0 ? RED : BLUE);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 8; x += 1) expect(cellAt(result.cells, 8, x, y), `cell ${x},${y}`).toEqual([source(x, y * 2), source(x, y * 2 + 1)]);
    }
  });
});
