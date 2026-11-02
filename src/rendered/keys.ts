import {createHash} from 'node:crypto';
import type {FileStatus} from '../git.js';
import {PAGE_CSS_HASH, PAGE_SCRIPT_HASH} from './assets.generated.js';
import type {ChangeGroup} from './changes.js';

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

// The hex digits of a file's stable page name.
const ALIAS_HEX = 20;

/** A file's stable page name for the session, which always shows its newest page. */
export function fileAlias(fileKey: string) {
  return `f-${createHash('sha256').update(fileKey).digest('hex').slice(0, ALIAS_HEX)}`;
}

/** A link to another file's page in the review, `f-….html` with any `#anchor`: the page name it names is group 1. */
export const FILE_ALIAS_LINK = new RegExp(`^(f-[0-9a-f]{${ALIAS_HEX}})\\.html(?:#.*)?$`);

/** The signature of a rail: which files it lists, in order, and their status. */
export function railSignature(files: ReadonlyArray<{path: string; status: FileStatus}>) {
  return JSON.stringify(files.map((file) => [file.path, file.status]));
}
