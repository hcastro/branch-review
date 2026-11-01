import {describe, expect, it} from 'vitest';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import {parseApc, pngFixture, pngHeaderOnly} from './media-helpers.js';

// Terminal image ids: which image key each id names, when it is sent, and
// when it is deleted. One id names one key for its whole life, and a deleted
// id waits out a quarantine before it names anything else.

function registry(options: {maxLive?: number; maxBytes?: number; quarantineMs?: number; random?: () => number} = {}) {
  const writes: string[] = [];
  let now = 1_000;
  const instance = createImageRegistry({write: (seq) => writes.push(seq), now: () => now, random: () => 0, ...options});
  return {
    instance,
    writes,
    commands: () => parseApc(writes),
    advance(ms: number) {
      now += ms;
    },
  };
}

const PNG = pngFixture(2, 2);

describe('image registry', () => {
  it('sends each key once however often it is acquired, transmit first then place', () => {
    const {instance, commands, writes} = registry();
    const ids = new Set<number | null>();
    for (let render = 0; render < 20; render += 1) {
      ids.add(instance.acquire('a|after|4x2|10x20', PNG, 4, 2));
      instance.touch('a|after|4x2|10x20');
    }
    expect(ids.size).toBe(1);
    const [id] = [...ids];
    expect(writes).toHaveLength(1);
    expect(commands().map((command) => [command.a, command.i])).toEqual([['t', id], ['p', id]]);
    expect(commands()[1]).toMatchObject({U: 1, c: 4, r: 2, q: 2});
    expect(instance.idFor('a|after|4x2|10x20')).toBe(id);
  });

  it('hands out ids from 1 to 255 and never one that is live or in quarantine', () => {
    const {instance, advance} = registry({maxLive: 300, random: () => 0.999});
    const ids = new Set<number>();
    for (let key = 0; key < 255; key += 1) {
      const id = instance.acquire(`k${key}`, PNG, 1, 1);
      expect(id).not.toBeNull();
      ids.add(id!);
    }
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({length: 255}, (_, index) => index + 1));
    expect(instance.acquire('one-more', PNG, 1, 1)).toBeNull();

    const freed = instance.idFor('k7')!;
    instance.release('k7');
    // Free but quarantined: nothing to hand out yet.
    expect(instance.acquire('one-more', PNG, 1, 1)).toBeNull();
    advance(1_999);
    expect(instance.acquire('one-more', PNG, 1, 1)).toBeNull();
    advance(1);
    expect(instance.acquire('one-more', PNG, 1, 1)).toBe(freed);
  });

  it('does not reuse a released id within the quarantine even with others free', () => {
    const {instance, advance} = registry();
    const first = instance.acquire('a', PNG, 1, 1)!;
    instance.release('a');
    const seen: number[] = [];
    for (let key = 0; key < 254; key += 1) seen.push(instance.acquire(`k${key}`, PNG, 1, 1)!);
    expect(seen).not.toContain(first);
    advance(2_000);
    expect(instance.acquire('late', PNG, 1, 1)).toBe(first);
  });

  it('deletes a key the commit stopped referencing, with d=I', () => {
    const {instance, commands} = registry();
    const kept = instance.acquire('kept', PNG, 1, 1)!;
    const gone = instance.acquire('gone', PNG, 1, 1)!;
    instance.sweep(new Set(['kept']), new Set(['kept']));
    expect(instance.idFor('gone')).toBeUndefined();
    expect(instance.idFor('kept')).toBe(kept);
    expect(commands().filter((command) => command.a === 'd')).toEqual([{a: 'd', d: 'I', i: gone, q: 2, payloadBytes: 0}]);
  });

  it('evicts only least recently used keys outside the window when over budget', () => {
    const {instance} = registry({maxLive: 3});
    for (const key of ['a', 'b', 'c']) instance.acquire(key, PNG, 1, 1);
    instance.touch('a');
    // A fourth key is sent at once; the sweep after the commit trims the
    // oldest key off screen.
    expect(instance.acquire('d', PNG, 1, 1)).not.toBeNull();
    instance.sweep(new Set(['a', 'b', 'c', 'd']), new Set(['b', 'd']));
    expect(instance.liveCount()).toBe(3);
    expect(instance.idFor('c')).toBeUndefined();
    expect(instance.idFor('a')).toBeDefined();
    expect(instance.idFor('b')).toBeDefined();
    expect(instance.idFor('d')).toBeDefined();
  });

  it('never evicts a visible key, even over budget', () => {
    const {instance} = registry({maxLive: 2});
    for (const key of ['a', 'b', 'c']) instance.acquire(key, PNG, 1, 1);
    instance.sweep(new Set(['a', 'b', 'c']), new Set(['a', 'b', 'c']));
    expect(instance.liveCount()).toBe(3);
  });

  it('keeps the base64 sent within the byte budget', () => {
    const big = pngFixture(64, 64, (x, y) => [x * 4, y * 4, (x * y) & 255, 255]);
    const base64 = Math.ceil(big.byteLength / 3) * 4;
    const {instance} = registry({maxBytes: base64 * 2});
    instance.acquire('a', big, 1, 1);
    instance.acquire('b', big, 1, 1);
    instance.sweep(new Set(['a', 'b']), new Set());
    instance.acquire('c', big, 1, 1);
    instance.sweep(new Set(['a', 'b', 'c']), new Set(['c']));
    expect(instance.liveCount()).toBe(2);
    expect(instance.idFor('c')).toBeDefined();
  });

  it('says when the first id leaves quarantine once none is free', () => {
    const {instance, advance} = registry({quarantineMs: 2_000});
    for (let key = 0; key < 255; key += 1) instance.acquire(`k${key}|after|2x1|10x20`, PNG, 2, 1);
    expect(instance.acquire('extra|after|2x1|10x20', PNG, 2, 1)).toBeNull();
    // Every id live: none is due before a full quarantine.
    expect(instance.nextFreeIn()).toBe(2_000);
    instance.release('k0|after|2x1|10x20');
    advance(500);
    instance.release('k1|after|2x1|10x20');
    advance(300);
    expect(instance.nextFreeIn()).toBe(1_200);
    advance(1_200);
    expect(instance.nextFreeIn()).toBe(0);
    expect(instance.acquire('extra|after|2x1|10x20', PNG, 2, 1)).not.toBeNull();
  });

  it('lists exactly the live ids in the restore sequence and forgets them', () => {
    const {instance} = registry();
    const a = instance.acquire('a', PNG, 1, 1)!;
    const b = instance.acquire('b', PNG, 1, 1)!;
    const c = instance.acquire('c', PNG, 1, 1)!;
    instance.release('b');
    const sequence = instance.restoreSequence();
    expect(parseApc([sequence]).map((command) => [command.a, command.d, command.i])).toEqual([['d', 'I', a], ['d', 'I', c]]);
    expect(b).not.toBe(a);
    expect(instance.liveCount()).toBe(0);
    expect(instance.restoreSequence()).toBe('');
  });
});

