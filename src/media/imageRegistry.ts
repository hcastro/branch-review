import {deleteImage, placeVirtual, transmitPng} from './kitty.js';

// Which terminal image id names which image, and when ids are sent and
// deleted. An image key names one content at one geometry for one cell size,
// and an id is bound to one key for its whole life: new content or a new size
// is a new key and a new id, so placeholder cells can never show another
// image's pixels. A released id sits in quarantine before it is handed out
// again, long enough for every frame that still drew it to be replaced.

const MAX_ID = 255;
const DEFAULT_MAX_LIVE = 64;
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const DEFAULT_QUARANTINE_MS = 2_000;

type Entry = {id: number; base64Bytes: number};

const base64Size = (png: Uint8Array) => Math.ceil(png.byteLength / 3) * 4;

export type ImageRegistry = {
  /**
   * The key's id, sending the image first when it is new: transmit and
   * placement go out in one write before this returns, so no row can name
   * the id before the terminal has it. Null when every id is live or in
   * quarantine.
   */
  acquire(imageKey: string, png: Uint8Array, cols: number, rows: number): number | null;
  idFor(imageKey: string): number | undefined;
  /** Marks a key drawn this render, for least-recently-used eviction. */
  touch(imageKey: string): void;
  /** Deletes the key's image and quarantines its id. */
  release(imageKey: string): void;
  /**
   * After a commit: releases keys no row references any more, then, over
   * budget, the least recently used keys not on screen.
   */
  sweep(live: ReadonlySet<string>, visible: ReadonlySet<string>): void;
  /** Deletes for every live id, for the exit write; forgets them all. */
  restoreSequence(): string;
  liveCount(): number;
  /**
   * Whether one more image of this PNG's size stays within both budgets, the
   * image count and the bytes sent, so a sweep would not evict it again.
   */
  fits(png: Uint8Array): boolean;
  /**
   * After `acquire` found no free id: how long until the first id leaves
   * quarantine. With every id live, none is due yet, so the full quarantine,
   * which an id released from now on serves.
   */
  nextFreeIn(): number;
};

export function createImageRegistry({
  write,
  now = Date.now,
  maxLive = DEFAULT_MAX_LIVE,
  maxBytes = DEFAULT_MAX_BYTES,
  quarantineMs = DEFAULT_QUARANTINE_MS,
  random = Math.random,
}: {
  write: (sequence: string) => void;
  now?: () => number;
  maxLive?: number;
  maxBytes?: number;
  quarantineMs?: number;
  random?: () => number;
}): ImageRegistry {
  // In use order, least recent first.
  const entries = new Map<string, Entry>();
  const liveIds = new Set<number>();
  const releasedAt = new Map<number, number>();
  let liveBytes = 0;
  // A random start keeps two sessions in one terminal from starting on the
  // same ids.
  let cursor = 1 + Math.min(MAX_ID - 1, Math.floor(random() * MAX_ID));

  const freeId = () => {
    const at = now();
    for (let step = 0; step < MAX_ID; step += 1) {
      const id = ((cursor - 1 + step) % MAX_ID) + 1;
      if (liveIds.has(id)) continue;
      const released = releasedAt.get(id);
      if (released !== undefined && at - released < quarantineMs) continue;
      cursor = (id % MAX_ID) + 1;
      return id;
    }
    return null;
  };

  const forget = (imageKey: string) => {
    const entry = entries.get(imageKey);
    if (!entry) return null;
    entries.delete(imageKey);
    liveIds.delete(entry.id);
    liveBytes -= entry.base64Bytes;
    return entry;
  };

  const release = (imageKey: string) => {
    const entry = forget(imageKey);
    if (!entry) return;
    releasedAt.set(entry.id, now());
    write(deleteImage(entry.id));
  };

  const touch = (imageKey: string) => {
    const entry = entries.get(imageKey);
    if (!entry) return;
    entries.delete(imageKey);
    entries.set(imageKey, entry);
  };

  return {
    acquire(imageKey, png, cols, rows) {
      const existing = entries.get(imageKey);
      if (existing) {
        touch(imageKey);
        return existing.id;
      }
      const id = freeId();
      if (id === null) return null;
      write(transmitPng(id, png) + placeVirtual(id, cols, rows));
      releasedAt.delete(id);
      const base64Bytes = base64Size(png);
      entries.set(imageKey, {id, base64Bytes});
      liveIds.add(id);
      liveBytes += base64Bytes;
      return id;
    },
    idFor: (imageKey) => entries.get(imageKey)?.id,
    touch,
    release,
    sweep(live, visible) {
      for (const imageKey of [...entries.keys()]) {
        if (!live.has(imageKey)) release(imageKey);
      }
      for (const imageKey of [...entries.keys()]) {
        if (entries.size <= maxLive && liveBytes <= maxBytes) break;
        if (!visible.has(imageKey)) release(imageKey);
      }
    },
    restoreSequence() {
      let sequence = '';
      for (const imageKey of [...entries.keys()]) {
        const entry = forget(imageKey)!;
        sequence += deleteImage(entry.id);
      }
      return sequence;
    },
    liveCount: () => entries.size,
    fits: (png) => entries.size < maxLive && liveBytes + base64Size(png) <= maxBytes,
    nextFreeIn() {
      const at = now();
      let soonest = quarantineMs;
      for (const [id, released] of releasedAt) {
        if (!liveIds.has(id)) soonest = Math.min(soonest, Math.max(0, released + quarantineMs - at));
      }
      return soonest;
    },
  };
}
