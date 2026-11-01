import type {Animation} from './backend.js';
import {deleteImage, frameGap, placeVirtual, startLoop, transmitFrame, transmitPng} from './kitty.js';

// Which terminal image id names which image, and when ids are sent and
// deleted. An image key names one content at one geometry for one cell size,
// and an id is bound to one key for its whole life: new content or a new size
// is a new key and a new id, so placeholder cells can never show another
// image's pixels. A released id sits in quarantine before it is handed out
// again, long enough for every frame that still drew it to be replaced.
//
// Two pools share the one table of ids: media previews, and a rendered
// page's tiles in the diff pane. Each pool is swept on its own, by the rows
// that name its keys, so neither frees the other's images. The terminal
// keeps images decoded, four bytes a pixel (Ghostty allows 320 MB a
// screen), so besides the base64 sent, every image counts by its decoded
// size against one budget for both pools. That budget holds only while a
// page tile is live or asked for: media previews alone keep the budgets
// they had before the pane existed, so they are the same when it is idle.

/** How many image ids a terminal session has. */
export const IMAGE_IDS = 255;
const MAX_ID = IMAGE_IDS;
const DEFAULT_MAX_LIVE = 64;
const DEFAULT_MAX_BYTES = 96 * 1024 * 1024;
const DEFAULT_QUARANTINE_MS = 2_000;
const MB = 1024 * 1024;
const DEFAULT_MAX_DECODED = 192 * MB;
// A page's tiles are large (a 131 by 40 cell tile is about 8 MB decoded),
// and only the ones near the viewport are needed.
const PAGE_MAX_LIVE = 10;
const PAGE_MAX_DECODED = 96 * MB;

export type ImagePool = 'media' | 'page';

type Entry = {id: number; base64Bytes: number; decodedBytes: number; pool: ImagePool};

const base64Size = (png: Uint8Array) => Math.ceil(png.byteLength / 3) * 4;
// What an image costs the terminal: its first frame and every other one.
const imageSize = (png: Uint8Array, animation?: Animation) => base64Size(png) + (animation?.frames ?? []).reduce((sum, frame) => sum + base64Size(frame.png), 0);

