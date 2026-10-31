import type {DiffRange} from '../git.js';
import {classifyMedia, isBinaryPatch, isRegularFilePatch} from '../media/classify.js';
import type {ReviewFile} from '../review/model.js';

export type RenderableKind = 'markdown' | 'raster' | 'svg';

// At least one character before the extension: `.md` alone is a dotfile.
const MARKDOWN = /^.+\.(?:md|markdown|mdown|mkd)$/i;

/**
 * What kind of rendered page a review file gets, or null for none. Markdown
 * goes by extension and needs a regular text file's patch, so a symlink
 * named `.md` or a binary file never renders. Images and SVG are whatever
 * the media classifier says they are. Pure: reads only the patch.
 */
export function renderableKind(file: ReviewFile, range: Pick<DiffRange, 'includeWorktree'>): RenderableKind | null {
  if (file.pathError || file.error) return null;
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (MARKDOWN.test(name)) {
    return isRegularFilePatch(file.rawDiff) && !isBinaryPatch(file.rawDiff) ? 'markdown' : null;
  }
  const media = classifyMedia(file, range);
  return media?.kind === 'raster' || media?.kind === 'svg' ? media.kind : null;
}

/**
 * The page a markdown file gets when its review entry failed, or null for
 * any other file. The review keeps the patch when only the terminal diff
 * (delta) or the line counts failed, and a page needs only the patch, so
 * that file renders. With no patch, or with a name that isn't UTF-8, the
 * page is a card with the reason.
 */
export function failedMarkdownPage(file: ReviewFile, range: Pick<DiffRange, 'includeWorktree'>): {render: true} | {reason: string} | null {
  if ((!file.error && !file.pathError) || !MARKDOWN.test(file.path.slice(file.path.lastIndexOf('/') + 1))) return null;
  if (file.pathError) return {reason: file.pathError};
  if (file.rawDiff === '') return {reason: file.error!};
  return renderableKind({...file, error: undefined}, range) === 'markdown' ? {render: true} : null;
}
