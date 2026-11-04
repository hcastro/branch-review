import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createCrossingClock} from '../src/ui/crossing.js';

// The TUI's crossing clock: it ticks every 40 ms only while a crossing plays,
// so the diff pane redraws for the launch and then goes quiet.

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function listening() {
  const clock = createCrossingClock();
  let emits = 0;
  clock.subscribe(() => {
    emits += 1;
  });
  return {clock, emits: () => emits};
}

describe('createCrossingClock', () => {
  it('plays a full launch for 840 ms and settles only once it ends, then stops ticking', async () => {
    const {clock, emits} = listening();
    let settled = false;
    void clock.start('full').then(() => {
      settled = true;
    });
    expect(clock.snapshot()).toEqual({motion: 'full', t: 0});
    await vi.advanceTimersByTimeAsync(640);
    // The specks have landed and the diff is still drawing back in: the
    // page waits for the end, so its arrival never plays over this.
    expect(clock.snapshot()).toEqual({motion: 'full', t: 640});
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(160);
    expect(clock.snapshot()).toEqual({motion: 'full', t: 800});
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(settled).toBe(true);
    expect(clock.snapshot()).toBeNull();
    // The press, twenty ticks, and the frame clearing at the end.
    const atEnd = emits();
    expect(atEnd).toBe(22);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emits()).toBe(atEnd);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts over on a second press: the first settles, and the second plays its whole launch', async () => {
    const {clock} = listening();
    let first = false;
    let second = false;
    void clock.start('full').then(() => {
      first = true;
    });
    await vi.advanceTimersByTimeAsync(120);
    expect(clock.snapshot()).toEqual({motion: 'full', t: 120});
    void clock.start('full').then(() => {
      second = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toBe(true);
    expect(clock.snapshot()).toEqual({motion: 'full', t: 0});
    await vi.advanceTimersByTimeAsync(800);
    expect(second).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(second).toBe(true);
    expect(clock.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles at once on a dispose that stops it before it ends', async () => {
    const {clock} = listening();
    let settled = false;
    void clock.start('full').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(200);
    clock.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    expect(clock.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('plays its own timing: the hover shimmer runs 400 ms at full motion, and nothing under reduced', async () => {
    const clock = createCrossingClock({timing: {full: 400, reduced: 0}});
    let settled = false;
    void clock.start('full').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(360);
    expect(clock.snapshot()).toEqual({motion: 'full', t: 360});
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(settled).toBe(true);
    expect(clock.snapshot()).toBeNull();
    await clock.start('reduced');
    expect(clock.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('plays a reduced crossing for 120 ms', async () => {
    const {clock} = listening();
    let settled = false;
    void clock.start('reduced').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(80);
    expect(clock.snapshot()).toEqual({motion: 'reduced', t: 80});
    await vi.advanceTimersByTimeAsync(40);
    expect(settled).toBe(true);
    expect(clock.snapshot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('plays nothing with motion off', async () => {
    const {clock, emits} = listening();
    await clock.start('off');
    expect(clock.snapshot()).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emits()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
