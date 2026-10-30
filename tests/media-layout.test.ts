import {describe, expect, it} from 'vitest';
import {fitBox, planMedia, planRowText, type Layout, type MediaPlan, type PlanRow} from '../src/media/layout.js';
import {NO_GRAPHICS, type GraphicsCaps, type MediaRef, type MediaViewState, type SideInfo, type SideState} from '../src/media/types.js';

// Box sizes come from the image's pixel size and the pane; row plans come
// from what is known about each side and the view. Neither ever depends on
// whether pixels have been drawn yet.

const KITTY: GraphicsCaps = {...NO_GRAPHICS, protocol: 'kitty', cellPx: {w: 10, h: 20}, cellPxSource: 'csi16', colorDepth: 3};
const BLOCKS: GraphicsCaps = {...KITTY, protocol: 'blocks'};
const VIEW: MediaViewState = {compare: 'sideBySide', flipSide: 'after', textView: false};

function side(side: 'before' | 'after', id: string, source: 'blob' | 'worktree' = 'blob') {
  return {side, source, path: 'img/a.png', abbrevId: id, key: `${source}|img/a.png|${id}`};
}

function ref(kind: MediaRef['kind'], sides: {before?: boolean; after?: boolean}, format: MediaRef['format'] = kind === 'video' ? 'mp4' : kind === 'svg' ? 'svg' : 'png'): MediaRef {
  const before = sides.before ? side('before', '029ace0') : undefined;
  const after = sides.after ? side('after', '97fa3ee') : undefined;
  return {
    fileKey: 'img/a.png',
    kind,
    format,
    ...(before ? {before} : {}),
    ...(after ? {after} : {}),
    hasSourceBlocks: false,
    contentKey: `${format}|${before?.key ?? '-'}|${after?.key ?? '-'}`,
  };
}

function info(width: number, height: number, extra: Partial<SideInfo> = {}): SideInfo {
  return {oid: 'f'.repeat(40), bytes: 232_000, format: 'png', width, height, frames: 1, hasAlpha: false, ...extra};
}

const ready = (width: number, height: number, extra: Partial<SideInfo> = {}): SideState => ({status: 'ready', info: info(width, height, extra)});
const layout = (innerWidth: number, viewportRows: number, caps = KITTY): Layout => ({innerWidth, viewportRows, caps});

function boxRows(plan: MediaPlan) {
  return plan.rows.filter((row): row is Extract<PlanRow, {type: 'box'}> => row.type === 'box');
}

function texts(plan: MediaPlan, width = 80) {
  return plan.rows.map((row) => planRowText(row, width));
}

