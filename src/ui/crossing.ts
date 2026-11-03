import {LAUNCH_LANDS_MS, LAUNCH_MS, PRESS_MS} from '../rendered/launch.js';
import type {Motion} from '../rendered/motion.js';

// The clock of the TUI's crossing toward a rendered page. It ticks every
// 40 ms only while a crossing plays, and only the diff pane reads it, so a
// tick redraws the pane and leaves the rest of the app alone. The frames
// themselves are pure functions of the time since the press (launch.ts).
// The same clock, with its own timing, plays the button's hover shimmer.

export type CrossingFrame = {motion: 'full' | 'reduced'; t: number};

const TICK_MS = 40;

/** How long a crossing plays for each motion, and when its promise settles (`lands`, at the end by default). 0 plays nothing. */
export type CrossingTiming = {full: number; reduced: number; lands?: number};

/** The launch: 880 ms that settle at 640, when the specks reach the button; 120 ms of press under reduced motion. */
export const LAUNCH_TIMING: CrossingTiming = {full: LAUNCH_MS, reduced: PRESS_MS, lands: LAUNCH_LANDS_MS};

export function createCrossingClock({now = Date.now, timing = LAUNCH_TIMING}: {now?: () => number; timing?: CrossingTiming} = {}) {
  let frame: CrossingFrame | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let finish: (() => void) | null = null;
  // Settles the promise without stopping the frames.
  const land = () => {
    const done = finish;
    finish = null;
    done?.();
  };
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
     * Plays a crossing for `motion` and settles when it lands: for the
     * launch, 880 ms of frames for full motion that settle at 640, 120 ms
     * for reduced, and at once for none. A press while one plays starts it
     * over, and the earlier one settles then.
     */
    start(motion: Motion): Promise<void> {
      stop();
      if (motion === 'off') return Promise.resolve();
      const length = motion === 'full' ? timing.full : timing.reduced;
      if (length <= 0) return Promise.resolve();
      const lands = motion === 'full' ? Math.min(length, timing.lands ?? length) : length;
      const startedAt = now();
      frame = {motion, t: 0};
      emit();
      timer = setInterval(() => {
        const t = now() - startedAt;
        if (t >= length) {
          stop();
          return;
        }
        if (t >= lands) land();
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
