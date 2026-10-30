import {randomBytes} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import type {InspectResult, MediaBackend, RenderRequest, RenderResult} from '../src/media/backend.js';
import {planMedia, type BoxSpec} from '../src/media/layout.js';
import {createMediaService} from '../src/media/service.js';
import type {MediaRef} from '../src/media/types.js';
import type {ReviewModel} from '../src/review/model.js';
import {KITTY_CAPS, parseApc, pngFixture, sideInfo} from './media-helpers.js';
import {binaryMediaFile, buildFixture, flush} from './ui-fixtures.js';

// The media service on its own, over a scripted backend: what it sends to
// the terminal, what it asks the worker, and what it keeps.

type Answer = InspectResult | ((call: number) => InspectResult);

function scriptedBackend({inspect = {}, render}: {inspect?: Record<string, Answer>; render?: (call: number) => RenderResult} = {}) {
  const inspects: string[] = [];
  const renders: string[] = [];
  const backend: MediaBackend = {
    async inspect(request) {
      inspects.push(request.side.abbrevId);
      const answer = inspect[request.side.abbrevId];
      const count = inspects.filter((id) => id === request.side.abbrevId).length;
      if (!answer) return {ok: true, info: sideInfo({width: 200, height: 100})};
      return typeof answer === 'function' ? answer(count) : answer;
    },
    async render(request) {
      renders.push(request.sides[0]!.abbrevId);
      if (render) return render(renders.length);
      const {cols, rows, cellPx} = request.target;
      return {ok: true, png: pngFixture(cols * cellPx.w, rows * cellPx.h)};
    },
    async exportCopy() {
      return {ok: false, state: 'error', reason: 'not used'};
    },
    dispose() {},
  };
  return {backend, inspects, renders};
}

function serviceOver(backend: MediaBackend, options: Partial<Parameters<typeof createMediaService>[0]> = {}) {
  const writes: string[] = [];
  const service = createMediaService({caps: KITTY_CAPS, backend, sink: {write: (sequence) => writes.push(sequence)}, env: {}, opener: () => undefined, ...options});
  let notified = 0;
  service.subscribe(() => {
    notified += 1;
  });
  return {service, writes, notified: () => notified};
}

function review(...ids: string[]): ReviewModel {
  return buildFixture(ids.map((id, index) => binaryMediaFile(`img/${index}.png`, 'untracked', ['0000000', id]))).review;
}

const range = {cwd: '/repo', range: {includeWorktree: true}};

function boxesOf(service: ReturnType<typeof serviceOver>['service'], model: ReviewModel) {
  return model.files.flatMap((file) => {
    const ref = service.refFor(file) as MediaRef;
    const plan = planMedia(ref, {after: service.sideState(ref, 'after')}, service.viewState(ref.fileKey), {innerWidth: 100, viewportRows: 20, caps: KITTY_CAPS});
    return plan.rows.flatMap((row) => (row.type === 'box' && row.boxRow === 0 ? row.boxes.map((box) => ({fileKey: ref.fileKey, box})) : []));
  });
}

