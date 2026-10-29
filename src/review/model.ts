import type {BranchMetrics, FileMetrics} from '../sections.js';
import type {FileStatus} from '../git.js';

export type ReviewBlock = {
  id: string;
  filePath: string;
  signature?: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lineStart: number;
  lineEnd: number;
  functionHeader?: string;
  rawDiff: string;
  addedCode: string;
};

export type ReviewFile = {
  path: string;
  oldPath?: string;
  status: FileStatus;
  signature?: string;
  metrics: FileMetrics;
  rawDiff: string;
  renderedLines: string[];
  blocks: ReviewBlock[];
  /**
   * Set when this file's diff could not be read or rendered. rawDiff and
   * blocks are kept when only rendering failed, so copy actions still work;
   * renderedLines is empty.
   */
  error?: string;
  /**
   * Set when rawDiff can't be copied: the diff failed to load (rawDiff is
   * empty), or git printed it as bytes that are not valid UTF-8. Every copy
   * of this file's diff or blocks fails with this reason. Copy file contents
   * is not blocked by it: that reads the file itself and fails only when the
   * file can't be read, is not UTF-8 text, or its name is not UTF-8
   * (`pathError`).
   */
  rawDiffError?: string;
  /**
   * Set when git listed the file's name as bytes that are not valid UTF-8.
   * `path` then holds octal escapes for those bytes and names no real file,
   * so every copy of this file, its path included, fails with this reason.
   */
  pathError?: string;
};

export type ReviewModel = {
  base: string;
  branch: string;
  label: string;
  metrics: BranchMetrics;
  files: ReviewFile[];
};
