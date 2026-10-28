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
};

export type ReviewModel = {
  base: string;
  branch: string;
  label: string;
  metrics: BranchMetrics;
  files: ReviewFile[];
};
