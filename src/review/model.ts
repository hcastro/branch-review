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
   * of this file's diff, blocks or contents fails with this reason.
   */
  rawDiffError?: string;
};

export type ReviewModel = {
  base: string;
  branch: string;
  label: string;
  metrics: BranchMetrics;
  files: ReviewFile[];
};
