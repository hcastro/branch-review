import type {DiffRange} from '../git.js';
import type {ReviewFile, ReviewModel} from '../review/model.js';
import type {MediaBackend, RenderResult} from './backend.js';
import {classifyMedia} from './classify.js';
import {createImageRegistry} from './imageRegistry.js';
import {staleReason, type BoxSpec} from './layout.js';
import {createLru} from './lru.js';
import {openMedia, type OpenOutcome, type Opener} from './openExternal.js';
import type {GraphicsCaps, MediaRef, MediaViewState, SideName, SideState} from './types.js';

// The UI process's media state for the session: which review files are
// media, what inspect found out about each side, the PNGs rendered for each
// box, and which terminal image id each box is drawn with. Section rows only
// describe geometry; the pane asks this service for a box's pixels when it
// draws the row, so a picture arriving re-renders the pane without
// rebuilding the sections.

const PNG_CACHE_BYTES = 64 * 1024 * 1024;
// The first files in tree order are inspected first.
const FIRST_FILES = 10;
const LIBRARY_MISSING = 'image library failed to load';

export type BoxState =
  | {status: 'loading'}
  | {status: 'kitty'; id: number}
  | {status: 'error'; reason: string};

export type WantedBox = {fileKey: string; box: BoxSpec};

type MediaContext = {cwd: string; range: Pick<DiffRange, 'includeWorktree'>};

export type MediaServiceOptions = {
  caps: GraphicsCaps;
  backend: MediaBackend;
  // Where graphics escapes go: the terminal, between Ink's frames.
  sink: {write(sequence: string): void};
  // The session temp dir, made on first use, for copies handed to a viewer.
  tempDir?: () => string;
  opener: Opener;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  // False under `--no-watch`, where no refresh brings a changed file back.
  watching?: boolean;
  now?: () => number;
  registry?: {maxLive?: number; maxBytes?: number; quarantineMs?: number; random?: () => number};
};

export type MediaService = ReturnType<typeof createMediaService>;

// What the row builder reads from the service.
export type MediaRowInput = Pick<MediaService, 'caps' | 'refFor' | 'sideState' | 'viewState' | 'watching'>;

