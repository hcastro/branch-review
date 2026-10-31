import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {oneLine} from './source.js';

// The session's rendered pages: self-contained files in `rendered/` inside
// the 0700 session dir, which is removed at exit. A page is named by its
// key, a hash of what decides its content, and written once, read-only,
// under a temp name then renamed, so a reader never sees half a page and
// nothing rewrites one a browser has open. Each file also has a stable
// name, a hard link to its newest page, which is what pages link to, so a
// link never lands on an old version. No name ever carries repo text.

const KEY = /^[0-9a-f]{20}$/;
const ALIAS = /^f-[0-9a-f]{20}$/;
// A page shown this recently may still be open somewhere.
const SHOWN_KEEP_MS = 2 * 60_000;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;

/** Why a write failed, in a few words a toast can show. */
export function writeErrorReason(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOSPC' ? 'disk full'
    : code === 'ENOTDIR' || code === 'EEXIST' ? 'not a directory'
      : code === 'EACCES' || code === 'EPERM' ? 'permission denied'
        : code === 'EROFS' ? 'read-only file system' : oneLine(error);
}

export type SiteKeep = {
  /** Each file's stable name and its newest page. */
  current: ReadonlyMap<string, string>;
  /** Pages a file showed before its newest, worth keeping while there is room. */
  previous: ReadonlySet<string>;
};

export function createRenderedSite({tempDir, now = Date.now, maxBytes = DEFAULT_MAX_BYTES}: {tempDir: () => string; now?: () => number; maxBytes?: number}) {
  let dir: string | null = null;
  const shownAt = new Map<string, number>();
  const writtenAt = new Map<string, number>();
  let temps = 0;

  const folder = () => {
    if (dir) return dir;
    const made = path.join(tempDir(), 'rendered');
    fs.mkdirSync(made, {recursive: true, mode: 0o700});
    dir = made;
    return made;
  };
  const fileOf = (name: string) => path.join(folder(), `${name}.html`);
  const check = (name: string, pattern: RegExp, what: string) => {
    if (!pattern.test(name)) throw new Error(`not a page ${what}: ${name.slice(0, 40)}`);
  };
  const tempName = () => path.join(folder(), `.tmp-${process.pid}-${(temps += 1)}`);

  const fail = (error: unknown): never => {
    throw new Error(`can't write the page: ${writeErrorReason(error)}`);
  };

  const remove = (file: string) => {
    try {
      fs.rmSync(file, {force: true});
    } catch {
      // Best effort: the session dir goes at exit.
    }
  };

  return {
    /** Writes the page `key` names, unless it is already there. */
    write(key: string, html: string) {
      check(key, KEY, 'key');
      let temp: string | null = null;
      try {
        const target = fileOf(key);
        if (fs.existsSync(target)) return;
        temp = tempName();
        fs.writeFileSync(temp, html, {flag: 'wx', mode: 0o400});
        fs.renameSync(temp, target);
        writtenAt.set(key, now());
      } catch (error) {
        if (temp) remove(temp);
        fail(error);
      }
    },
    /** Points the stable name `alias` at the page `key`, in one rename. */
    alias(alias: string, key: string) {
      check(alias, ALIAS, 'name');
      check(key, KEY, 'key');
      let temp: string | null = null;
      try {
        temp = tempName();
        fs.linkSync(fileOf(key), temp);
        fs.renameSync(temp, fileOf(alias));
      } catch (error) {
        if (temp) remove(temp);
        fail(error);
      }
    },
    has(key: string) {
      return KEY.test(key) && dir !== null && fs.existsSync(fileOf(key));
    },
    /** The page's file URL, with our own hash values after `#`. Counts as shown. */
    url(key: string, hash?: string) {
      check(key, KEY, 'key');
      shownAt.set(key, now());
      const href = pathToFileURL(fileOf(key)).href;
      return hash ? `${href}#${hash}` : href;
    },
    /**
     * Removes every page no file shows now or showed just before, unless it
     * was shown in the last two minutes, and every stable name of a file that
     * left the review. Past the disk budget, kept pages that no file shows
     * now go too, oldest first.
     */
    prune({current, previous}: SiteKeep) {
      if (!dir) return;
      const at = now();
      const currentKeys = new Set(current.values());
      const kept = new Map<string, {bytes: number; written: number}>();
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of names) {
        const name = entry.replace(/\.html$/, '');
        const file = path.join(dir, entry);
        if (ALIAS.test(name)) {
          if (!current.has(name)) remove(file);
          continue;
        }
        if (!KEY.test(name)) continue;
        const recent = at - (shownAt.get(name) ?? -Infinity) < SHOWN_KEEP_MS;
        if (!currentKeys.has(name) && !previous.has(name) && !recent) {
          remove(file);
          shownAt.delete(name);
          writtenAt.delete(name);
          continue;
        }
        try {
          const stat = fs.statSync(file);
          kept.set(name, {bytes: stat.size, written: writtenAt.get(name) ?? 0});
        } catch {
          // Gone already.
        }
      }

      let total = [...kept.values()].reduce((sum, page) => sum + page.bytes, 0);
      const spare = [...kept].filter(([name]) => !currentKeys.has(name)).sort((left, right) => left[1].written - right[1].written);
      for (const [name, page] of spare) {
        if (total <= maxBytes) break;
        remove(path.join(dir, `${name}.html`));
        total -= page.bytes;
      }
    },
  };
}

export type RenderedSite = ReturnType<typeof createRenderedSite>;