describe('fitBox', () => {
  it('shrinks a large image to the pane and keeps its aspect ratio', () => {
    const box = fitBox({w: 2000, h: 1000}, 80, 30, KITTY);
    expect(box).toMatchObject({cols: 80, rows: 20, drawPx: {w: 800, h: 400}, nearest: false, scale: 0.4, upscale: 1});
    expect(box.leftPad).toBe(0);
  });

  it('is capped by the rows available, then centred in the columns', () => {
    const box = fitBox({w: 1000, h: 1000}, 80, 10, KITTY);
    expect(box).toMatchObject({cols: 20, rows: 10, drawPx: {w: 200, h: 200}});
    expect(box.leftPad).toBe(30);
  });

  it('shows an image that fits at its own size, rounding the box up to whole cells', () => {
    const box = fitBox({w: 470, h: 301}, 80, 30, KITTY);
    expect(box).toMatchObject({cols: 47, rows: 16, drawPx: {w: 470, h: 301}, scale: 1, upscale: 1, nearest: false});
    expect(box.drawPx.w).toBeLessThanOrEqual(box.cols * 10);
    expect(box.drawPx.h).toBeLessThanOrEqual(box.rows * 20);
  });

  it('rounds a box up to the next whole cell, never to the nearest', () => {
    // 81 px is 8.1 cells of 10 px: eight cells would crop the last pixel.
    expect(fitBox({w: 81, h: 20}, 80, 30, KITTY)).toMatchObject({cols: 9, rows: 1, drawPx: {w: 81, h: 20}, scale: 1, upscale: 1});
  });

  it('upscales a tiny icon by a whole factor, nearest-neighbour, within the caps', () => {
    expect(fitBox({w: 16, h: 16}, 80, 30, KITTY)).toMatchObject({upscale: 5, nearest: true, drawPx: {w: 80, h: 80}, cols: 8, rows: 4});
    expect(fitBox({w: 4, h: 4}, 80, 30, KITTY)).toMatchObject({upscale: 8, drawPx: {w: 32, h: 32}});
    // The rows cap holds the factor down.
    expect(fitBox({w: 10, h: 40}, 80, 3, KITTY)).toMatchObject({upscale: 1, nearest: false, drawPx: {w: 10, h: 40}, rows: 2});
    expect(fitBox({w: 10, h: 30}, 80, 3, KITTY)).toMatchObject({upscale: 2, nearest: true, drawPx: {w: 20, h: 60}, rows: 3});
  });

  it('never makes a box bigger than the 297 cells the placeholder table can address', () => {
    const box = fitBox({w: 10_000, h: 10_000}, 1000, 1000, {...KITTY, cellPx: {w: 2, h: 2}});
    expect(box.cols).toBeLessThanOrEqual(297);
    expect(box.rows).toBeLessThanOrEqual(297);
    expect(box.cols).toBe(297);
  });

  it('always gives at least one cell', () => {
    expect(fitBox({w: 4000, h: 1}, 10, 10, KITTY)).toMatchObject({cols: 10, rows: 1});
    expect(fitBox({w: 1, h: 4000}, 10, 10, KITTY)).toMatchObject({cols: 1, rows: 10});
  });

  it('sizes a block preview in square half-cells within 60 × 20', () => {
    expect(fitBox({w: 1100, h: 704}, 100, 40, BLOCKS)).toMatchObject({cols: 60, rows: 19, drawPx: {w: 60, h: 38}});
    expect(fitBox({w: 400, h: 1000}, 100, 40, BLOCKS)).toMatchObject({rows: 20, cols: 16});
    // Never past the source's own pixels, except tiny images up to 8 columns.
    expect(fitBox({w: 30, h: 20}, 100, 40, BLOCKS)).toMatchObject({cols: 30, rows: 10, nearest: false});
    expect(fitBox({w: 4, h: 4}, 100, 40, BLOCKS)).toMatchObject({cols: 8, rows: 4, nearest: true});
  });
});

