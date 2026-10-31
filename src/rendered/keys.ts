import {createHash} from 'node:crypto';
import type {FileStatus} from '../git.js';
import {PAGE_CSS_HASH} from './assets.generated.js';
import type {ChangeGroup} from './changes.js';

/** Bumped whenever the renderer's output changes for the same input. */
export const RENDERER_VERSION = 1;

/**
 * A page's file name: the first 20 hex of a sha256 over everything that
 * decides its content, so a page's name never carries repo text and an
 * unchanged file keeps its name. `rail` is the signature of the rendered
 * file list the page links to.
 */
export function pageKey(parts: {
  path: string;
  status: FileStatus;
  before?: string;
  after?: string;
  groups: readonly ChangeGroup[];
  rail: string;
}): string {
  const groups = parts.groups.map((group) => [group.kind, group.after, group.base]);
  return createHash('sha256')
    .update(JSON.stringify([RENDERER_VERSION, PAGE_CSS_HASH, parts.path, parts.status, parts.before ?? null, parts.after ?? null, groups, parts.rail]))
    .digest('hex')
    .slice(0, 20);
}

/** The signature of a rail: which files it lists, in order, and their status. */
export function railSignature(files: ReadonlyArray<{path: string; status: FileStatus}>) {
  return JSON.stringify(files.map((file) => [file.path, file.status]));
}
