import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {DiffRange} from '../git.js';
import {mediaTempParent} from '../media/tempDir.js';
import type {Opener} from '../media/openExternal.js';
import type {ReviewModel} from '../review/model.js';
import {renderToDirectory} from './renderOut.js';
import type {RunTool} from './run.js';
import {createSurface, type Surface} from './surface.js';

// `--browser`: builds the page `r` opens, as `--export-html` does, and
// opens it where `r` would, with no UI. The run exits once the page is
// open, so the page can't live in the session dir, which goes at exit. It
// gets a folder per repo and range under the temp dir: running the same
// review again replaces it, and the OS's temp cleanup removes the rest.

/**
 * The folder that holds every review's folder. It names the user, so each
 * user on a shared temp dir, such as /tmp on Linux, gets one of their own.
 */
export function browserPagesParent(env: NodeJS.ProcessEnv) {
  const uid = process.getuid?.();
  return path.join(mediaTempParent(env), uid === undefined ? 'branch-review-pages' : `branch-review-pages-${uid}`);
}

/** The folder `--browser` writes a review's page to, the same on every run of that review. */
export function browserPagesDir(env: NodeJS.ProcessEnv, cwd: string, range: DiffRange) {
  const key = createHash('sha256').update(JSON.stringify([cwd, range.base, range.branch, range.diffArg, range.includeWorktree])).digest('hex').slice(0, 16);
  return path.join(browserPagesParent(env), key);
}

/**
 * Makes the folder that holds every review's folder, readable only by
 * this user. On a shared temp dir, a folder that someone else made under
 * this user's name, or a symlink in its place, is refused.
 */
function claimPagesParent(dir: string) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const stat = fs.lstatSync(dir);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new Error(`${dir} isn't a folder of this user's`);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
}

export type BrowserOutcome = {ok: true; message: string; page: string} | {ok: false; message: string};

/**
 * Writes the review's page and opens it. A cmux call still running when the
 * page has opened, or when `signal` aborts at exit, is killed, so no split
 * opens after the run has ended.
 */
export async function openReviewInBrowser({cwd, range, review, env, platform, opener, run, findTool, now = Date.now, signal}: {
  cwd: string;
  range: DiffRange;
  review: ReviewModel;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  opener: Opener;
  run: RunTool;
  findTool: (name: string) => string | null;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<BrowserOutcome> {
  const surface = createSurface({env, run, findTool, opener, platform});
  signal?.addEventListener('abort', () => surface.dispose(), {once: true});
  try {
    return await writeAndShow(surface, {cwd, range, review, env, now});
  } finally {
    surface.dispose();
  }
}

async function writeAndShow(surface: Surface, {cwd, range, review, env, now}: {cwd: string; range: DiffRange; review: ReviewModel; env: NodeJS.ProcessEnv; now: () => number}): Promise<BrowserOutcome> {
  // Over SSH, or with no program to open a page, nothing is built.
  if (surface.refusal) return {ok: false, message: surface.refusal};
  const outDir = browserPagesDir(env, cwd, range);
  claimPagesParent(path.dirname(outDir));
  const report = await renderToDirectory({cwd, range, review, outDir, outLabel: outDir, now});
  if (report.page === null) return {ok: false, message: 'nothing to open · no files changed on this branch'};
  const page = path.join(outDir, report.page);
  const shown = await surface.show(pathToFileURL(page).href);
  if ('refused' in shown) return {ok: false, message: shown.refused};
  if ('superseded' in shown) return {ok: false, message: 'the page did not open'};
  const count = report.files.length;
  return {ok: true, message: `⇗ ${count} file${count === 1 ? '' : 's'} ${shown.message}`, page};
}
