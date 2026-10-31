import {escapeHiddenCharacters} from '../../controlChars.js';
import {
  FileTooLargeError,
  MAX_FILE_CONTENT_BYTES,
  catFileBlobOperation,
  gitBlobId,
  objectFormatOperation,
  readWorktreeBytes,
  runOperationAsync,
  type ObjectFormat,
} from '../../git.js';
import {createLru} from '../lru.js';
import type {MediaKind, SideRef} from '../types.js';

// Reads one side of a media file and proves the bytes are the ones the
// review's diff named: every read is hashed as a git blob and must start with
// the id from the `index` line. Bytes that do not match are never drawn.

const MIB = 1024 * 1024;

const BYTE_LIMITS: Record<MediaKind, number> = {
  raster: MAX_FILE_CONTENT_BYTES,
  svg: 4 * MIB,
  // Video frames come from ffmpeg reading the file itself; only headers are
  // read here.
  video: MAX_FILE_CONTENT_BYTES,
};

// After a mismatch, how long to wait before reading the work tree file again
// to tell a write in progress from a filter.
const REREAD_DELAY_MS = 500;
const CACHE_BYTES = 64 * MIB;

export const STALE_REASON = 'changed on disk · refreshing';
export const FILTER_REASON = 'preview unavailable: a git filter changes this file (shown as text)';

// `disk`: the failure describes the work tree file as it was when read, not
// the content the side's id names, so the same id is worth reading again
// later. A filter verdict depends on the disk too: the file read the same
// twice but not as the id, and writing it back makes it readable. It is
// also tagged `filter`, since only a write, which brings a new review, can
// change it. The size cap follows from the content and is not tagged.
export type ReadResult =
  | {ok: true; bytes: Buffer; oid: string}
  | {ok: false; state: 'stale' | 'error'; reason: string; disk?: true; filter?: true};

type ReaderOptions = {
  sleep?: (ms: number) => Promise<void>;
};

// A work tree read that failed because of the file's state at the time:
// gone, a symlink, not a regular file, outside the repo, or unreadable.
class DiskStateError extends Error {}

function reasonOf(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return escapeHiddenCharacters(message.split('\n')[0] || 'could not read the file');
}

export function createSideReader({sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))}: ReaderOptions = {}) {
  const formats = new Map<string, Promise<ObjectFormat>>();
  // Keyed by the side's key, which names its expected content: bytes verified
  // once are the right bytes for that key for the whole session.
  const verified = createLru<{bytes: Buffer; oid: string}>(CACHE_BYTES, (entry) => entry.bytes.byteLength);

  const formatFor = (cwd: string) => {
    let format = formats.get(cwd);
    if (!format) {
      format = runOperationAsync(objectFormatOperation(cwd));
      formats.set(cwd, format);
      // A failed lookup is asked again next time.
      format.catch(() => formats.delete(cwd));
    }
    return format;
  };

  const readOnce = async (cwd: string, side: SideRef, limit: number) => {
    if (side.source === 'blob') return runOperationAsync(catFileBlobOperation(cwd, side.abbrevId, limit, side.path));
    try {
      return await readWorktreeBytes(cwd, side.path, limit);
    } catch (error) {
      if (error instanceof FileTooLargeError) throw error;
      throw new DiskStateError(reasonOf(error));
    }
  };

  async function read(cwd: string, side: SideRef, kind: MediaKind): Promise<ReadResult> {
    const cached = verified.get(side.key);
    // Only bytes that hashed to this side's id: a key that ever named other
    // content reads again.
    if (cached?.oid.startsWith(side.abbrevId)) return {ok: true, ...cached};
    if (cached) verified.delete(side.key);

    try {
      const format = await formatFor(cwd);
      const limit = BYTE_LIMITS[kind];
      const bytes = await readOnce(cwd, side, limit);
      let oid = gitBlobId(bytes, format);
      let good = bytes;
      if (!oid.startsWith(side.abbrevId)) {
        // A blob always hashes to its own id; only a work tree file can differ.
        if (side.source === 'blob') return {ok: false, state: 'error', reason: 'object bytes do not match their id'};

        await sleep(REREAD_DELAY_MS);
        const again = await readOnce(cwd, side, limit);
        oid = gitBlobId(again, format);
        if (!oid.startsWith(side.abbrevId)) {
          // Still changing: a write in progress, which the watcher's refresh
          // brings in with a new id. The same bytes twice: a clean filter
          // (eol conversion, LFS) turns them into what git stores.
          return again.equals(bytes)
            ? {ok: false, state: 'error', reason: FILTER_REASON, disk: true, filter: true}
            : {ok: false, state: 'stale', reason: STALE_REASON, disk: true};
        }
        good = again;
      }

      verified.set(side.key, {bytes: good, oid});
      return {ok: true, bytes: good, oid};
    } catch (error) {
      if (error instanceof DiskStateError) return {ok: false, state: 'error', reason: error.message, disk: true};
      return {ok: false, state: 'error', reason: reasonOf(error)};
    }
  }

  return {read};
}

export type SideReader = ReturnType<typeof createSideReader>;