// Ghostty counts what an image takes decoded, four bytes a pixel, against
// 320 MB a screen. The registry keeps every image within 192 MB decoded,
// and a rendered page's tiles in a pool of their own: at most 10 live and
// 96 MB decoded, swept apart from the media pool, from the same 255 ids.
describe('image registry budgets and pools', () => {
  const MB = 1024 * 1024;
  // A tile of 1703 by 1160 pixels decodes to about 7.9 MB.
  const TILE = pngHeaderOnly(1703, 1160);
  const TILE_DECODED = 1703 * 1160 * 4;

  function pooled(options: Parameters<typeof createImageRegistry>[0] extends infer O ? Omit<O, 'write'> : never = {}) {
    const writes: string[] = [];
    let now = 1_000;
    const instance = createImageRegistry({write: (seq) => writes.push(seq), now: () => now, random: () => 0, ...options});
    return {instance, commands: () => parseApc(writes), advance: (ms: number) => {
      now += ms;
    }};
  }

  it('counts each image by its decoded size, every frame of an animation too', () => {
    const {instance} = pooled();
    instance.acquire('still', pngHeaderOnly(100, 50), 1, 1);
    expect(instance.decodedBytes()).toBe(100 * 50 * 4);
    const frame = pngHeaderOnly(100, 50);
    instance.acquire('moving', pngHeaderOnly(100, 50), 1, 1, {frames: [{png: frame, delayMs: 50}, {png: frame, delayMs: 50}], firstDelayMs: 50});
    expect(instance.decodedBytes()).toBe(100 * 50 * 4 * 4);
    instance.release('moving');
    expect(instance.decodedBytes()).toBe(100 * 50 * 4);
  });

  it('keeps the page pool to 10 live tiles off screen, and never sweeps the other pool', () => {
    const {instance} = pooled();
    const media = instance.acquire('media-a', PNG, 1, 1)!;
    const keys = Array.from({length: 14}, (_, index) => `page:${index}`);
    for (const key of keys) instance.acquire(key, pngHeaderOnly(10, 10), 1, 1, undefined, 'page');
    expect(instance.liveCount('page')).toBe(14);
    // The page sweep names only its own keys: the media image stays.
    instance.sweep(new Set(keys), new Set(keys.slice(10)), 'page');
    expect(instance.liveCount('page')).toBe(10);
    expect(instance.idFor('media-a')).toBe(media);
    // The least recently used went first, never one on screen.
    expect(keys.slice(0, 4).map((key) => instance.idFor(key))).toEqual([undefined, undefined, undefined, undefined]);
    expect(keys.slice(10).every((key) => instance.idFor(key) !== undefined)).toBe(true);
    // And the media sweep leaves the page tiles alone.
    instance.sweep(new Set(['media-a']), new Set(['media-a']));
    expect(instance.liveCount('page')).toBe(10);
    expect(instance.liveCount('media')).toBe(1);
  });

  it('keeps the page pool within 96 MB decoded, and says a tile that would pass it does not fit', () => {
    // The count cap set high, so the decoded budget is the one that binds.
    const {instance} = pooled({page: {maxLive: 50}});
    const keys = Array.from({length: 14}, (_, index) => `page:${index}`);
    let sent = 0;
    for (const key of keys) {
      if (!instance.fits(TILE, undefined, 'page')) break;
      instance.acquire(key, TILE, 131, 40, undefined, 'page');
      sent += 1;
    }
    expect(sent).toBe(Math.floor((96 * MB) / TILE_DECODED));
    expect(instance.decodedBytes('page')).toBeLessThanOrEqual(96 * MB);
    // Off screen, a tile that does not fit is never sent: no sweep then
    // evicts it, so no next want sends it again.
    instance.sweep(new Set(keys), new Set(), 'page');
    expect(instance.liveCount('page')).toBe(sent);
  });

  it('keeps every image within 192 MB decoded across both pools', () => {
    const {instance} = pooled({maxDecoded: 192 * MB, maxBytes: 1024 * MB});
    const big = pngHeaderOnly(4096, 4096);
    // 64 MB decoded each: two media images and one page tile come to 192.
    instance.acquire('media-1', big, 1, 1);
    instance.acquire('media-2', big, 1, 1);
    expect(instance.fits(big, undefined, 'page')).toBe(true);
    instance.acquire('page-1', pngHeaderOnly(4096, 4096), 1, 1, undefined, 'page');
    expect(instance.decodedBytes()).toBe(3 * 64 * MB);
    // Full: one more pixel of either pool does not fit.
    expect(instance.fits(pngHeaderOnly(16, 16), undefined, 'page')).toBe(false);
    expect(instance.fits(pngHeaderOnly(16, 16))).toBe(false);
    // Over the global budget, a sweep trims its own pool's images off screen.
    instance.acquire('page-2', pngHeaderOnly(4096, 1024), 1, 1, undefined, 'page');
    instance.sweep(new Set(['page-1', 'page-2']), new Set(['page-2']), 'page');
    expect(instance.idFor('page-1')).toBeUndefined();
    expect(instance.decodedBytes()).toBeLessThanOrEqual(192 * MB);
    expect(instance.idFor('media-1')).toBeDefined();
  });

  it('leaves media previews as they were while no page tile is live, however much they take decoded', () => {
    const {instance} = pooled({maxDecoded: 192 * MB});
    // A long animated GIF: small to send, 458 MB decoded, past the shared budget alone.
    const frame = pngHeaderOnly(800, 500);
    const gif = {frames: Array.from({length: 299}, () => ({png: frame, delayMs: 40})), firstDelayMs: 40};
    instance.acquire('gif', pngHeaderOnly(800, 500), 80, 25, gif);
    instance.acquire('small', pngHeaderOnly(100, 50), 10, 5);
    expect(instance.decodedBytes()).toBeGreaterThan(192 * MB);
    expect(instance.fits(pngHeaderOnly(100, 50))).toBe(true);
    // Neither sweep evicts: the GIF on screen, then off it.
    instance.sweep(new Set(['gif', 'small']), new Set(['gif']));
    instance.sweep(new Set(['gif', 'small']), new Set());
    expect([instance.idFor('gif'), instance.idFor('small')].every((id) => id !== undefined)).toBe(true);
    // Once the pane draws a tile, the shared budget holds for both pools.
    instance.acquire('page-1', pngHeaderOnly(10, 10), 1, 1, undefined, 'page');
    expect(instance.fits(pngHeaderOnly(100, 50))).toBe(false);
    instance.sweep(new Set(['gif', 'small']), new Set(['gif']));
    expect(instance.idFor('small')).toBeUndefined();
    // And when the last tile goes, media is as before again.
    instance.release('page-1');
    expect(instance.fits(pngHeaderOnly(100, 50))).toBe(true);
  });

  it('leaves media its own base64 budget however many page tiles are live, within the decoded one', () => {
    // Media's budget fits three of these; page tiles are far larger to send.
    const media = pngFixture(40, 40);
    const tightBytes = 3 * Buffer.from(media).toString('base64').length + 10;
    const run = (tiles: number) => {
      const {instance} = pooled({maxBytes: tightBytes, maxDecoded: 192 * MB});
      for (let index = 0; index < tiles; index += 1) instance.acquire(`page:${index}`, TILE, 131, 40, undefined, 'page');
      const fits: boolean[] = [];
      const keys = ['m-0', 'm-1', 'm-2', 'm-3'];
      for (const key of keys) {
        fits.push(instance.fits(media));
        instance.acquire(key, media, 4, 2);
      }
      const before = instance.liveCount('media');
      // Over its base64 budget with a fourth image: the media sweep trims off screen, never on.
      instance.sweep(new Set(keys), new Set(['m-0', 'm-3']));
      return {fits, before, after: instance.liveCount('media'), kept: keys.map((key) => instance.idFor(key) !== undefined), pageLive: instance.liveCount('page'), decoded: instance.decodedBytes()};
    };
    const alone = run(0);
    expect(alone.fits).toEqual([true, true, true, false]);
    expect(alone.before).toBe(4);
    // Near the page pool's limits: ten tiles, about 79 MB decoded of its 96.
    const beside = run(10);
    expect(beside.pageLive).toBe(10);
    expect(beside.decoded).toBeLessThanOrEqual(192 * MB);
    expect({fits: beside.fits, before: beside.before, after: beside.after, kept: beside.kept}).toEqual({fits: alone.fits, before: alone.before, after: alone.after, kept: alone.kept});
  });

  it('hands both pools ids from the one table, so no id names two images', () => {
    const {instance} = pooled();
    const ids = new Set<number>();
    for (let index = 0; index < 5; index += 1) ids.add(instance.acquire(`media-${index}`, PNG, 1, 1)!);
    for (let index = 0; index < 5; index += 1) ids.add(instance.acquire(`page-${index}`, PNG, 1, 1, undefined, 'page')!);
    expect(ids.size).toBe(10);
    // The restore at exit deletes both pools' images.
    expect(parseApc([instance.restoreSequence()])).toHaveLength(10);
  });
});
