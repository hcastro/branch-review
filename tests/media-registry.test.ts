import {describe, expect, it} from 'vitest';
import {createImageRegistry} from '../src/media/imageRegistry.js';
import {parseApc, pngFixture} from './media-helpers.js';

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