// A PNG's pixels times four, from its header: what the terminal keeps once
// it decodes it. Bytes that aren't a PNG count as their own size.
function pngDecoded(png: Uint8Array) {
  if (png.byteLength < 24 || png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return png.byteLength;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return view.getUint32(16) * view.getUint32(20) * 4;
}
const decodedSize = (png: Uint8Array, animation?: Animation) => pngDecoded(png) + (animation?.frames ?? []).reduce((sum, frame) => sum + pngDecoded(frame.png), 0);

export type ImageRegistry = {
  /**
   * The key's id, sending the image first when it is new: transmit and
   * placement go out in one write before this returns, so no row can name
   * the id before the terminal has it. Null when every id is live or in
   * quarantine. An animation's frames and loop go out in the same write,
   * and the terminal runs it from there.
   */
  acquire(imageKey: string, png: Uint8Array, cols: number, rows: number, animation?: Animation, pool?: ImagePool): number | null;
  idFor(imageKey: string): number | undefined;
  /** Marks a key drawn this render, for least-recently-used eviction. */
  touch(imageKey: string): void;
  /** Deletes the key's image and quarantines its id. */
  release(imageKey: string): void;
  /**
   * After a commit: releases the pool's keys no row references any more,
   * then, over the pool's budget or (while the pane draws) the decoded budget, its least recently
   * used keys not on screen. The media pool when none is named.
   */
  sweep(live: ReadonlySet<string>, visible: ReadonlySet<string>, pool?: ImagePool): void;
  /** Deletes for every live id, for the exit write; forgets them all. */
  restoreSequence(): string;
  /** Live images in a pool, or in both. */
  liveCount(pool?: ImagePool): number;
  /** What the live images take decoded, in a pool or in both. */
  decodedBytes(pool?: ImagePool): number;
  /**
   * Whether one more image of this PNG's size (and its animation's frames)
   * stays within the pool's budgets and, while the pane draws, the decoded
   * budget, so a sweep would not evict it again.
   */
  fits(png: Uint8Array, animation?: Animation, pool?: ImagePool): boolean;
  /**
   * Whether one more image of this PNG's size stays within the budgets
   * once the sweeps let go of every image off screen: the pool's not in
   * `onScreen`, and the other pool's not on screen at its last sweep. When
   * it doesn't fit, the screen itself asks for more than the terminal holds.
   */
  fitsOnScreen(png: Uint8Array, onScreen: ReadonlySet<string>, pool?: ImagePool): boolean;
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
  maxDecoded = DEFAULT_MAX_DECODED,
  page = {},
}: {
  write: (sequence: string) => void;
  now?: () => number;
  // The media pool's image count and base64 budget.
  maxLive?: number;
  maxBytes?: number;
  quarantineMs?: number;
  random?: () => number;
  // Both pools' decoded bytes together.
  maxDecoded?: number;
  page?: {maxLive?: number; maxDecoded?: number};
}): ImageRegistry {
  const pageMaxLive = page.maxLive ?? PAGE_MAX_LIVE;
  const pageMaxDecoded = page.maxDecoded ?? PAGE_MAX_DECODED;
  // In use order, least recent first.
  const entries = new Map<string, Entry>();
  const liveIds = new Set<number>();
  const releasedAt = new Map<number, number>();
  // The media pool's base64, and each pool's decoded bytes.
  let liveBytes = 0;
  const decoded: Record<ImagePool, number> = {media: 0, page: 0};
  const counts: Record<ImagePool, number> = {media: 0, page: 0};
  // What each pool's last sweep said is on screen: what its next sweep keeps.
  const onScreenAt: Record<ImagePool, ReadonlySet<string>> = {media: new Set(), page: new Set()};
  // A random start only staggers where a session's ids begin. It does not
  // keep two sessions drawing on one terminal apart: each knows only its own
  // ids, so sooner or later one writes over or deletes the other's. Under
  // tmux, where every pane draws on the same outer terminal, only one
  // session per server draws (claimKittyTmux).
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
    if (entry.pool === 'media') liveBytes -= entry.base64Bytes;
    decoded[entry.pool] -= entry.decodedBytes;
    counts[entry.pool] -= 1;
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

  const totalDecoded = () => decoded.media + decoded.page;
  // Whether a pool holding this much is within its own budgets, and, with
  // both pools holding `shared` decoded, within the decoded one.
  const allows = (pool: ImagePool, held: {count: number; base64: number; decoded: number; shared: number}) => {
    if ((pool === 'page' || counts.page > 0) && held.shared > maxDecoded) return false;
    if (pool === 'page') return held.count <= pageMaxLive && held.decoded <= pageMaxDecoded;
    return held.count <= maxLive && held.base64 <= maxBytes;
  };
  // Whether a pool is within its budgets with `extra` more of each.
  const within = (pool: ImagePool, extra: {count: number; base64: number; decoded: number}) => allows(pool, {
    count: counts[pool] + extra.count,
    base64: liveBytes + extra.base64,
    decoded: decoded[pool] + extra.decoded,
    shared: totalDecoded() + extra.decoded,
  });
  const NONE = {count: 0, base64: 0, decoded: 0};

  return {
    acquire(imageKey, png, cols, rows, animation, pool = 'media') {
      const existing = entries.get(imageKey);
      if (existing) {
        touch(imageKey);
        return existing.id;
      }
      const id = freeId();
      if (id === null) return null;
      let frames = '';
      if (animation && animation.frames.length > 0) {
        for (const frame of animation.frames) frames += transmitFrame(id, frame.png, frame.delayMs);
        frames += frameGap(id, 1, animation.firstDelayMs) + startLoop(id);
      }
      write(transmitPng(id, png) + placeVirtual(id, cols, rows) + frames);
      releasedAt.delete(id);
      const base64Bytes = imageSize(png, animation);
      const decodedBytes = decodedSize(png, animation);
      entries.set(imageKey, {id, base64Bytes, decodedBytes, pool});
      liveIds.add(id);
      if (pool === 'media') liveBytes += base64Bytes;
      decoded[pool] += decodedBytes;
      counts[pool] += 1;
      return id;
    },
    idFor: (imageKey) => entries.get(imageKey)?.id,
    touch,
    release,
    sweep(live, visible, pool = 'media') {
      onScreenAt[pool] = visible;
      const own = () => [...entries].filter(([, entry]) => entry.pool === pool).map(([imageKey]) => imageKey);
      for (const imageKey of own()) {
        if (!live.has(imageKey)) release(imageKey);
      }
      for (const imageKey of own()) {
        if (within(pool, NONE)) break;
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
    liveCount: (pool) => (pool ? counts[pool] : entries.size),
    decodedBytes: (pool) => (pool ? decoded[pool] : totalDecoded()),
    fits: (png, animation, pool = 'media') => within(pool, {count: 1, base64: imageSize(png, animation), decoded: decodedSize(png, animation)}),
    fitsOnScreen(png, onScreen, pool = 'media') {
      // What each pool keeps on screen, the images off screen taken away:
      // either pool's sweep lets go of its own off screen once the decoded
      // budget both share is exceeded.
      const held = {count: 1, base64: imageSize(png), decoded: decodedSize(png), shared: decodedSize(png)};
      for (const [imageKey, entry] of entries) {
        if (!(entry.pool === pool ? onScreen : onScreenAt[entry.pool]).has(imageKey)) continue;
        held.shared += entry.decodedBytes;
        if (entry.pool !== pool) continue;
        held.count += 1;
        held.base64 += entry.base64Bytes;
        held.decoded += entry.decodedBytes;
      }
      return allows(pool, held);
    },
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