export function createMediaService({caps, backend, sink, tempDir, opener, env, platform, watching = true, now = Date.now, registry: registryOptions = {}}: MediaServiceOptions) {
  const registry = createImageRegistry({write: (sequence) => sink.write(sequence), now, ...registryOptions});
  const listeners = new Set<() => void>();
  let context: MediaContext | null = null;
  let refs = new Map<string, MediaRef>();
  // By side key, which names the side's content: it never goes stale.
  const sides = new Map<string, SideState>();
  const inspecting = new Map<string, AbortController>();
  // The last known pixel size per file and side, used while a changed side
  // is inspected, so a box keeps its size through a watch refresh.
  const provisional = new Map<string, Extract<SideState, {status: 'ready'}>>();
  const textViews = new Set<string>();
  const pngs = createLru<Uint8Array>(PNG_CACHE_BYTES, (png) => png.byteLength);
  // A box that failed is not tried again until its key changes.
  const boxErrors = new Map<string, string>();
  // Side keys and box keys whose failure described the work tree file at
  // the time (gone, mid-write), not the content the id names. They are asked
  // again when a new review arrives, since the same id may now read fine.
  const diskSides = new Set<string>();
  const diskBoxes = new Set<string>();
  // Counts refreshes that found the review unchanged. A job that started
  // before one and then failed on the file's state is asked again at once:
  // the refresh looked at the file after the job did, and brings no new
  // review that would ask again.
  let keptReviews = 0;
  const rendering = new Map<string, AbortController>();
  let liveKeys: ReadonlySet<string> = new Set();
  let visibleKeys: ReadonlySet<string> = new Set();
  const notices: string[] = [];
  const noticed = new Set<string>();
  let planVersion = 0;
  let version = 0;
  let disposed = false;

  const notify = () => {
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const planChanged = () => {
    planVersion += 1;
    notify();
  };

  // True when the message is new.
  const notice = (key: string, message: string) => {
    if (noticed.has(key)) return false;
    noticed.add(key);
    notices.push(message);
    return true;
  };

  // Set once the worker failed too often: every preview then says why.
  let turnedOff: string | null = null;

  // Failures that end every preview, not just this one, get one toast each.
  // True when there is a new message to show.
  const noteFailure = (reason: string) => {
    let noted = false;
    const off = backend.disabledReason?.() ?? (reason.startsWith('previews turned off') ? reason : null);
    if (off && !turnedOff) {
      turnedOff = off;
      noted = notice('off', off);
      planVersion += 1;
    }
    if (reason.startsWith(LIBRARY_MISSING)) noted = notice('library', `image previews unavailable: ${LIBRARY_MISSING}`) || noted;
    return noted;
  };

  const refFor = (file: ReviewFile): MediaRef | null => {
    if (!context || caps.protocol !== 'kitty') return null;
    const ref = classifyMedia(file, context.range);
    // Still images only; SVG and video keep today's view.
    return ref?.kind === 'raster' ? ref : null;
  };

  const inspect = (ref: MediaRef, side: SideName, priority: number) => {
    const sideRef = ref[side]!;
    if (!context || sides.has(sideRef.key)) return;
    const {cwd} = context;
    const started = keptReviews;
    const controller = new AbortController();
    sides.set(sideRef.key, {status: 'pending'});
    inspecting.set(sideRef.key, controller);
    backend.inspect({cwd, side: sideRef, kind: ref.kind, format: ref.format}, controller.signal, priority).then((result) => {
      if (controller.signal.aborted || disposed) return;
      inspecting.delete(sideRef.key);
      const disk = !result.ok && (result.state === 'stale' || result.disk === true);
      if (disk && started !== keptReviews) {
        // The file was settling while a refresh looked at it: ask again now.
        sides.delete(sideRef.key);
        inspect(ref, side, priority);
        return;
      }
      let state: SideState;
      if (result.ok) {
        state = {status: 'ready', info: result.info};
        provisional.set(`${ref.fileKey}|${side}`, state);
      } else if (result.state === 'stale') {
        state = {status: 'stale'};
      } else {
        state = {status: 'error', reason: result.reason};
        noteFailure(result.reason);
      }
      if (disk) diskSides.add(sideRef.key);
      sides.set(sideRef.key, state);
      planChanged();
    }, () => {
      // Aborted: the side left the review.
    });
  };

  const sideState = (ref: MediaRef, side: SideName): SideState => {
    const sideRef = ref[side];
    if (!sideRef) return {status: 'error', reason: `no ${side} side`};
    const state = sides.get(sideRef.key) ?? {status: 'pending'};
    if (turnedOff && state.status !== 'ready') return {status: 'error', reason: turnedOff};
    if (state.status !== 'pending') return state;
    return provisional.get(`${ref.fileKey}|${side}`) ?? state;
  };

  const acquire = (box: BoxSpec, png: Uint8Array) => registry.acquire(box.imageKey, png, box.cols, box.rows);

  // A box on screen found every id live or in quarantine. Nothing else may
  // re-render an idle session, so one timer re-renders once an id is free,
  // and the want after that sends the box.
  let idRetry: ReturnType<typeof setTimeout> | null = null;
  const retryWhenIdFree = () => {
    if (idRetry || disposed) return;
    idRetry = setTimeout(() => {
      idRetry = null;
      if (!disposed) notify();
    }, Math.max(1, registry.nextFreeIn()));
    idRetry.unref?.();
  };

  // Sends a rendered image, and says whether a row on screen now draws it.
  // A box on screen always gets its image. One near the viewport but off
  // screen is sent ahead only while it fits both budgets: one that did not
  // would be evicted by the next sweep and sent again by the next want, a
  // loop of transmits. No row draws an off-screen box, so sending one needs
  // no re-render; the scroll that brings it on screen renders it.
  const send = (box: BoxSpec, png: Uint8Array) => {
    if (visibleKeys.has(box.imageKey)) {
      if (acquire(box, png) !== null) return true;
      retryWhenIdFree();
      return false;
    }
    if (registry.fits(png)) acquire(box, png);
    return false;
  };

  const render = (ref: MediaRef, box: BoxSpec, priority: number) => {
    if (!context || !box.side) return;
    const sideRef = ref[box.side];
    if (!sideRef) return;
    const started = keptReviews;
    const controller = new AbortController();
    rendering.set(box.imageKey, controller);
    const request = {
      cwd: context.cwd,
      op: 'fit' as const,
      sides: [sideRef],
      kind: ref.kind,
      format: ref.format,
      target: {cols: box.cols, rows: box.rows, cellPx: caps.cellPx, drawPx: box.drawPx, nearest: box.nearest},
      checker: true,
    };
    backend.render(request, controller.signal, priority).then((result: RenderResult) => {
      if (controller.signal.aborted || disposed) return;
      rendering.delete(box.imageKey);
      if (result.ok && 'png' in result) {
        const noted = result.passthrough ? noteFailure(LIBRARY_MISSING) : false;
        pngs.set(box.imageKey, result.png);
        // Sent only while a row still names the box; otherwise it waits in
        // the cache until one does.
        const drawn = liveKeys.has(box.imageKey) && send(box, result.png);
        if (drawn || noted) notify();
        return;
      }
      const disk = !result.ok && (result.state === 'stale' || result.disk === true);
      if (disk && started !== keptReviews) {
        // As for inspect: nothing is cached, and the next want renders it.
        notify();
        return;
      }
      const reason = result.ok ? 'preview unavailable' : result.state === 'stale' ? staleReason(watching) : result.reason;
      boxErrors.set(box.imageKey, reason);
      if (disk) diskBoxes.add(box.imageKey);
      if (!result.ok) noteFailure(result.reason);
      notify();
    }, () => {
      // Aborted: the box left the review.
    });
  };

  // Forgets failures that described the work tree file at the time, so its
  // sides and boxes are asked again. False when there were none.
  const forgetDiskFailures = () => {
    if (diskSides.size === 0 && diskBoxes.size === 0) return false;
    for (const key of diskSides) sides.delete(key);
    diskSides.clear();
    for (const key of diskBoxes) boxErrors.delete(key);
    diskBoxes.clear();
    return true;
  };

  const inspectAll = () => {
    let index = 0;
    for (const ref of refs.values()) {
      const priority = index < FIRST_FILES ? 0 : 1 + index;
      index += 1;
      for (const side of ['before', 'after'] as const) if (ref[side]) inspect(ref, side, priority);
    }
  };

  return {
    caps,
    watching,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Changes on any update: a re-render is due. */
    getVersion: () => version,
    /** Changes only when the rows a file shows change. */
    planVersion: () => planVersion,

    /**
     * Takes a new review: classifies its files, drops work for sides that
     * left it and starts inspecting the new ones. Called while rendering, so
     * it never notifies; the caller reads the new state in the same render.
     */
    setReview(review: ReviewModel, next: MediaContext) {
      if (disposed) return;
      context = next;
      const nextRefs = new Map<string, MediaRef>();
      const wanted = new Set<string>();
      for (const file of review.files) {
        const ref = refFor(file);
        if (!ref) continue;
        nextRefs.set(ref.fileKey, ref);
        for (const side of ['before', 'after'] as const) if (ref[side]) wanted.add(ref[side]!.key);
      }
      for (const [key, controller] of inspecting) {
        if (wanted.has(key)) continue;
        controller.abort();
        inspecting.delete(key);
        sides.delete(key);
      }
      // A file read mid-write or while gone: this review may name the same
      // content again, so its sides and boxes are asked again. Failures that
      // depend only on the content (not an image, too large, undecodable)
      // stay cached, so nothing is retried until the content changes.
      forgetDiskFailures();
      refs = nextRefs;
      planVersion += 1;
      version += 1;
      inspectAll();
    },

    /**
     * After a refresh that found the review unchanged. A file caught mid-write
     * that ends with the bytes it had keeps its id and fingerprint, so no new
     * review asks about it again; this does, once per such refresh.
     */
    retryDisk() {
      if (disposed) return;
      keptReviews += 1;
      if (!forgetDiskFailures()) return;
      inspectAll();
      planChanged();
    },
    refFor,
    sideState,
    viewState: (fileKey: string): MediaViewState => ({compare: 'sideBySide', flipSide: 'after', textView: textViews.has(fileKey)}),
    toggleTextView(fileKey: string) {
      if (textViews.has(fileKey)) textViews.delete(fileKey);
      else textViews.add(fileKey);
      planChanged();
    },

    boxState(box: BoxSpec): BoxState {
      const reason = boxErrors.get(box.imageKey);
      if (reason !== undefined) return {status: 'error', reason};
      const id = registry.idFor(box.imageKey);
      if (id === undefined && turnedOff) return {status: 'error', reason: turnedOff};
      return id === undefined ? {status: 'loading'} : {status: 'kitty', id};
    },

    /**
     * After each commit, with the boxes near the viewport: sends what is
     * rendered, renders what is not, and marks what is drawn as used.
     */
    want(boxes: readonly WantedBox[], visible: ReadonlySet<string>) {
      if (disposed) return;
      visibleKeys = visible;
      let changed = false;
      for (const {fileKey, box} of boxes) {
        const key = box.imageKey;
        if (boxErrors.has(key)) continue;
        if (registry.idFor(key) !== undefined) {
          registry.touch(key);
          continue;
        }
        const png = pngs.get(key);
        if (png) {
          // An image evicted off screen comes back from the cache, without
          // a new decode, once it is near the viewport again.
          if (send(box, png)) changed = true;
          continue;
        }
        if (rendering.has(key)) continue;
        const ref = refs.get(fileKey);
        const sideRef = box.side ? ref?.[box.side] : undefined;
        // Rendered once inspect has proved the side; until then the box is
        // sized from the last known dimensions and drawn blank.
        if (!ref || !sideRef || sides.get(sideRef.key)?.status !== 'ready') continue;
        render(ref, box, visible.has(key) ? 0 : 1);
      }
      if (changed) notify();
    },

    /** After each commit: frees ids no row names, and trims to budget off screen. */
    sweep(live: ReadonlySet<string>, visible: ReadonlySet<string>) {
      liveKeys = live;
      visibleKeys = visible;
      for (const [key, controller] of rendering) {
        if (live.has(key)) continue;
        controller.abort();
        rendering.delete(key);
      }
      registry.sweep(live, visible);
    },

    open(ref: MediaRef, which: SideName, how: 'open' | 'quickLook'): Promise<OpenOutcome> {
      if (!context || !tempDir) return Promise.resolve({message: 'no program to open media found', kind: 'error'});
      return openMedia({backend, cwd: context.cwd, tempDir, env, opener, ...(platform ? {platform} : {})}, ref, which, how);
    },

    /** Messages for the footer, once each per session. */
    takeNotices() {
      return notices.splice(0);
    },

    /** Deletes every image sent; for the restore write at exit. */
    restoreSequence: () => registry.restoreSequence(),

    dispose() {
      if (disposed) return;
      disposed = true;
      if (idRetry) clearTimeout(idRetry);
      for (const controller of [...inspecting.values(), ...rendering.values()]) controller.abort();
      backend.dispose();
    },
  };
}
