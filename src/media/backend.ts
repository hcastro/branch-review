import type {MediaFormat, MediaKind, SideInfo, SideRef, VideoMeta} from './types.js';

// The jobs the UI process asks of the media worker, and their answers. The
// UI side only sees this interface, so UI tests can answer it in process.

export type InspectRequest = {cwd: string; side: SideRef; kind: MediaKind; format: MediaFormat};

// A failure. `disk`: it describes the work tree file as it was when read (it
// was gone, not a regular file, could not be opened), not the content the
// side's id names, so the same id in a later review is worth asking again.
export type JobFailure = {ok: false; state: 'stale' | 'error' | 'unavailable'; reason: string; disk?: true};

export type InspectResult =
  | {ok: true; info: SideInfo}
  | JobFailure;

export type RenderTarget = {
  cols: number;
  rows: number;
  cellPx: {w: number; h: number};
  // The picture's size inside the padded canvas of cols × rows cells.
  drawPx: {w: number; h: number};
  nearest: boolean;
};

export type RenderRequest = {
  cwd: string;
  op: 'fit' | 'difference' | 'blocks' | 'blocksDifference';
  // One side for fit and blocks, two for difference.
  sides: SideRef[];
  kind: MediaKind;
  // The format the extension names; the bytes must agree.
  format?: MediaFormat;
  target: RenderTarget;
  // Draw a checkerboard behind transparent pixels.
  checker: boolean;
  colorDepth?: 2 | 3;
  // An animated GIF or WebP drawn with every frame, within these caps;
  // without it, or past a cap, the first frame alone.
  frames?: {max: number; maxBytes: number};
};

// The frames after the first, each drawn at the first one's size, and how
// long the first one shows.
export type Animation = {frames: Array<{png: Uint8Array; delayMs: number}>; firstDelayMs: number};

export type RenderResult =
  // `passthrough`: the source PNG as it is, because the image library is
  // missing; the terminal scales it into the box.
  // `animation`: the frames that follow `png`, when frames were asked for.
  // `note`: why an animation shows its first frame only.
  | {ok: true; png: Uint8Array; passthrough?: true; changedRatio?: number; animation?: Animation; note?: string}
  // Block previews: per cell the top pixel's RGB then the bottom pixel's, as
  // 0xRRGGBB, or CLEAR_PIXEL (blocks.ts) outside the picture.
  | {ok: true; cells: Uint32Array; cols: number; rows: number; changedRatio?: number}
  | JobFailure;

// One side of a video: its metadata from ffprobe, and a strip of
// `frameCount` frames from ffmpeg, evenly spaced through it. The strip is
// `stripCols` × `stripRows` cells of `stripCellPx`, each frame letterboxed
// into a `framePx` box, frames `gapCols` cells apart.
export type VideoRequest = {
  cwd: string;
  side: SideRef;
  format: MediaFormat;
  frameCount: 2 | 4;
  framePx: {w: number; h: number};
  stripCellPx: {w: number; h: number};
  stripCols: number;
  stripRows: number;
  gapCols: number;
  // A block preview: the strip comes back as cells (see RenderResult).
  blocks?: boolean;
};

// `meta` is null when ffprobe is missing or failed; `strip` (or `cells`)
// null when no frame could be drawn, with `note` saying why. `times` are
// the frames' times in ms.
export type VideoResult =
  | {ok: true; meta: VideoMeta | null; strip: Uint8Array | null; cells?: Uint32Array; times: number[]; note?: string}
  | JobFailure;

export type ExportRequest = {cwd: string; side: SideRef; format: MediaFormat; dir: string};
export type ExportResult = {ok: true; path: string} | JobFailure;

export interface MediaBackend {
  // `priority`: lower runs first; boxes on screen ask with 0.
  inspect(req: InspectRequest, signal: AbortSignal, priority?: number): Promise<InspectResult>;
  render(req: RenderRequest, signal: AbortSignal, priority?: number): Promise<RenderResult>;
  exportCopy(req: ExportRequest, signal: AbortSignal): Promise<ExportResult>;
  // Absent in a backend without video support: videos then show why.
  video?(req: VideoRequest, signal: AbortSignal, priority?: number): Promise<VideoResult>;
  // Ends the worker at once (exit hook): synchronous.
  dispose(): void;
  // Why previews are off for the session (the worker kept failing), or null.
  disabledReason?(): string | null;
}

export type WorkerRequest =
  | ({type: 'inspect'} & InspectRequest)
  | ({type: 'render'} & RenderRequest)
  | ({type: 'video'} & VideoRequest)
  | ({type: 'exportCopy'} & ExportRequest);
