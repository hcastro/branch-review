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
};

export type ReviewModel = {
  base: string;
  branch: string;
  label: string;
  metrics: BranchMetrics;
  files: ReviewFile[];
};