describe('planMedia', () => {
  it('shows an added image as a label row and its box, capped to the viewport minus the label row', () => {
    const plan = planMedia(ref('raster', {after: true}), {after: ready(2000, 2000)}, VIEW, layout(100, 30));
    expect(plan.rows[0]).toMatchObject({type: 'text', role: 'label'});
    expect(planRowText(plan.rows[0]!, 100)).toMatch(/^after\s+560 × 560 px shown$/);
    const boxes = boxRows(plan);
    expect(boxes).toHaveLength(28);
    expect(boxes.map((row) => row.boxRow)).toEqual([...Array(28).keys()]);
    expect(boxes[0]!.boxes).toEqual([expect.objectContaining({
      imageKey: 'png|-|blob|img/a.png|97fa3ee|after|56x28|10x20',
      role: 'after',
      side: 'after',
      cols: 56,
      rows: 28,
      leftPad: 22,
      drawPx: {w: 560, h: 560},
      op: 'fit',
    })]);
  });

  it('labels a deleted image before, and says when it is shown at its own size or upscaled', () => {
    const deleted = planMedia(ref('raster', {before: true}), {before: ready(300, 200)}, VIEW, layout(100, 30));
    expect(planRowText(deleted.rows[0]!, 60)).toMatch(/^before\s+shown at 100%$/);
    expect(deleted.rows[0]).toMatchObject({pieces: [{at: 0, parts: [{text: 'before', tone: 'before'}]}]});

    const icon = planMedia(ref('raster', {after: true}), {after: ready(16, 16)}, VIEW, layout(100, 30));
    expect(planRowText(icon.rows[0]!, 60)).toMatch(/shown at 5×$/);
  });

  it('is one loading row while the size is unknown, and one reason row on a failure', () => {
    const r = ref('raster', {after: true});
    expect(texts(planMedia(r, {after: {status: 'pending'}}, VIEW, layout(100, 30)))).toEqual([expect.stringMatching(/loading preview…/)]);
    const failed = planMedia(r, {after: {status: 'error', reason: 'not a PNG image'}}, VIEW, layout(100, 30));
    expect(failed.rows).toEqual([expect.objectContaining({type: 'text', role: 'reason'})]);
    expect(texts(failed)).toEqual([expect.stringMatching(/^not a PNG image/)]);
    expect(texts(planMedia(r, {after: {status: 'stale'}}, VIEW, layout(100, 30)))).toEqual([expect.stringMatching(/changed on disk · refreshing/)]);
  });

  it('puts a tab row with click spans above a modified image', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: ready(1280, 400), after: ready(1280, 480)}, VIEW, layout(100, 30));
    expect(planRowText(plan.rows[0]!, 100)).toBe('[1 Side by side]  2 Flip  3 Difference');
    const spans = (plan.rows[0] as Extract<PlanRow, {type: 'text'}>).spans!;
    expect(spans.map((span) => span.id)).toEqual(['compare.sideBySide', 'compare.flip', 'compare.difference']);
    const tab = planRowText(plan.rows[0]!, 100);
    for (const span of spans) expect(tab.slice(span.start, span.end)).toMatch(/^\[?\d [A-Z]/);
  });

  it('puts the two sides of a modified image side by side on the same rows, the shorter one top-aligned', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: ready(1280, 400), after: ready(1280, 480)}, VIEW, layout(100, 30));
    const label = planRowText(plan.rows[1]!, 100);
    expect(label.indexOf('before')).toBe(0);
    expect(label.indexOf('after')).toBe(51);
    const boxes = boxRows(plan);
    const [left, right] = boxes[0]!.boxes!;
    expect(left).toMatchObject({role: 'before', cols: 48, leftPad: 0});
    expect(right).toMatchObject({role: 'after', cols: 48, leftPad: 51});
    expect(boxes).toHaveLength(Math.max(left!.rows, right!.rows));
    expect(right!.rows).toBeGreaterThan(left!.rows);
    expect(boxes.every((row) => row.boxes!.length === 2)).toBe(true);
  });

  it('caps side-by-side boxes at the viewport minus the tab and label rows and a spacer', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: ready(400, 2000), after: ready(400, 2000)}, VIEW, layout(100, 30));
    const boxes = boxRows(plan);
    expect(boxes).toHaveLength(27);
    expect(boxes[0]!.boxes!.map((box) => box.rows)).toEqual([27, 27]);
  });

  it('caps each stacked side at half the viewport left after the tab and two label rows', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: ready(400, 2000), after: ready(400, 2000)}, VIEW, layout(34, 30));
    const roles = boxRows(plan).map((row) => row.boxes!.map((box) => box.role).join(','));
    expect(roles.filter((role) => role === 'before')).toHaveLength(13);
    expect(roles.filter((role) => role === 'after')).toHaveLength(13);
  });

  it('stacks the two sides when a half would be narrower than 16 columns', () => {
    const sides = {before: ready(1280, 400), after: ready(1280, 480)};
    const wide = planMedia(ref('raster', {before: true, after: true}), sides, VIEW, layout(35, 30));
    expect(boxRows(wide)[0]!.boxes).toHaveLength(2);

    const narrow = planMedia(ref('raster', {before: true, after: true}), sides, VIEW, layout(34, 30));
    const rows = narrow.rows.map((row) => row.type === 'box' ? `box:${row.boxes!.map((box) => box.role).join(',')}` : (row as {role: string}).role);
    expect(rows[0]).toBe('tabs');
    expect(rows[1]).toBe('label');
    const firstAfterLabel = rows.indexOf('label', 2);
    expect(rows.slice(2, firstAfterLabel).every((row) => row === 'box:before')).toBe(true);
    expect(rows.slice(firstAfterLabel + 1).every((row) => row === 'box:after')).toBe(true);
    expect(rows.slice(firstAfterLabel + 1).length).toBeLessThanOrEqual(13);
  });

  it('gives both flip sides one shared box, so swapping only changes the id, and prefetches the hidden side', () => {
    const r = ref('raster', {before: true, after: true});
    const sides = {before: ready(1280, 400), after: ready(800, 600)};
    const afterPlan = planMedia(r, sides, {...VIEW, compare: 'flip'}, layout(100, 30));
    const beforePlan = planMedia(r, sides, {...VIEW, compare: 'flip', flipSide: 'before'}, layout(100, 30));

    const shown = boxRows(afterPlan)[0]!.boxes![0]!;
    const hidden = afterPlan.prefetch[0]!;
    expect(shown.role).toBe('after');
    expect(hidden.role).toBe('before');
    expect([shown.cols, shown.rows, shown.leftPad]).toEqual([hidden.cols, hidden.rows, hidden.leftPad]);
    expect(shown.drawPx).not.toEqual(hidden.drawPx);
    expect(afterPlan.rows.length).toBe(beforePlan.rows.length);
    expect(boxRows(beforePlan)[0]!.boxes![0]!.imageKey).toBe(hidden.imageKey);
    expect(planRowText(afterPlan.rows[1]!, 100)).toMatch(/^after · 2 or click swaps/);
    expect(boxRows(afterPlan).every((row) => row.swap)).toBe(true);
  });

  it('centres the shared flip box in the pane', () => {
    const r = ref('raster', {before: true, after: true});
    const plan = planMedia(r, {before: ready(400, 300), after: ready(300, 400)}, {...VIEW, compare: 'flip'}, layout(100, 30));
    const shown = boxRows(plan)[0]!.boxes![0]!;
    // 40 × 15 and 30 × 20 cells share a 40 × 20 box.
    expect(shown).toMatchObject({cols: 40, rows: 20, leftPad: Math.floor((100 - 40) / 2)});
    expect(plan.prefetch[0]).toMatchObject({cols: 40, rows: 20, leftPad: 30});
  });

  it('caps the flip and difference boxes at the viewport minus the tab and label rows and a spacer', () => {
    const r = ref('raster', {before: true, after: true});
    const tall = {before: ready(400, 2000), after: ready(400, 2000)};
    for (const compare of ['flip', 'difference'] as const) {
      const boxes = boxRows(planMedia(r, tall, {...VIEW, compare}, layout(100, 30)));
      expect(boxes, compare).toHaveLength(27);
      expect(boxes[0]!.boxes![0]!.rows, compare).toBe(27);
    }
  });

  it('fits the difference box to the larger of each side, not to the after image alone', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: ready(1280, 400), after: ready(1000, 480)}, {...VIEW, compare: 'difference'}, layout(100, 30));
    // A 1280 × 480 canvas in 100 columns: scaled by 1000/1280.
    expect(boxRows(plan)[0]!.boxes![0]).toMatchObject({cols: 100, rows: 19, drawPx: {w: 1000, h: 375}});
  });

  it('draws the difference as one image of the larger canvas, noting sizes that differ', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: ready(1280, 400), after: ready(1000, 480)}, {...VIEW, compare: 'difference'}, layout(100, 30));
    const box = boxRows(plan)[0]!.boxes![0]!;
    expect(box).toMatchObject({role: 'diff', op: 'difference'});
    expect(box.imageKey).toContain('|diff|');
    expect(planRowText(plan.rows[1]!, 100)).toMatch(/^difference\s+changed pixels marked · sizes differ, aligned top-left/);
  });

  it('says how much of the image changed once the difference is drawn, and when no pixel did', () => {
    const r = ref('raster', {before: true, after: true});
    const same = {before: ready(1280, 400), after: ready(1280, 400)};
    const view = {...VIEW, compare: 'difference' as const};
    const pending = planMedia(r, same, view, layout(100, 30));
    expect(planRowText(pending.rows[1]!, 100)).toMatch(/^difference\s+changed pixels marked$/);

    const drawn = planMedia(r, same, view, layout(100, 30), {changedRatio: 0.31});
    expect(planRowText(drawn.rows[1]!, 100)).toMatch(/^difference\s+changed pixels marked · 31% of the image$/);
    // A sliver of change never reads as none.
    const sliver = planMedia(r, same, view, layout(100, 30), {changedRatio: 0.001});
    expect(planRowText(sliver.rows[1]!, 100)).toMatch(/changed pixels marked · under 1% of the image$/);

    const none = planMedia(r, same, view, layout(100, 30), {changedRatio: 0});
    expect(planRowText(none.rows[1]!, 100)).toMatch(/^difference\s+no visible pixel change \(bytes differ\)$/);

    const sized = planMedia(r, {before: ready(1280, 400), after: ready(1000, 480)}, view, layout(100, 30), {changedRatio: 0.5});
    expect(planRowText(sized.rows[1]!, 100)).toMatch(/changed pixels marked · 50% of the image · sizes differ, aligned top-left$/);
    // The ratio changes only the label: the rows and boxes stay the same.
    expect(drawn.rows.length).toBe(pending.rows.length);
    expect(boxRows(drawn)[0]!.boxes).toEqual(boxRows(pending)[0]!.boxes);
  });

  it('falls back to the available side when the other one failed', () => {
    const plan = planMedia(ref('raster', {before: true, after: true}), {before: {status: 'error', reason: 'could not decode image'}, after: ready(500, 300)}, {...VIEW, compare: 'difference'}, layout(100, 30));
    expect(boxRows(plan)[0]!.boxes!.map((box) => box.role)).toEqual(['after']);
    expect(planRowText(plan.rows[1]!, 100)).toContain('could not decode image');
  });

  it('uses the blocks op and label for a block preview', () => {
    const plan = planMedia(ref('raster', {after: true}), {after: ready(1100, 704)}, VIEW, layout(100, 30, BLOCKS));
    expect(boxRows(plan)[0]!.boxes![0]).toMatchObject({op: 'blocks', cols: 60, rows: 19});
    expect(planRowText(plan.rows[0]!, 100)).toContain('block preview · 60 × 19 cells · o opens the real image');
    const diff = planMedia(ref('raster', {before: true, after: true}), {before: ready(100, 100), after: ready(100, 100)}, {...VIEW, compare: 'difference'}, layout(100, 30, BLOCKS));
    expect(boxRows(diff)[0]!.boxes![0]!.op).toBe('blocksDifference');
  });

  it('labels an SVG picture as rendered from its source', () => {
    const plan = planMedia(ref('svg', {after: true}), {after: ready(300, 150, {format: 'svg'})}, VIEW, layout(100, 30));
    expect(planRowText(plan.rows[0]!, 100)).toMatch(/^picture · rendered from the SVG source/);
  });

  it('names a modified SVG\'s sides before and after in every compare mode', () => {
    const r = ref('svg', {before: true, after: true});
    const sides = {before: ready(300, 150, {format: 'svg'}), after: ready(300, 150, {format: 'svg'})};
    const label = (compare: MediaViewState['compare'], flipSide: MediaViewState['flipSide'] = 'after') => planRowText(planMedia(r, sides, {...VIEW, compare, flipSide}, layout(100, 30)).rows[1]!, 100);
    expect(label('sideBySide')).toMatch(/^before 300 × 150 · 232 KB\s+after 300 × 150 · 232 KB$/);
    expect(label('flip')).toMatch(/^after · 2 or click swaps/);
    expect(label('flip', 'before')).toMatch(/^before · 2 or click swaps/);
    expect(label('difference')).toMatch(/^difference/);
    // A side alone keeps the picture label.
    const failed = planMedia(r, {before: {status: 'error', reason: 'could not decode image'}, after: sides.after}, VIEW, layout(100, 30));
    expect(planRowText(failed.rows[1]!, 100)).toMatch(/^after · rendered from the SVG source · before: could not decode image/);
  });

  it('shows a details table and no picture in the text view', () => {
    const raster = planMedia(ref('raster', {before: true, after: true}), {before: ready(1280, 400), after: ready(1280, 480, {bytes: 102_000})}, {...VIEW, textView: true}, layout(100, 30));
    expect(boxRows(raster)).toEqual([]);
    expect(raster.textView).toBe(true);
    const lines = texts(raster, 100);
    expect(lines.some((line) => /format\s+PNG/.test(line))).toBe(true);
    expect(lines.some((line) => /pixels\s+1280 × 400 → 1280 × 480/.test(line))).toBe(true);
    expect(lines.some((line) => /ids\s+029ace0 → 97fa3ee/.test(line))).toBe(true);

    const svg = planMedia(ref('svg', {after: true}), {after: ready(300, 150, {format: 'svg'})}, {...VIEW, textView: true}, layout(100, 30));
    expect(svg.rows).toEqual([]);
  });

  it('picks four video frames when there is room and two otherwise', () => {
    const r = ref('video', {before: true, after: true});
    const sides = {before: ready(1920, 1080), after: ready(1920, 1080)};
    const stripOf = (width: number) => boxRows(planMedia(r, sides, VIEW, layout(width, 40)))[0]!.boxes![0]!;
    expect(stripOf(51)).toMatchObject({frames: 4, role: 'strip-before', op: 'video'});
    expect(stripOf(50)).toMatchObject({frames: 2});
    const strip = stripOf(100);
    // 4 frames of 24 columns with 1-column gaps.
    expect(strip.cols).toBe(99);
    expect(strip.rows).toBe(clampRows(Math.round((24 * 9 / 16) * 10 / 20)));
  });

  it('keeps a video strip between 3 and 12 rows tall', () => {
    const r = ref('video', {before: true, after: true});
    const sides = {before: ready(1920, 1080), after: ready(1920, 1080)};
    const stripOf = (width: number) => boxRows(planMedia(r, sides, VIEW, layout(width, 40)))[0]!.boxes![0]!;
    // 4 frames of 49 columns would want 14 rows.
    expect(stripOf(200)).toMatchObject({frames: 4, rows: 12});
    // 2 frames of 7 columns would want 2.
    expect(stripOf(16)).toMatchObject({frames: 2, rows: 3});
  });

  it('keeps the same rows whether video metadata is still coming, arrived or failed', () => {
    const r = ref('video', {before: true, after: true});
    const counts = [undefined, null, {durationMs: 42_000, width: 1920, height: 1080, codec: 'h264', fps: 30}].map((video) => {
      const plan = planMedia(r, {before: ready(1920, 1080, {video}), after: ready(1920, 1080, {video})}, VIEW, layout(100, 40));
      return plan.rows.map((row) => row.type);
    });
    expect(counts[1]).toEqual(counts[0]);
    expect(counts[2]).toEqual(counts[0]);
  });

  it('keeps the same rows for an image however its render goes, since the plan never sees it', () => {
    const r = ref('raster', {before: true, after: true});
    const sides = {before: ready(1280, 400), after: ready(1280, 480)};
    for (const compare of ['sideBySide', 'flip', 'difference'] as const) {
      const first = planMedia(r, sides, {...VIEW, compare}, layout(100, 30));
      const again = planMedia(r, sides, {...VIEW, compare}, layout(100, 30));
      expect(again).toEqual(first);
    }
  });
});

function clampRows(rows: number) {
  return Math.min(12, Math.max(3, rows));
}
