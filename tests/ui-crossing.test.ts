import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createCrossingClock} from '../src/ui/crossing.js';

// The TUI's crossing clock: it ticks every 40 ms only while a crossing plays,
// so the diff pane redraws for the beam and then goes quiet.

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
  it('plays a full crossing for 320 ms, then stops ticking', async () => {
    const {clock, emits} = listening();
    let settled = false;
    void clock.start('full').then(() => {
      settled = true;
    });
    expect(clock.snapshot()).toEqual({motion: 'full', t: 0});
    await vi.advanceTimersByTimeAsync(280);
    expect(clock.snapshot()).toEqual({motion: 'full', t: 280});
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(settled).toBe(true);
    expect(clock.snapshot()).toBeNull();
    // The press, seven ticks, and the frame clearing at the end.
    const atEnd = emits();
    expect(atEnd).toBe(9);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emits()).toBe(atEnd);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts over on a second press: the first settles, and the second plays its full 320 ms', async () => {
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
    await vi.advanceTimersByTimeAsync(280);
    expect(clock.snapshot()).toEqual({motion: 'full', t: 280});
    expect(second).toBe(false);
    await vi.advanceTimersByTimeAsync(40);
    expect(second).toBe(true);
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
