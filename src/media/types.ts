// Shared shapes for media previews: what a media file is (from its diff),
// what is known about each side's bytes, and what the terminal can draw.

export type MediaKind = 'raster' | 'svg' | 'video';
export type MediaFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'svg' | 'mp4' | 'mov' | 'webm';
export type SideName = 'before' | 'after';

export type SideRef = {
  side: SideName;
  // Where the bytes come from: a git object, or the file in the work tree.
  source: 'blob' | 'worktree';
  // Repo-relative path for this side (the old path for a renamed before side).
  path: string;
  // Hex object id from the diff's `index` line, 7 to 64 characters. Every byte
  // read for this side is hashed and checked against it.
  abbrevId: string;
  key: string;
};

export type MediaRef = {
  // reviewFileKey of the file.
  fileKey: string;
  kind: MediaKind;
  // From the extension; the worker confirms it from magic bytes.
  format: MediaFormat;
  before?: SideRef;
  after?: SideRef;
  // An SVG whose diff has text hunks, shown under its picture.
  hasSourceBlocks: boolean;
  // Names both sides' content: equal keys mean equal bytes to draw.
  contentKey: string;
};

export type VideoMeta = {
  durationMs: number;
  width: number;
  height: number;
  // ffprobe's codec_name, escaped and capped at 16 characters.
  codec: string;
  fps: number;
  bitRate?: number;
  audio?: string;
};

export type SideInfo = {
  // Full hex object id, verified against the bytes.
  oid: string;
  bytes: number;
  format: MediaFormat;
  // Pixels. An SVG without a size has the browser default of 300 × 150.
  width: number;
  height: number;
  // 1 for stills; the frame count of an animated GIF, WebP or APNG.
  frames: number;
  // An animated GIF or WebP: how long one pass of its frames takes.
  durationMs?: number;
  hasAlpha: boolean;
  // Filled by the video job, not by inspect: undefined while it runs, null
  // when it failed or no ffprobe was found.
  video?: VideoMeta | null;
};

export type SideState =
  | {status: 'pending'}
  | {status: 'ready'; info: SideInfo}
  // The bytes changed on disk after the review was built.
  | {status: 'stale'}
  // `reason` is one line, already escaped.
  | {status: 'error'; reason: string};

export type GraphicsProtocol = 'kitty' | 'blocks' | 'none';

export type GraphicsCaps = {
  protocol: GraphicsProtocol;
  cellPx: {w: number; h: number};
  cellPxSource: 'csi16' | 'csi14' | 'default';
  // 2 = 256 colors, 3 = 24-bit.
  colorDepth: 2 | 3;
  animation: boolean;
  tmux: boolean;
  // The identity behind the decision ('ghostty 1.3.2', 'kitty',
  // 'Apple_Terminal'), for tests and messages.
  terminal: string;
  // The detection window closed without the terminal's DA1 reply, so late
  // replies may still arrive as input.
  detectionTimedOut: boolean;
  // The start of a reply still arriving when the app took stdin, such as
  // `ESC[?62;22`; the app's next input may be the rest of it.
  replyHead?: string;
  // Keys typed during detection, which the app reads before the rest of
  // `replyHead`, so that input is not mistaken for the reply's.
  keysBeforeReply?: string;
};

export const NO_GRAPHICS: GraphicsCaps = Object.freeze({
  protocol: 'none',
  cellPx: Object.freeze({w: 10, h: 20}),
  cellPxSource: 'default',
  colorDepth: 2,
  animation: false,
  tmux: false,
  terminal: '',
  detectionTimedOut: false,
}) as GraphicsCaps;

// The compare view chosen for a modified image (sticky for the session), the
// side flip mode shows, and whether the file shows as text instead.
export type CompareMode = 'sideBySide' | 'flip' | 'difference';
export type MediaViewState = {compare: CompareMode; flipSide: SideName; textView: boolean};

// A clickable range of cells on a media text row.
export type MediaSpan = {id: string; start: number; end: number};
