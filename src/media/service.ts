import type {DiffRange} from '../git.js';
import type {ReviewFile, ReviewModel} from '../review/model.js';
import type {Animation, JobFailure, MediaBackend, RenderRequest, RenderResult, VideoRequest} from './backend.js';
import {blockRows} from './blocks.js';
import {classifyMedia} from './classify.js';
import {createImageRegistry} from './imageRegistry.js';
import {staleReason, type BoxSpec, type DrawnFacts} from './layout.js';
import {createLru} from './lru.js';
import {escapeHiddenCharacters} from '../controlChars.js';
import {openMedia, sideToOpen, type ExportedCopy, type OpenOutcome, type Opener} from './openExternal.js';
import type {CompareMode, GraphicsCaps, MediaRef, MediaViewState, SideName, SideState, VideoMeta} from './types.js';

// The UI process's media state for the session: which review files are
// media, what inspect found out about each side, the PNGs rendered for each
// box, and which terminal image id each box is drawn with (or, for the block
// preview, the half-block rows each box draws as). Section rows only
// describe geometry; the pane asks this service for a box's pixels when it
// draws the row, so a picture arriving re-renders the pane without
// rebuilding the sections.

const PNG_CACHE_BYTES = 64 * 1024 * 1024;
// A box of block rows is at most 60 × 20 cells, tens of KB of SGR text.
const BLOCK_CACHE_CHARS = 16 * 1024 * 1024;
// The first files in tree order are inspected first.
const FIRST_FILES = 10;
const LIBRARY_MISSING = 'image library failed to load';
// The columns between frames in a video strip, as the plan lays it out.
const VIDEO_GAP_COLS = 1;
// What one animation may cost: past either cap the worker draws its first
// frame alone.
const ANIMATION_LIMITS = {max: 100, maxBytes: 32 * 1024 * 1024};

// A rendered image: its PNG, and the frames that follow when it animates.
type Rendered = {png: Uint8Array; animation?: Animation};
const renderedBytes = ({png, animation}: Rendered) => png.byteLength + (animation?.frames ?? []).reduce((sum, frame) => sum + frame.png.byteLength, 0);

export type BoxState =
  | {status: 'loading'}
  | {status: 'kitty'; id: number}
  // One ANSI string per box row, each exactly the box's cols wide.
  | {status: 'blocks'; rows: readonly string[]}
  | {status: 'error'; reason: string}
  // Nothing to draw, and why, in a quiet tone: a video's frames without
  // ffmpeg, say.
  | {status: 'note'; text: string};

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
  // False under `--no-animations`: an animated image shows its first frame.
  animations?: boolean;
  now?: () => number;
  registry?: {maxLive?: number; maxBytes?: number; quarantineMs?: number; random?: () => number};
  // Messages for the footer from before the service existed.
  notices?: readonly string[];
};

export type MediaService = ReturnType<typeof createMediaService>;

// What the row builder reads from the service.
export type MediaRowInput = Pick<MediaService, 'caps' | 'refFor' | 'sideState' | 'viewState' | 'drawnFacts' | 'watching'> & Partial<Pick<MediaService, 'animates'>>;

