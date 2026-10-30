import type {MediaFormat, MediaKind, SideInfo, SideRef} from './types.js';

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
};

export type RenderResult =
  // `passthrough`: the source PNG as it is, because the image library is
  // missing; the terminal scales it into the box.
  | {ok: true; png: Uint8Array; passthrough?: true; changedRatio?: number}
  // Block previews: per cell the top pixel's RGB then the bottom pixel's.
  | {ok: true; cells: Uint32Array; cols: number; rows: number}
  | JobFailure;

export type ExportRequest = {cwd: string; side: SideRef; format: MediaFormat; dir: string};
export type ExportResult = {ok: true; path: string} | JobFailure;

export interface MediaBackend {
  // `priority`: lower runs first; boxes on screen ask with 0.
  inspect(req: InspectRequest, signal: AbortSignal, priority?: number): Promise<InspectResult>;
  render(req: RenderRequest, signal: AbortSignal, priority?: number): Promise<RenderResult>;
  exportCopy(req: ExportRequest, signal: AbortSignal): Promise<ExportResult>;
  // Ends the worker at once (exit hook): synchronous.
  dispose(): void;
  // Why previews are off for the session (the worker kept failing), or null.
  disabledReason?(): string | null;
}

export type WorkerRequest =
  | ({type: 'inspect'} & InspectRequest)
  | ({type: 'render'} & RenderRequest)
  | ({type: 'exportCopy'} & ExportRequest);
