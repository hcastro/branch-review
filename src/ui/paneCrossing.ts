import {CROSSING_MS, HOLD_MS, type CrossingLink} from '../rendered/transition.js';

// The clock of the in-pane crossing. It ticks only while one plays, at
// 25 frames a second, or 12 over a slow link, where each frame of
// placeholder rows costs more to send. The crossing holds at the end of the
// mosaic until every tile on screen is in the terminal, so no row ever
// names an image the terminal doesn't have yet; held past 600 ms, it says
// it is developing. Only the diff pane reads it.

export type PaneFrame = {t: number; link: CrossingLink; developing: boolean; departing: readonly string[]};

const TICKS: Record<CrossingLink, number> = {local: 40, slow: 83};
const DEVELOPING_AFTER_MS = 600;
// Where a hold keeps the clock: the mosaic's last frame.
const HELD_AT = HOLD_MS - 1;

export function createPaneClock({now = Date.now}: {now?: () => number} = {}) {
  let frame: PaneFrame | null = null;
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
     * Plays a crossing from the diff rows `departing` showed, and settles
     * when it ends or stops. `ready` says whether the tiles on screen are in.
     */
    start({link, departing, ready}: {link: CrossingLink; departing: readonly string[]; ready: () => boolean}): Promise<void> {
      stop();
      const startedAt = now();
      // Time spent held, which the crossing's own clock leaves out.
      let lag = 0;
      let heldSince: number | null = null;
      let passed = false;
      frame = {t: 0, link, developing: false, departing};
      emit();
      timer = setInterval(() => {
        const elapsed = now() - startedAt;
        let t = elapsed - lag;
        let developing = false;
        if (!passed && t >= HOLD_MS) {
          if (ready()) {
            passed = true;
            lag = elapsed - HOLD_MS;
            t = HOLD_MS;
          } else {
            heldSince ??= elapsed;
            lag = elapsed - HELD_AT;
            t = HELD_AT;
            developing = elapsed - heldSince >= DEVELOPING_AFTER_MS;
          }
        }
        if (t >= CROSSING_MS) {
          stop();
          return;
        }
        frame = {t, link, developing, departing};
        emit();
      }, TICKS[link]);
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
    /** Ends the crossing at once: `v` back, or the pane left the page. */
    stop,
  };
}

export type PaneClock = ReturnType<typeof createPaneClock>;