export function createMediaService({caps, backend, sink, tempDir, opener, env, platform, watching = true, animations = false, now = Date.now, registry: registryOptions = {}, notices: startupNotices = []}: MediaServiceOptions) {
  // Kitty terminals that run animations themselves loop an animated GIF or
  // WebP; everywhere else it shows its first frame.
  const animates = caps.protocol === 'kitty' && caps.animation && animations;
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
  // How modified images are compared, chosen once for the whole session:
  // reviewing twenty icons in flip mode should not take twenty key presses.
  let compare: CompareMode = 'sideBySide';
  // Files whose flip view shows the before side; every other shows after.
  // Cleared whenever the active file changes.
  const flippedToBefore = new Set<string>();
  // The share of pixels that changed, by content key, from the drawn
  // difference.
  const changedRatios = new Map<string, number>();
  // Why an animation shows its first frame only, by content key and side:
  // one side of a changed GIF may run while the other is too large.
  const stillNotes = new Map<string, Partial<Record<SideName, string>>>();
  // Both facts by box key, kept while the box is cached anywhere. Content
  // that leaves the review and comes back (a file rewritten, then reverted)
  // draws from the cache with no new render, so its label takes them from
  // here.
  const boxFacts = new Map<string, {contentKey: string; side?: SideName; ratio?: number; note?: string}>();
  const pngs = createLru<Rendered>(PNG_CACHE_BYTES, renderedBytes);
  // Block previews never reach the terminal as images: a box is drawn from
  // its rows here, so nothing is sent and no id is used.
  const blockCache = createLru<readonly string[]>(BLOCK_CACHE_CHARS, (rows) => rows.reduce((sum, row) => sum + row.length, 0));
  // A box that failed is not tried again until its key changes.
  const boxErrors = new Map<string, string>();
  // A box with nothing to draw and a reason that is no failure (a video's
  // frames without ffmpeg), by box key, never asked again either.
  const boxNotes = new Map<string, string>();
  // What ffprobe found per video side, by side key (which names the
  // content); null when it could not tell. Absent until a strip's job
  // answers.
  const videoMeta = new Map<string, VideoMeta | null>();
  // Side keys and box keys whose failure described the work tree file at
  // the time (gone, mid-write), not the content the id names. They are asked
  // again when a new review arrives, since the same id may now read fine.
  const diskSides = new Set<string>();
  const diskBoxes = new Set<string>();
  // Side keys and box keys a git filter changes on disk. Only a write can
  // change that, and a write brings a new review, so they are asked again by
  // a new review alone, never by a refresh that kept the review.
  const filterSides = new Set<string>();
  const filterBoxes = new Set<string>();
  // The last settled state of each side asked again after a disk failure,
  // shown while the new answer is on its way, so the drawn view keeps its
  // rows instead of dropping to `loading preview…`.
  const reasking = new Map<string, SideState>();
  // Counts refreshes that found the review unchanged. A job that started
  // before one and then failed on the file's state is asked again at once:
  // the refresh looked at the file after the job did, and brings no new
  // review that would ask again.
  let keptReviews = 0;
  const rendering = new Map<string, AbortController>();
  let liveKeys: ReadonlySet<string> = new Set();
  let visibleKeys: ReadonlySet<string> = new Set();
  const notices: string[] = [...startupNotices];
  // Opens running, by side key and kind; copies exported for a viewer, by
  // side key, reused while they last.
  const opening = new Set<string>();
  const copies = new Map<string, ExportedCopy>();
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
    if (!context || caps.protocol === 'none') return null;
    return classifyMedia(file, context.range);
  };

  // A failure that described the file at the moment it was read, asked
  // again on any refresh. A filter verdict waits for a new review.
  const diskFailure = (result: JobFailure) => result.state === 'stale' || (result.disk === true && !result.filter);

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
      const disk = !result.ok && diskFailure(result);
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
      else if (!result.ok && result.filter) filterSides.add(sideRef.key);
      sides.set(sideRef.key, state);
      reasking.delete(sideRef.key);
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
    if (state.status === 'ready' && videoMeta.has(sideRef.key)) {
      // A video's pixel size is known only from its metadata.
      const meta = videoMeta.get(sideRef.key)!;
      return {status: 'ready', info: {...state.info, video: meta, ...(meta ? {width: meta.width, height: meta.height} : {})}};
    }
    if (state.status !== 'pending') return state;
    return reasking.get(sideRef.key) ?? provisional.get(`${ref.fileKey}|${side}`) ?? state;
  };

  // The one side a modified file draws when its other side failed. The plan
  // then shows that side alone in every compare mode, so it is what `o`
  // opens and there is nothing to swap. Undefined while both sides draw, or
  // while one is still loading and nothing draws yet.
  const loneSide = (ref: MediaRef): SideName | undefined => {
    if (!ref.before || !ref.after) return undefined;
    const before = sideState(ref, 'before').status;
    const after = sideState(ref, 'after').status;
    if (before === 'pending' || after === 'pending') return undefined;
    if (before === 'ready' && after !== 'ready') return 'before';
    if (after === 'ready' && before !== 'ready') return 'after';
    return undefined;
  };

  const acquire = (box: BoxSpec, rendered: Rendered) => registry.acquire(box.imageKey, rendered.png, box.cols, box.rows, rendered.animation);

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
  const send = (box: BoxSpec, rendered: Rendered) => {
    if (visibleKeys.has(box.imageKey)) {
      if (acquire(box, rendered) !== null) return true;
      retryWhenIdFree();
      return false;
    }
    if (registry.fits(rendered.png, rendered.animation)) acquire(box, rendered);
    return false;
  };

  // Whether a box draws an animated image whose frames the terminal can run.
  const animatedBox = (ref: MediaRef, box: BoxSpec) => {
    if (!animates || box.op !== 'fit' || ref.kind !== 'raster' || (ref.format !== 'gif' && ref.format !== 'webp') || !box.side) return false;
    const state = sides.get(ref[box.side]?.key ?? '');
    return state?.status === 'ready' && state.info.frames > 1;
  };

  // A fact drawing found out, for the label: set by content key, and kept by
  // box key while the box is cached. True when the label changes.
  const recordFact = (ref: MediaRef, box: BoxSpec, fact: {ratio?: number; note?: string}) => {
    if (fact.ratio === undefined && fact.note === undefined) return false;
    boxFacts.set(box.imageKey, {contentKey: ref.contentKey, ...(box.side ? {side: box.side} : {}), ...fact});
    let changed = false;
    if (fact.ratio !== undefined && changedRatios.get(ref.contentKey) !== fact.ratio) {
      changedRatios.set(ref.contentKey, fact.ratio);
      changed = true;
    }
    if (fact.note !== undefined && box.side && stillNotes.get(ref.contentKey)?.[box.side] !== fact.note) {
      stillNotes.set(ref.contentKey, {...stillNotes.get(ref.contentKey), [box.side]: fact.note});
      changed = true;
    }
    if (changed) planVersion += 1;
    return changed;
  };

  // The sides a box draws from: one for a picture, both for a difference.
  const boxSides = (ref: MediaRef | undefined, box: BoxSpec) => {
    if (!ref) return null;
    if (box.role === 'diff') return ref.before && ref.after ? [ref.before, ref.after] : null;
    const sideRef = box.side ? ref[box.side] : undefined;
    return sideRef ? [sideRef] : null;
  };

  // A box's job failed: its reason is cached so it is not asked again,
  // except a failure that described the work tree file while a refresh
  // looked at it, which the next want asks again.
  // Whether a failed job described the file while a refresh looked at it,
  // so it is asked again at once rather than cached.
  const asksAgain = (result: JobFailure | null, started: number) => result !== null && diskFailure(result) && started !== keptReviews;

  const failBox = (ref: MediaRef, box: BoxSpec, result: JobFailure | null, started: number) => {
    const disk = result !== null && diskFailure(result);
    if (asksAgain(result, started)) {
      // As for inspect: nothing is cached, and the next want renders it.
      notify();
      return;
    }
    const reason = !result ? 'preview unavailable' : result.state === 'stale' ? staleReason(watching) : result.reason;
    boxErrors.set(box.imageKey, reason);
    // An SVG whose picture failed shows its source instead: its rows change.
    if (ref.kind === 'svg') planVersion += 1;
    if (disk) diskBoxes.add(box.imageKey);
    else if (result?.filter) filterBoxes.add(box.imageKey);
    if (result) noteFailure(result.reason);
    notify();
  };

  // A video side's strip, and its metadata on the way: the metadata fills
  // the table (the plan's text), the strip draws like any picture.
  const renderVideo = (ref: MediaRef, box: BoxSpec, priority: number) => {
    const sideRef = box.side ? ref[box.side] : undefined;
    if (!context || !sideRef) return;
    if (!backend.video) {
      boxErrors.set(box.imageKey, 'video previews are not supported');
      notify();
      return;
    }
    const started = keptReviews;
    const controller = new AbortController();
    rendering.set(box.imageKey, controller);
    // A block preview's strip is one pixel per column and two per row.
    const blocks = caps.protocol === 'blocks';
    const cell = blocks ? {w: 1, h: 2} : caps.cellPx;
    const frameCount = box.frames === 4 ? 4 : 2;
    const frameCols = Math.max(1, Math.floor((box.cols - (frameCount - 1) * VIDEO_GAP_COLS) / frameCount));
    const request: VideoRequest = {
      cwd: context.cwd,
      side: sideRef,
      format: ref.format,
      frameCount,
      framePx: {w: frameCols * cell.w, h: box.rows * cell.h},
      stripCellPx: cell,
      stripCols: box.cols,
      stripRows: box.rows,
      gapCols: VIDEO_GAP_COLS,
      ...(blocks ? {blocks: true} : {}),
    };
    backend.video(request, controller.signal, priority).then((result) => {
      if (controller.signal.aborted || disposed) return;
      rendering.delete(box.imageKey);
      if (!result.ok) {
        // No metadata is coming for this content: the table's cells stop
        // saying it is loading. A job asked again at once keeps them.
        if (!asksAgain(result, started) && !videoMeta.has(sideRef.key)) {
          videoMeta.set(sideRef.key, null);
          planVersion += 1;
        }
        failBox(ref, box, result, started);
        return;
      }
      const known = videoMeta.get(sideRef.key);
      if (!videoMeta.has(sideRef.key) || JSON.stringify(known) !== JSON.stringify(result.meta)) {
        videoMeta.set(sideRef.key, result.meta);
        planVersion += 1;
      }
      if (result.cells) {
        blockCache.set(box.imageKey, blockRows(result.cells, box.cols, box.rows, caps.colorDepth));
      } else if (result.strip) {
        const rendered: Rendered = {png: result.strip};
        pngs.set(box.imageKey, rendered);
        if (liveKeys.has(box.imageKey)) send(box, rendered);
      } else {
        boxNotes.set(box.imageKey, result.note ?? 'no frames to show');
      }
      notify();
    }, () => {
      // Aborted: the box left the review.
    });
  };

  const render = (ref: MediaRef, box: BoxSpec, priority: number) => {
    if (box.op === 'video') {
      renderVideo(ref, box, priority);
      return;
    }
    const sideRefs = boxSides(ref, box);
    if (!context || !sideRefs) return;
    const started = keptReviews;
    const controller = new AbortController();
    rendering.set(box.imageKey, controller);
    const op: RenderRequest['op'] = box.op === 'blocks' || box.op === 'blocksDifference' ? box.op : box.role === 'diff' ? 'difference' : 'fit';
    const blocks = op === 'blocks' || op === 'blocksDifference';
    const request: RenderRequest = {
      cwd: context.cwd,
      op,
      sides: sideRefs,
      kind: ref.kind,
      format: ref.format,
      target: {cols: box.cols, rows: box.rows, cellPx: caps.cellPx, drawPx: box.drawPx, nearest: box.nearest},
      // Blocks flatten transparency onto the pane color instead.
      checker: !blocks,
      ...(blocks ? {colorDepth: caps.colorDepth} : {}),
      ...(animatedBox(ref, box) ? {frames: ANIMATION_LIMITS} : {}),
    };
    backend.render(request, controller.signal, priority).then((result: RenderResult) => {
      if (controller.signal.aborted || disposed) return;
      rendering.delete(box.imageKey);
      if (result.ok && 'cells' in result) {
        blockCache.set(box.imageKey, blockRows(result.cells, result.cols, result.rows, caps.colorDepth));
        recordFact(ref, box, {ratio: result.changedRatio});
        // Drawn by the next render of the pane, with nothing to send first.
        notify();
        return;
      }
      if (result.ok && 'png' in result) {
        const noted = result.passthrough ? noteFailure(LIBRARY_MISSING) : false;
        const rendered: Rendered = result.animation ? {png: result.png, animation: result.animation} : {png: result.png};
        pngs.set(box.imageKey, rendered);
        // The difference's label says how much changed, and an animation's
        // why it stopped at one frame: same rows, new text.
        const relabeled = recordFact(ref, box, {ratio: result.changedRatio, note: result.note});
        // Sent only while a row still names the box; otherwise it waits in
        // the cache until one does.
        const drawn = liveKeys.has(box.imageKey) && send(box, rendered);
        if (drawn || noted || relabeled || result.changedRatio !== undefined) notify();
        return;
      }
      failBox(ref, box, result.ok ? null : result, started);
    }, () => {
      // Aborted: the box left the review.
    });
  };

  // Forgets failures that described the work tree file at the time, so its
  // sides and boxes are asked again, and with `filters` the git filter
  // verdicts too. A forgotten side shows its last state until the answer
  // lands. False when there were none.
  const forgetDiskFailures = (filters: boolean) => {
    const sideKeys = filters ? [...diskSides, ...filterSides] : [...diskSides];
    const boxKeys = filters ? [...diskBoxes, ...filterBoxes] : [...diskBoxes];
    if (sideKeys.length === 0 && boxKeys.length === 0) return false;
    for (const key of sideKeys) {
      const state = sides.get(key);
      if (state && state.status !== 'pending') reasking.set(key, state);
      sides.delete(key);
    }
    diskSides.clear();
    for (const key of boxKeys) boxErrors.delete(key);
    diskBoxes.clear();
    if (filters) {
      filterSides.clear();
      filterBoxes.clear();
    }
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
      // content again, so its sides and boxes are asked again, and so are
      // files a git filter changes, since a new review may mean one was
      // written. Failures that depend only on the content (not an image, too
      // large, undecodable) stay cached, so nothing is retried until the
      // content changes.
      forgetDiskFailures(true);
      for (const key of reasking.keys()) if (!wanted.has(key)) reasking.delete(key);
      const contentKeys = new Set([...nextRefs.values()].map((ref) => ref.contentKey));
      for (const key of changedRatios.keys()) if (!contentKeys.has(key)) changedRatios.delete(key);
      for (const key of stillNotes.keys()) if (!contentKeys.has(key)) stillNotes.delete(key);
      for (const [key, {contentKey, side, ratio, note}] of boxFacts) {
        if (!blockCache.has(key) && !pngs.has(key) && registry.idFor(key) === undefined) {
          boxFacts.delete(key);
          continue;
        }
        if (!contentKeys.has(contentKey)) continue;
        if (ratio !== undefined && !changedRatios.has(contentKey)) changedRatios.set(contentKey, ratio);
        if (note !== undefined && side && stillNotes.get(contentKey)?.[side] === undefined) stillNotes.set(contentKey, {...stillNotes.get(contentKey), [side]: note});
      }
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
      // A git filter's verdict stands: the file was not written, or the
      // review would have changed.
      if (!forgetDiskFailures(false)) return;
      inspectAll();
      planChanged();
    },
    refFor,
    sideState,
    viewState: (fileKey: string): MediaViewState => ({compare, flipSide: flippedToBefore.has(fileKey) ? 'before' : 'after', textView: textViews.has(fileKey)}),
    /** Whether an animated GIF or WebP runs its frames here. */
    animates,
    /** The platform the viewer and player run on. */
    platform: platform ?? process.platform,
    /** What drawing a file's boxes found out, for its labels. */
    drawnFacts(ref: MediaRef): DrawnFacts {
      const changedRatio = changedRatios.get(ref.contentKey);
      const notes = stillNotes.get(ref.contentKey);
      return {...(changedRatio === undefined ? {} : {changedRatio}), ...(notes === undefined ? {} : {stillNotes: notes})};
    },
    /**
     * The side `o` opens: the only one drawn when the other failed, else the
     * one flip shows, else after, else before.
     */
    shownSide(ref: MediaRef): SideName {
      const lone = loneSide(ref);
      if (lone) return lone;
      if (ref.before && ref.after) return compare === 'flip' && flippedToBefore.has(ref.fileKey) ? 'before' : 'after';
      return ref.after ? 'after' : 'before';
    },
    /**
     * Whether the file shows a flip view that `2` or a click can swap: both
     * sides must draw, since the plan shows one side alone otherwise.
     */
    canSwap(ref: MediaRef): boolean {
      return compare === 'flip' && Boolean(ref.before && ref.after)
        && sideState(ref, 'before').status === 'ready' && sideState(ref, 'after').status === 'ready';
    },
    /**
     * Whether the file's picture is on screen in place of its source: not in
     * the text view, and nothing it draws from failed. `boxKeys` are the
     * boxes its rows show now; a failure in another compare mode or at an
     * old size does not count. An SVG's source blocks fold under its picture
     * only while this holds, so a picture that cannot draw never hides the
     * source.
     */
    pictureShown(ref: MediaRef, boxKeys: Iterable<string>): boolean {
      if (textViews.has(ref.fileKey)) return false;
      for (const side of ['before', 'after'] as const) {
        if (!ref[side]) continue;
        const status = sideState(ref, side).status;
        if (status === 'error' || status === 'stale') return false;
      }
      for (const key of boxKeys) if (boxErrors.has(key)) return false;
      return true;
    },
    setCompare(mode: CompareMode) {
      if (mode === compare) return;
      compare = mode;
      planChanged();
    },
    /** Shows the other side of one file's flip view. */
    swapFlip(fileKey: string) {
      if (flippedToBefore.has(fileKey)) flippedToBefore.delete(fileKey);
      else flippedToBefore.add(fileKey);
      planChanged();
    },
    /** Every flip view back to the after side, when the active file changes. */
    resetFlip() {
      if (flippedToBefore.size === 0) return;
      flippedToBefore.clear();
      planChanged();
    },
    toggleTextView(fileKey: string) {
      if (textViews.has(fileKey)) textViews.delete(fileKey);
      else textViews.add(fileKey);
      planChanged();
    },

    boxState(box: BoxSpec): BoxState {
      const reason = boxErrors.get(box.imageKey);
      if (reason !== undefined) return {status: 'error', reason};
      const note = boxNotes.get(box.imageKey);
      if (note !== undefined) return {status: 'note', text: note};
      const rows = blockCache.get(box.imageKey);
      if (rows) return {status: 'blocks', rows};
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
        if (boxErrors.has(key) || boxNotes.has(key) || blockCache.has(key)) continue;
        if (registry.idFor(key) !== undefined) {
          registry.touch(key);
          continue;
        }
        const rendered = pngs.get(key);
        if (rendered) {
          // An image evicted off screen comes back from the cache, without
          // a new decode, once it is near the viewport again.
          if (send(box, rendered)) changed = true;
          continue;
        }
        if (rendering.has(key)) continue;
        const ref = refs.get(fileKey);
        const sideRefs = boxSides(ref, box);
        // Rendered once inspect has proved every side it draws from; until
        // then the box is sized from the last known dimensions and drawn blank.
        if (!ref || !sideRefs || sideRefs.some((sideRef) => sides.get(sideRef.key)?.status !== 'ready')) continue;
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
      // One open per side and kind at a time: presses while one is running
      // start no second export or player.
      const side = ref[sideToOpen(ref, which)];
      const key = side ? `${side.key}|${how}` : '';
      if (side && opening.has(key)) {
        return Promise.resolve({message: `still opening ${escapeHiddenCharacters(side.path.split('/').at(-1) ?? side.path)}`, kind: 'info'});
      }
      if (side) opening.add(key);
      const done = openMedia({backend, cwd: context.cwd, tempDir, env, opener, copies, ...(platform ? {platform} : {})}, ref, which, how);
      return side ? done.finally(() => opening.delete(key)) : done;
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
