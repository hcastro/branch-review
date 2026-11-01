import {describe, expect, it} from 'vitest';
import {planRenderedRows, rowMarks, type PageLayout} from '../src/rendered/plan.js';
import {parseSnapshot} from '../src/rendered/worker/browser.js';
import {GUTTER_COLS, pageRows, tileCount, tileGeometry, tileRange, typeMatchedDpr} from '../src/rendered/tileGeometry.js';

// How a page is cut into tiles that fit their cells exactly: the scale that
// makes the page's body text as tall as the terminal's, the sheet's columns
// and where it sits in the pane, and each tile's rows, all from whole cells
// so the terminal never scales a tile. Then the rows the pane draws, with the
// change marks in the gutter as text.

const OWNER = {w: 13, h: 29};

describe('tile geometry', () => {
  it('matches the page type to the terminal type, in quarter steps', () => {
    expect(typeMatchedDpr(29)).toBe(1.75);
    expect(typeMatchedDpr(20)).toBe(1.25);
    expect(typeMatchedDpr(16)).toBe(1);
    expect(typeMatchedDpr(32)).toBe(2);
    // 18 / 16 is 1.125, which rounds to the nearer quarter.
    expect(typeMatchedDpr(18)).toBe(1.25);
    expect(typeMatchedDpr(17)).toBe(1);
    // Kept to a range a page can be read at.
    expect(typeMatchedDpr(4)).toBe(0.5);
    expect(typeMatchedDpr(200)).toBe(4);
  });

  it('gives the owner pane 131 columns at 1.75, a tile of 1703 by 1160 device pixels', () => {
    const geometry = tileGeometry(220, OWNER)!;
    expect(geometry.dpr).toBe(1.75);
    expect(geometry.sheetCols).toBe(131);
    expect(geometry.cssWidth).toBeCloseTo((131 * 13) / 1.75, 10);
    expect(geometry.tileRows).toBe(40);
    const first = tileRange(0, 400, geometry);
    expect(first).toMatchObject({first: 0, rows: 40, y: 0, height: 1160, width: 1703});
  });

  it('takes a fixed scale when asked, and integer cells give integer CSS widths', () => {
    const geometry = tileGeometry(200, {w: 10, h: 20}, 2)!;
    expect(geometry.dpr).toBe(2);
    expect(geometry.sheetCols).toBe(196);
    expect(geometry.cssWidth).toBe(980);
  });

  it('caps the sheet at the 980 CSS pixels GitHub lays a file out in, and at the pane less its gutter', () => {
    expect(tileGeometry(400, {w: 10, h: 20})!.sheetCols).toBe(Math.floor((980 * 1.25) / 10));
    expect(tileGeometry(80, OWNER)!.sheetCols).toBe(80 - GUTTER_COLS);
  });

  it('centers a narrow sheet in the pane after the gutter, letterboxed in the terminal background', () => {
    const wide = tileGeometry(220, OWNER)!;
    expect(wide.leftPad).toBe(GUTTER_COLS + Math.floor((220 - GUTTER_COLS - 131) / 2));
    const odd = tileGeometry(220 - 1, OWNER)!;
    expect(odd.leftPad).toBe(GUTTER_COLS + Math.floor((219 - GUTTER_COLS - 131) / 2));
    // A pane narrower than the page's measure has no letterbox.
    expect(tileGeometry(80, OWNER)!.leftPad).toBe(GUTTER_COLS);
    expect(odd.leftPad + odd.sheetCols).toBeLessThanOrEqual(219);
  });

  it('keeps every tile within the 297 cells a placeholder can address and 16,384 pixels a side', () => {
    const huge = tileGeometry(400, {w: 6, h: 12}, 4)!;
    expect(huge.sheetCols).toBeLessThanOrEqual(297);
    const tall = tileGeometry(200, {w: 60, h: 600}, 1)!;
    expect(tall.sheetCols * 60).toBeLessThanOrEqual(16_384);
    expect(tall.tileRows * 600).toBeLessThanOrEqual(16_384);
    expect(tall.tileRows).toBe(Math.floor(16_384 / 600));
    const wideCells = tileGeometry(400, {w: 70, h: 20}, 4)!;
    expect(wideCells.sheetCols * 70).toBeLessThanOrEqual(16_384);
  });

  it('has no sheet when the pane is too narrow to read a page in', () => {
    expect(tileGeometry(18, OWNER)).toBeNull();
  });

  it('cuts tiles from their absolute index, so rounding never adds up over 200 tiles', () => {
    const geometry = tileGeometry(220, OWNER)!;
    // A page whose height in device pixels is not a whole number of cells.
    const heightCss = (200 * 40 * 29 - 7) / 1.75;
    const rows = pageRows(geometry, heightCss);
    expect(rows).toBe(200 * 40);
    expect(tileCount(geometry, rows)).toBe(200);
    let next = 0;
    let nextRow = 0;
    for (let index = 0; index < 200; index += 1) {
      const range = tileRange(index, rows, geometry);
      expect(range.y).toBe(next);
      expect(range.first).toBe(nextRow);
      expect(range.height).toBe(range.rows * 29);
      expect(range.cssY).toBeCloseTo(range.y / 1.75, 6);
      expect(Number.isInteger(range.y)).toBe(true);
      next = range.y + range.height;
      nextRow = range.first + range.rows;
    }
    expect(nextRow).toBe(rows);
    expect(next).toBe(rows * 29);
  });

  it('makes the last tile shorter', () => {
    const geometry = tileGeometry(220, OWNER)!;
    const rows = pageRows(geometry, (95 * 29) / 1.75);
    expect(rows).toBe(95);
    expect(tileCount(geometry, rows)).toBe(3);
    expect(tileRange(2, rows, geometry)).toMatchObject({first: 80, rows: 15, height: 15 * 29});
  });

  it('cuts a tile of 20 rows when asked, for a page whose PNGs ran too large', () => {
    const geometry = tileGeometry(220, OWNER, 'type', 20)!;
    expect(geometry.tileRows).toBe(20);
    expect(tileRange(1, 100, geometry)).toMatchObject({first: 20, rows: 20});
  });
});

