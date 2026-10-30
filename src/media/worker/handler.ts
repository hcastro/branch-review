import fs from 'node:fs';
import path from 'node:path';
import type {ExportResult, InspectResult, RenderResult, WorkerRequest} from '../backend.js';
import {formatLabel} from '../layout.js';
import type {MediaFormat, SideRef} from '../types.js';
import {createSideReader, type SideReader} from './read.js';
import {createRenderer, type SharpLoader} from './render.js';
import {magicFormat, sniffImage} from './sniff.js';

// The media worker's jobs, without the process around them, so tests can run
// them in process.

// The terminal decodes PNG itself, so without the image library a PNG this
// small is still sent as it is.
const MAX_PASSTHROUGH_BYTES = 4 * 1024 * 1024;

// Copies for a viewer are named from this list only, never from the repo.
const EXTENSIONS: Partial<Record<MediaFormat, string>> = {png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', avif: 'avif'};

type HandlerOptions = {
  loadSharp?: SharpLoader;
  reader?: SideReader;
};

export type WorkerResult = InspectResult | RenderResult | ExportResult;

export function createWorkerHandler({loadSharp, reader = createSideReader()}: HandlerOptions = {}) {
  const renderer = createRenderer(loadSharp ? {loadSharp} : {});
  let exports = 0;

  async function inspect(request: Extract<WorkerRequest, {type: 'inspect'}>): Promise<InspectResult> {
    if (request.kind !== 'raster') return {ok: false, state: 'error', reason: `${request.kind} previews are not supported`};
    const read = await reader.read(request.cwd, request.side, request.kind);
    if (!read.ok) return read;
    const sniffed = sniffImage(read.bytes, request.format);
    if (!sniffed.ok) return {ok: false, state: 'error', reason: sniffed.reason};
    const {ok: _ok, ...facts} = sniffed;
    return {ok: true, info: {oid: read.oid, bytes: read.bytes.byteLength, ...facts}};
  }

  // A side's bytes, verified, with the facts their header gives.
  async function readImage(request: Extract<WorkerRequest, {type: 'render'}>, side: SideRef) {
    const read = await reader.read(request.cwd, side, request.kind);
    if (!read.ok) return read;
    const format = request.format ?? magicFormat(read.bytes);
    if (!format) return {ok: false as const, state: 'error' as const, reason: 'not an image'};
    const sniffed = sniffImage(read.bytes, format);
    if (!sniffed.ok) return {ok: false as const, state: 'error' as const, reason: sniffed.reason};
    return {ok: true as const, bytes: read.bytes, format, sniffed};
  }

  async function render(request: Extract<WorkerRequest, {type: 'render'}>): Promise<RenderResult> {
    const sides = request.op === 'difference' ? 2 : 1;
    if ((request.op !== 'fit' && request.op !== 'difference') || request.kind !== 'raster' || request.sides.length !== sides) {
      return {ok: false, state: 'error', reason: `${request.op} view is not supported for ${request.kind} files`};
    }

    if (request.op === 'difference') {
      const before = await readImage(request, request.sides[0]!);
      if (!before.ok) return before;
      const after = await readImage(request, request.sides[1]!);
      if (!after.ok) return after;
      // No passthrough here: the terminal can draw a PNG, not compare two.
      return renderer.difference(before.bytes, after.bytes, request.target, request.checker);
    }

    const image = await readImage(request, request.sides[0]!);
    if (!image.ok) return image;
    const {bytes, format, sniffed} = image;
    const result = await renderer.fit(bytes, sniffed, request.target, request.checker);
    if (!result.ok && result.state === 'unavailable' && format === 'png' && bytes.byteLength <= MAX_PASSTHROUGH_BYTES) {
      return {ok: true, png: bytes, passthrough: true};
    }
    return result;
  }

  async function exportCopy(request: Extract<WorkerRequest, {type: 'exportCopy'}>): Promise<ExportResult> {
    const extension = EXTENSIONS[request.format];
    if (!extension || !path.isAbsolute(request.dir)) return {ok: false, state: 'error', reason: 'cannot open this file type'};
    const read = await reader.read(request.cwd, request.side, 'raster');
    if (!read.ok) return read;
    // Only an allow-listed format confirmed by its magic bytes is handed to
    // a viewer, so opening it can never launch a script or an app.
    if (magicFormat(read.bytes) !== request.format) return {ok: false, state: 'error', reason: `not a ${formatLabel(request.format)} image`};

    try {
      let dir: string;
      for (;;) {
        exports += 1;
        dir = path.join(request.dir, `open-${exports}`);
        try {
          fs.mkdirSync(dir, {mode: 0o700});
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      const target = path.join(dir, `${request.side.side}.${extension}`);
      fs.writeFileSync(target, read.bytes, {flag: 'wx', mode: 0o600});
      return {ok: true, path: target};
    } catch (error) {
      return {ok: false, state: 'error', reason: (error instanceof Error ? error.message : String(error)).split('\n')[0]!};
    }
  }

  async function handle(request: WorkerRequest): Promise<WorkerResult> {
    try {
      if (request.type === 'inspect') return await inspect(request);
      if (request.type === 'render') return await render(request);
      if (request.type === 'exportCopy') return await exportCopy(request);
      return {ok: false, state: 'error', reason: 'unknown media job'};
    } catch (error) {
      return {ok: false, state: 'error', reason: (error instanceof Error ? error.message : String(error)).split('\n')[0] || 'media job failed'};
    }
  }

  return {handle};
}