describe('media service', () => {
  it('sends nothing and asks for no re-render when a want and sweep find nothing changed, even over the byte budget', async () => {
    // Noise does not compress. The byte budget holds two of these pictures
    // and not three.
    const noise = randomBytes(200 * 100 * 4);
    const png = pngFixture(200, 100, (x, y) => {
      const at = (y * 200 + x) * 4;
      return [noise[at]!, noise[at + 1]!, noise[at + 2]!, 255];
    });
    const base64Bytes = Math.ceil(png.byteLength / 3) * 4;
    const {backend, renders} = scriptedBackend({render: () => ({ok: true, png})});
    const {service, writes, notified} = serviceOver(backend, {registry: {maxBytes: Math.floor(base64Bytes * 2.5)}});
    const model = review('1111111', '2222222', '3333333');
    service.setReview(model, range);
    await flush(4);
    const wanted = boxesOf(service, model);
    expect(wanted).toHaveLength(3);
    const live = new Set(wanted.map(({box}) => box.imageKey));
    // The first box is on screen; the other two are near it, off screen.
    const visible = new Set([wanted[0]!.box.imageKey]);

    const cycle = () => {
      service.want(wanted, visible);
      service.sweep(live, visible);
    };
    cycle();
    await flush(4);
    expect(renders).toHaveLength(3);
    // The one on screen is sent and drawn; one more fits off screen.
    expect(service.boxState(wanted[0]!.box)).toMatchObject({status: 'kitty'});
    const sent = parseApc(writes).filter((command) => command.a === 't').length;
    expect(sent).toBe(2);

    const writesBefore = writes.length;
    const notifiedBefore = notified();
    for (let round = 0; round < 10; round += 1) cycle();
    await flush(4);
    expect(writes.length).toBe(writesBefore);
    expect(notified()).toBe(notifiedBefore);
  });

  it('asks again about a side that was changing on disk when a new review names the same content', async () => {
    const {backend, inspects} = scriptedBackend({
      inspect: {
        '1111111': (call) => (call === 1
          ? {ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true}
          : {ok: true, info: sideInfo({width: 40, height: 20})}),
      },
    });
    const {service} = serviceOver(backend);
    const first = review('1111111');
    service.setReview(first, range);
    await flush(4);
    const ref = service.refFor(first.files[0]!)!;
    expect(service.sideState(ref, 'after')).toEqual({status: 'stale'});

    // The watcher's refresh: a new review object with the same id.
    const second = review('1111111');
    service.setReview(second, range);
    await flush(4);
    expect(inspects).toEqual(['1111111', '1111111']);
    expect(service.sideState(service.refFor(second.files[0]!)!, 'after')).toMatchObject({status: 'ready', info: {width: 40, height: 20}});
  });

  it('asks again about a work tree file that was gone, but never about content that failed', async () => {
    const {backend, inspects} = scriptedBackend({
      inspect: {
        '1111111': (call) => (call === 1
          ? {ok: false, state: 'error', reason: 'img/0.png no longer exists', disk: true}
          : {ok: true, info: sideInfo({width: 40, height: 20})}),
        '2222222': {ok: false, state: 'error', reason: 'not a PNG image'},
      },
    });
    const {service} = serviceOver(backend);
    service.setReview(review('1111111', '2222222'), range);
    await flush(4);
    const next = review('1111111', '2222222');
    service.setReview(next, range);
    await flush(4);
    expect(inspects).toEqual(['1111111', '2222222', '1111111']);
    expect(service.sideState(service.refFor(next.files[0]!)!, 'after')).toMatchObject({status: 'ready'});
    expect(service.sideState(service.refFor(next.files[1]!)!, 'after')).toEqual({status: 'error', reason: 'not a PNG image'});
  });

  it('renders a box again after a new review when its read caught the file mid-write', async () => {
    const {backend, renders} = scriptedBackend({
      render: (call) => (call === 1
        ? {ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true}
        : {ok: true, png: pngFixture(200, 100)}),
    });
    const {service} = serviceOver(backend);
    const first = review('1111111');
    service.setReview(first, range);
    await flush(4);
    const [wanted] = boxesOf(service, first);
    const keys = new Set([wanted!.box.imageKey]);
    service.want([wanted!], keys);
    service.sweep(keys, keys);
    await flush(4);
    expect(service.boxState(wanted!.box)).toEqual({status: 'error', reason: 'changed on disk · refreshing'});
    // Not retried while the review stays the same.
    service.want([wanted!], keys);
    await flush(4);
    expect(renders).toHaveLength(1);

    service.setReview(review('1111111'), range);
    service.want([wanted!], keys);
    service.sweep(keys, keys);
    await flush(4);
    expect(renders).toHaveLength(2);
    expect(service.boxState(wanted!.box)).toMatchObject({status: 'kitty'});
  });

  it('asks again about a side read mid-write when a refresh keeps the review, but never about content that failed', async () => {
    const {backend, inspects} = scriptedBackend({
      inspect: {
        '1111111': (call) => (call === 1
          ? {ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true}
          : {ok: true, info: sideInfo({width: 40, height: 20})}),
        '2222222': {ok: false, state: 'error', reason: 'preview unavailable: a git filter changes this file (shown as text)'},
      },
    });
    const {service, notified} = serviceOver(backend);
    const model = review('1111111', '2222222');
    service.setReview(model, range);
    await flush(4);
    const ref = service.refFor(model.files[0]!)!;
    expect(service.sideState(ref, 'after')).toEqual({status: 'stale'});

    // The file ended with the bytes it had, so the refresh found the same
    // fingerprint and set no new review.
    service.retryDisk();
    await flush(4);
    expect(inspects).toEqual(['1111111', '2222222', '1111111']);
    expect(service.sideState(ref, 'after')).toMatchObject({status: 'ready', info: {width: 40, height: 20}});

    // Nothing left to ask: another such refresh starts nothing and redraws nothing.
    const before = notified();
    service.retryDisk();
    await flush(4);
    expect(inspects).toHaveLength(3);
    expect(notified()).toBe(before);
  });

  it('asks again at once about a read that went stale while a refresh kept the review', async () => {
    const answers: Array<(result: InspectResult) => void> = [];
    const backend: MediaBackend = {
      inspect: () => new Promise<InspectResult>((resolve) => {
        answers.push(resolve);
      }),
      render: async () => ({ok: false, state: 'error', reason: 'not used'}),
      exportCopy: async () => ({ok: false, state: 'error', reason: 'not used'}),
      dispose() {},
    };
    const {service} = serviceOver(backend);
    const model = review('1111111');
    service.setReview(model, range);
    await flush(2);
    expect(answers).toHaveLength(1);
    // The refresh ran while the read waited to read again.
    service.retryDisk();
    answers[0]!({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
    await flush(2);
    expect(answers).toHaveLength(2);
    answers[1]!({ok: true, info: sideInfo({width: 40, height: 20})});
    await flush(2);
    expect(service.sideState(service.refFor(model.files[0]!)!, 'after')).toMatchObject({status: 'ready'});
  });

  it('renders a box again at once when its read went stale while a refresh kept the review', async () => {
    const answers: Array<(result: RenderResult) => void> = [];
    const backend: MediaBackend = {
      inspect: async () => ({ok: true, info: sideInfo({width: 200, height: 100})}),
      render: () => new Promise<RenderResult>((resolve) => {
        answers.push(resolve);
      }),
      exportCopy: async () => ({ok: false, state: 'error', reason: 'not used'}),
      dispose() {},
    };
    const {service, notified} = serviceOver(backend);
    const model = review('1111111');
    service.setReview(model, range);
    await flush(2);
    const [wanted] = boxesOf(service, model);
    const keys = new Set([wanted!.box.imageKey]);
    service.want([wanted!], keys);
    service.sweep(keys, keys);
    expect(answers).toHaveLength(1);
    service.retryDisk();
    const before = notified();
    answers[0]!({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
    await flush(2);
    // Not kept as the box's failure, and a redraw is asked for.
    expect(service.boxState(wanted!.box)).toEqual({status: 'loading'});
    expect(notified()).toBeGreaterThan(before);
    service.want([wanted!], keys);
    expect(answers).toHaveLength(2);
    answers[1]!({ok: true, png: pngFixture(200, 100)});
    await flush(2);
    expect(service.boxState(wanted!.box)).toMatchObject({status: 'kitty'});
  });

  it('renders a box again when a refresh keeps the review after its read caught the file mid-write', async () => {
    const {backend, renders} = scriptedBackend({
      render: (call) => (call === 1
        ? {ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true}
        : {ok: true, png: pngFixture(200, 100)}),
    });
    const {service} = serviceOver(backend);
    const model = review('1111111');
    service.setReview(model, range);
    await flush(4);
    const [wanted] = boxesOf(service, model);
    const keys = new Set([wanted!.box.imageKey]);
    service.want([wanted!], keys);
    service.sweep(keys, keys);
    await flush(4);
    expect(service.boxState(wanted!.box)).toEqual({status: 'error', reason: 'changed on disk · refreshing'});

    service.retryDisk();
    service.want([wanted!], keys);
    service.sweep(keys, keys);
    await flush(4);
    expect(renders).toHaveLength(2);
    expect(service.boxState(wanted!.box)).toMatchObject({status: 'kitty'});
  });

  it('sends a box on screen once an id leaves quarantine, when every id was taken', async () => {
    const {backend} = scriptedBackend();
    const {service, notified} = serviceOver(backend, {registry: {quarantineMs: 60}});
    const model = review('1111111');
    service.setReview(model, range);
    await flush(4);
    const [base] = boxesOf(service, model);
    // As many boxes as there are ids: each settled resize is a new geometry,
    // so a new key and a new id.
    const taken = Array.from({length: 255}, (_, index) => ({...base!, box: {...base!.box, imageKey: `${base!.box.imageKey}#${index}`}}));
    const all = new Set(taken.map(({box}) => box.imageKey));
    service.want(taken, all);
    service.sweep(all, all);
    await flush(4);
    expect(taken.every(({box}) => service.boxState(box).status === 'kitty')).toBe(true);

    // Those boxes leave the screen; their ids sit in quarantine. The next box
    // finds no free id.
    const next = {...base!, box: {...base!.box, imageKey: `${base!.box.imageKey}#next`}};
    const shown = new Set([next.box.imageKey]);
    service.sweep(shown, shown);
    service.want([next], shown);
    await flush(4);
    expect(service.boxState(next.box)).toEqual({status: 'loading'});

    // Nothing else redraws this session; the service asks for a redraw once
    // an id is free, and the want after it sends the box.
    const before = notified();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(notified()).toBeGreaterThan(before);
    service.want([next], shown);
    expect(service.boxState(next.box)).toMatchObject({status: 'kitty'});
    service.dispose();
  });

  it('says a restart shows a changed file when nothing watches the repo', async () => {
    const {backend} = scriptedBackend({render: () => ({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true})});
    const {service} = serviceOver(backend, {watching: false});
    expect(service.watching).toBe(false);
    const model = review('1111111');
    service.setReview(model, range);
    await flush(4);
    const [wanted] = boxesOf(service, model);
    const keys = new Set([wanted!.box.imageKey]);
    service.want([wanted!], keys);
    service.sweep(keys, keys);
    await flush(4);
    expect(service.boxState(wanted!.box as BoxSpec)).toEqual({status: 'error', reason: 'changed on disk · restart to see it'});
  });
});

// Compare modes: a session-wide choice of view for modified images, a flip
// side per file, and the difference rendered from both sides.
describe('media service compare modes', () => {
  function modifiedReview(...pairs: Array<[string, string]>): ReviewModel {
    return buildFixture(pairs.map(([before, after], index) => binaryMediaFile(`img/${index}.png`, 'modified', [before, after]))).review;
  }

  function planOf(service: ReturnType<typeof serviceOver>['service'], ref: MediaRef) {
    return planMedia(
      ref,
      {before: service.sideState(ref, 'before'), after: service.sideState(ref, 'after')},
      service.viewState(ref.fileKey),
      {innerWidth: 100, viewportRows: 20, caps: KITTY_CAPS},
      service.drawnFacts(ref),
    );
  }

  it('keeps the compare mode for every file and across reviews, and the flip side per file until reset', async () => {
    const {backend} = scriptedBackend();
    const {service, notified} = serviceOver(backend);
    const model = modifiedReview(['1111111', '2222222'], ['3333333', '4444444']);
    service.setReview(model, range);
    const [first, second] = model.files.map((file) => service.refFor(file) as MediaRef);
    expect(service.viewState(first!.fileKey)).toEqual({compare: 'sideBySide', flipSide: 'after', textView: false});

    const plans = service.planVersion();
    const before = notified();
    service.setCompare('flip');
    expect(service.planVersion()).toBeGreaterThan(plans);
    expect(notified()).toBeGreaterThan(before);
    expect(service.viewState(first!.fileKey).compare).toBe('flip');
    expect(service.viewState(second!.fileKey).compare).toBe('flip');

    // The same mode again changes nothing.
    const unchanged = service.planVersion();
    service.setCompare('flip');
    expect(service.planVersion()).toBe(unchanged);

    service.swapFlip(first!.fileKey);
    expect(service.viewState(first!.fileKey).flipSide).toBe('before');
    expect(service.viewState(second!.fileKey).flipSide).toBe('after');
    service.swapFlip(first!.fileKey);
    expect(service.viewState(first!.fileKey).flipSide).toBe('after');
    service.swapFlip(first!.fileKey);

    // A refresh keeps both the mode and the side.
    service.setReview(modifiedReview(['1111111', '2222222'], ['3333333', '5555555']), range);
    expect(service.viewState(first!.fileKey)).toMatchObject({compare: 'flip', flipSide: 'before'});

    service.resetFlip();
    expect(service.viewState(first!.fileKey)).toMatchObject({compare: 'flip', flipSide: 'after'});
    // Nothing to reset: no new plan.
    const reset = service.planVersion();
    service.resetFlip();
    expect(service.planVersion()).toBe(reset);
  });

  it('shows the flip side, the before side of a deleted file, and otherwise the after side', () => {
    const {backend} = scriptedBackend();
    const {service} = serviceOver(backend);
    const model = buildFixture([
      binaryMediaFile('img/m.png', 'modified', ['1111111', '2222222']),
      binaryMediaFile('img/d.png', 'deleted', ['3333333', '0000000']),
    ]).review;
    service.setReview(model, range);
    const [modified, deleted] = model.files.map((file) => service.refFor(file) as MediaRef);
    expect(service.shownSide(modified!)).toBe('after');
    expect(service.shownSide(deleted!)).toBe('before');
    service.setCompare('flip');
    service.swapFlip(modified!.fileKey);
    expect(service.shownSide(modified!)).toBe('before');
    // Flipping means nothing for a file with one side.
    expect(service.shownSide(deleted!)).toBe('before');
  });

  it('renders the difference from both sides once both are inspected, and keeps the changed ratio for the label', async () => {
    const requests: RenderRequest[] = [];
    const backend: MediaBackend = {
      ...scriptedBackend().backend,
      async render(request) {
        requests.push(request);
        const {cols, rows, cellPx} = request.target;
        return {ok: true, png: pngFixture(cols * cellPx.w, rows * cellPx.h), changedRatio: 0.31};
      },
    };
    const {service, writes} = serviceOver(backend);
    const model = modifiedReview(['1111111', '2222222']);
    service.setReview(model, range);
    service.setCompare('difference');
    const ref = service.refFor(model.files[0]!) as MediaRef;
    await flush(4);

    const plan = planOf(service, ref);
    const box = plan.rows.find((row): row is Extract<typeof row, {type: 'box'}> => row.type === 'box')!.boxes[0]!;
    expect(box).toMatchObject({role: 'diff', op: 'difference'});
    const keys = new Set([box.imageKey]);
    const plans = service.planVersion();
    service.want([{fileKey: ref.fileKey, box}], keys);
    service.sweep(keys, keys);
    await flush(4);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({op: 'difference', kind: 'raster', format: 'png'});
    expect(requests[0]!.sides.map((side) => [side.side, side.abbrevId])).toEqual([['before', '1111111'], ['after', '2222222']]);
    expect(service.boxState(box)).toMatchObject({status: 'kitty'});
    expect(parseApc(writes).filter((command) => command.a === 't')).toHaveLength(1);
    expect(service.drawnFacts(ref)).toEqual({changedRatio: 0.31});
    // The label changes, so the rows are built again.
    expect(service.planVersion()).toBeGreaterThan(plans);
    expect(planOf(service, ref).rows.length).toBe(plan.rows.length);
  });

  it('waits for both sides before rendering a difference, and never renders one with a failed side', async () => {
    const gate: {open?: () => void} = {};
    const {backend, renders} = scriptedBackend({inspect: {
      '1111111': () => ({ok: false, state: 'error', reason: 'could not decode image'}),
    }});
    const slow: MediaBackend = {
      ...backend,
      async inspect(request, signal) {
        if (request.side.abbrevId === '2222222') await new Promise<void>((resolve) => { gate.open = resolve; });
        return backend.inspect(request, signal);
      },
    };
    const {service} = serviceOver(slow);
    const model = modifiedReview(['1111111', '2222222']);
    service.setReview(model, range);
    service.setCompare('difference');
    const ref = service.refFor(model.files[0]!) as MediaRef;
    await flush(4);
    // A diff box with the after side still pending: nothing to render.
    const box: BoxSpec = {imageKey: `${ref.contentKey}|diff|10x5|10x20`, role: 'diff', cols: 10, rows: 5, leftPad: 0, drawPx: {w: 100, h: 100}, nearest: false, op: 'difference'};
    const keys = new Set([box.imageKey]);
    service.want([{fileKey: ref.fileKey, box}], keys);
    await flush(4);
    expect(renders).toEqual([]);

    gate.open!();
    await flush(4);
    service.want([{fileKey: ref.fileKey, box}], keys);
    await flush(4);
    expect(renders).toEqual([]);
  });
});