// A page of three blocks at the owner's scale: a heading, an added
// paragraph and a modified one, with a removed marker between.
const LAYOUT: PageLayout = {
  heightCss: (90 * 29) / 1.75,
  blocks: [
    {id: 'b-head', top: 0, bottom: 40, lines: [1, 1]},
    {id: 'b-new', top: 50, bottom: 100, lines: [3, 4], mark: 'added'},
    {id: 'b-edit', top: 1000, bottom: 1020, lines: [9, 9], mark: 'modified'},
  ],
  removed: [{top: 400, bottom: 420}],
  links: [],
  anchors: [],
};

describe('rendered rows', () => {
  const geometry = tileGeometry(220, OWNER)!;

  it('marks the rows whose centers a changed block or a removed marker holds, and no others', () => {
    const marks = rowMarks(LAYOUT, geometry, pageRows(geometry, LAYOUT.heightCss));
    // Rows are 29 / 1.75 CSS px: [50, 100) holds the centers of rows 3 to 5
    // (row 6 only grazes it), [400, 420) row 24's, [1000, 1020) rows 60 and 61.
    const marked = marks.flatMap((mark, row) => (mark ? [[row, mark]] : []));
    expect(marked).toEqual([[3, 'added'], [4, 'added'], [5, 'added'], [24, 'removed'], [60, 'modified'], [61, 'modified']]);
  });

  it('marks only the rows a changed list item mostly fills, never a row of an unchanged neighbor it grazes', () => {
    // 24 px items 4 px apart, at 13 by 29 cells and dpr 1.75: rows are
    // 16.57 CSS px, centered at 8.3, 24.9, 41.4, 58.0, 74.6, 91.1.
    const item = (index: number) => ({top: index * 28, bottom: index * 28 + 24});
    const list: PageLayout = {
      heightCss: 112,
      blocks: [
        {id: 'b-list', top: 0, bottom: 108, lines: [1, 4]},
        {id: 'b-one', ...item(0), lines: [1, 1]},
        {id: 'b-two', ...item(1), lines: [2, 2], mark: 'modified'},
        {id: 'b-three', ...item(2), lines: [3, 3]},
        {id: 'b-four', ...item(3), lines: [4, 4]},
      ],
      removed: [],
      links: [],
      anchors: [],
    };
    const marks = rowMarks(list, geometry, pageRows(geometry, list.heightCss));
    expect(marks).toEqual([null, null, 'modified', null, null, null, null]);
    // A 10 px box between two rows' centers marks the one it overlaps most.
    const thin: PageLayout = {...list, blocks: [{id: 'b-thin', top: 26, bottom: 36, lines: [2, 2], mark: 'added'}]};
    expect(rowMarks(thin, geometry, 7)).toEqual([null, 'added', null, null, null, null, null]);
    const removed: PageLayout = {...list, blocks: [], removed: [{top: 26, bottom: 36}]};
    expect(rowMarks(removed, geometry, 7).filter(Boolean)).toHaveLength(1);
  });

  it('gives a row two marks cross the stronger: modified over added, either over a removed marker', () => {
    const row = (index: number) => ({top: (index * 29) / 1.75, bottom: ((index + 1) * 29) / 1.75});
    const shared: PageLayout = {
      heightCss: row(10).bottom,
      // Row 2: an added block ends where a modified one starts, in both
      // orders. Row 6: an added block beside a removed marker.
      blocks: [
        {id: 'b-added', ...row(1), bottom: row(2).bottom - 1, mark: 'added'},
        {id: 'b-modified', top: row(2).top + 1, bottom: row(3).bottom, mark: 'modified'},
        {id: 'b-modified-first', ...row(4), mark: 'modified'},
        {id: 'b-added-after', ...row(4), mark: 'added'},
        {id: 'b-beside', ...row(6), mark: 'added'},
      ],
      removed: [row(6), row(8)],
      links: [],
      anchors: [],
    };
    const marks = rowMarks(shared, geometry, 10);
    expect(marks).toEqual([null, 'added', 'modified', 'modified', 'modified', null, 'added', null, 'removed', null]);
  });

  it('marks a changed list item on its own rows, never on the nested list under it', () => {
    // A modified item holding an unchanged item and, under that, an added
    // one, laid out at 20 CSS px a row: the item's own line is row 0.
    const strings: string[] = [];
    const s = (text: string) => (strings.includes(text) ? strings.indexOf(text) : strings.push(text) - 1);
    const item = (id: string, lines: string, mark?: string) => [s('data-block'), s(id), s('data-lines'), s(lines), ...(mark ? [s('data-mark'), s(mark)] : [])];
    const nodes = [
      {name: '#document', parent: -1, attributes: [] as number[]},
      {name: 'HTML', parent: 0, attributes: [], box: [0, 0, 400, 120]},
      {name: 'BODY', parent: 1, attributes: [], box: [0, 0, 400, 120]},
      {name: 'UL', parent: 2, attributes: item('b-list', '3-7'), box: [0, 0, 400, 120]},
      {name: 'LI', parent: 3, attributes: item('b-tables', '3-6', 'modified'), box: [32, 0, 368, 100]},
      {name: 'UL', parent: 4, attributes: [], box: [32, 20, 368, 80]},
      {name: 'LI', parent: 5, attributes: item('b-alignment', '4-4', 'modified'), box: [64, 20, 336, 20]},
      {name: 'LI', parent: 5, attributes: item('b-wide', '5-6'), box: [64, 40, 336, 40]},
      {name: 'UL', parent: 7, attributes: [], box: [64, 60, 336, 20]},
      {name: 'LI', parent: 8, attributes: item('b-scroll', '6-6', 'added'), box: [96, 60, 304, 20]},
      {name: 'LI', parent: 3, attributes: item('b-other', '7-7'), box: [32, 100, 368, 20]},
    ];
    const laid = nodes.flatMap((node, index) => (node.box ? [{index, box: node.box}] : []));
    const layout = parseSnapshot({
      strings,
      documents: [{
        nodes: {nodeName: nodes.map((node) => s(node.name)), parentIndex: nodes.map((node) => node.parent), attributes: nodes.map((node) => node.attributes)},
        layout: {nodeIndex: laid.map((each) => each.index), bounds: laid.map((each) => each.box)},
      }],
    }, 800);
    const tables = layout.blocks.find((block) => block.id === 'b-tables')!;
    expect([tables.top, tables.bottom]).toEqual([0, 20]);
    expect(layout.blocks.find((block) => block.id === 'b-wide')).toMatchObject({top: 40, bottom: 60});
    const flat = tileGeometry(400, {w: 10, h: 20}, 1)!;
    expect(rowMarks(layout, flat, pageRows(flat, layout.heightCss))).toEqual(['modified', 'modified', null, 'added', null, null]);
  });

  it('plans one box row per page row, no viewport cap, each naming its tile and row in it', () => {
    const rows = planRenderedRows(LAYOUT, geometry, (index) => `tile-${index}`);
    expect(rows).toHaveLength(90);
    expect(rows.every((row) => row.type === 'box')).toBe(true);
    const box = rows.map((row) => (row.type === 'box' ? row : null)!);
    expect(box[0]!.boxes[0]).toMatchObject({imageKey: 'tile-0', cols: 131, rows: 40, leftPad: geometry.leftPad, drawPx: {w: 1703, h: 1160}});
    expect(box[39]!.boxRow).toBe(39);
    expect(box[40]!.boxes[0]!.imageKey).toBe('tile-1');
    expect(box[40]!.boxRow).toBe(0);
    expect(box[89]!.boxes[0]).toMatchObject({imageKey: 'tile-2', rows: 10});
  });

  it('draws the gutter as text: a green bar, an amber bar or a red dotted rule, three cells wide', () => {
    const rows = planRenderedRows(LAYOUT, geometry, (index) => `tile-${index}`);
    const lead = (index: number) => (rows[index]!.type === 'box' ? rows[index]!.lead : undefined)!;
    const at = (css: number) => Math.floor((css * 1.75) / 29);
    expect(lead(0).map((part) => part.text).join('')).toBe('   ');
    expect(lead(at(60))).toEqual([{text: ' ', tone: 'plain'}, {text: '▌', tone: 'after'}, {text: ' ', tone: 'plain'}]);
    expect(lead(at(1010))[1]).toEqual({text: '▌', tone: 'changed'});
    expect(lead(at(410))[1]).toEqual({text: '┆', tone: 'before'});
  });
});
