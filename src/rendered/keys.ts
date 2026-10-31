import {createHash} from 'node:crypto';
import type {FileStatus} from '../git.js';
import {PAGE_CSS_HASH, PAGE_SCRIPT_HASH} from './assets.generated.js';
import type {ChangeGroup} from './changes.js';
import {RAIL_PENDING, type OverviewInput, type RailEntry} from './page.js';

/** Bumped whenever the renderer's output changes for the same input. */
export const RENDERER_VERSION = 1;

/**
 * A page's file name: the first 20 hex of a sha256 over everything that
 * decides its content, so a page's name never carries repo text and an
 * unchanged file keeps its name. `rail` is the signature of the rendered
 * file list the page links to. `oldPath` is where a moved file was, which
 * decides the images its base side shows.
 */
export function pageKey(parts: {
  path: string;
  oldPath?: string;
  status: FileStatus;
  before?: string;
  after?: string;
  groups: readonly ChangeGroup[];
  rail: string;
}): string {
  const groups = parts.groups.map((group) => [group.kind, group.after, group.base]);
  // Named only when there is one, so a file that didn't move keeps its key.
  const moved = parts.oldPath === undefined ? [] : [parts.oldPath];
  return createHash('sha256')
    .update(JSON.stringify([RENDERER_VERSION, PAGE_CSS_HASH, PAGE_SCRIPT_HASH, parts.path, parts.status, parts.before ?? null, parts.after ?? null, groups, parts.rail, ...moved]))
    .digest('hex')
    .slice(0, 20);
}

/**
 * A TUI page's file name: its fragment's key, what its body is (rendered,
 * or a card and why), the images that fragment embeds, the files its rail
 * lists and the refs in its title. The rail's change counts are left out:
 * they come from other files' fragments, and a key that held them would
 * rewrite every page when one file's count moved. A page shows the counts
 * of the moment it was written. Whether each count is known yet is in the
 * key, so a page written before a file rendered is written again once it
 * has, and its rail never stays blank.
 */
export function renderedPageKey(parts: {fragment: string; body: string; assets: string; rail: readonly RailEntry[]; title: {repo: string; base: string; branch: string; worktree: boolean}}): string {
  const rail = parts.rail.map((entry) => [entry.path, entry.status, entry.href, entry.current, ...(entry.label === RAIL_PENDING ? ['pending'] : [])]);
  const {repo, base, branch, worktree} = parts.title;
  return createHash('sha256')
    .update(JSON.stringify([RENDERER_VERSION, parts.fragment, parts.body, parts.assets, rail, [repo, base, branch, worktree]]))
    .digest('hex')
    .slice(0, 20);
}

/** A file's stable page name for the session, which always shows its newest page. */
export function fileAlias(fileKey: string) {
  return `f-${createHash('sha256').update(fileKey).digest('hex').slice(0, 20)}`;
}

/** The signature of a rail: which files it lists, in order, and their status. */
export function railSignature(files: ReadonlyArray<{path: string; status: FileStatus}>) {
  return JSON.stringify(files.map((file) => [file.path, file.status]));
}

/** The overview's stable page name for the session. No file key holds a NUL, so no file shares it. */
export const OVERVIEW_ALIAS = fileAlias('\0overview');

/** The overview's file name: a hash of what it lists, leaving out when it was written. */
export function overviewKey({title, entries, differences}: OverviewInput): string {
  const {repo, base, branch, worktree} = title;
  return createHash('sha256')
    .update(JSON.stringify([RENDERER_VERSION, PAGE_CSS_HASH, PAGE_SCRIPT_HASH, 'overview', [repo, base, branch, worktree], entries, differences]))
    .digest('hex')
    .slice(0, 20);
}
