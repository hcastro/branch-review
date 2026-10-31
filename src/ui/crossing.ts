import {BEAM_MS, PRESS_MS} from '../rendered/beam.js';
import type {Motion} from '../rendered/motion.js';

// The clock of the TUI's crossing toward a rendered page. It ticks every
// 40 ms only while a crossing plays, and only the diff pane reads it, so a
// tick redraws the pane and leaves the rest of the app alone. The frames
// themselves are pure functions of the time since the press (beam.ts).

export type CrossingFrame = {motion: 'full' | 'reduced'; t: number};

const TICK_MS = 40;

export function createCrossingClock({now = Date.now}: {now?: () => number} = {}) {
  let frame: CrossingFrame | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let finish: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
    const done = finish;
    finish = null;
    if (frame) {
      frame = null;
      emit();
    }
    done?.();
  };

  return {
    /**
     * Plays a crossing for `motion` and settles when it ends: 320 ms of beam
     * for full motion, 120 ms for reduced, at once for none. A press while
     * one plays starts it over, and the earlier one settles then.
     */
    start(motion: Motion): Promise<void> {
      stop();
      if (motion === 'off') return Promise.resolve();
      const length = motion === 'full' ? BEAM_MS : PRESS_MS;
      const startedAt = now();
      frame = {motion, t: 0};
      emit();
      timer = setInterval(() => {
        const t = now() - startedAt;
        if (t >= length) {
          stop();
          return;
        }
        frame = {motion, t};
        emit();
      }, TICK_MS);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** The frame to draw now, or null between crossings. */
    snapshot: () => frame,
    dispose: stop,
  };
}

export type CrossingClock = ReturnType<typeof createCrossingClock>;
