import {
  getChangedFileEntries,
  getColoredFileDiff,
  getFileMetricsMap,
  getRawFileDiff,
  type DiffRange,
} from '../git.js';
import type {BranchMetrics, FileMetrics} from '../sections.js';
import {parseUnifiedDiffBlocks} from '../blocks/parse.js';
import type {ReviewFile, ReviewModel} from './model.js';

type BuildReviewModelOptions = {
  cwd: string;
  range: DiffRange;
  width: number;
};

function emptyMetrics(path: string): FileMetrics {
  return {
    path,
    additions: 0,
    deletions: 0,
    changedLines: 0,
  };
}

function calculateBranchMetrics(files: ReviewFile[]): BranchMetrics {
  return {
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + file.metrics.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.metrics.deletions, 0),
    changedLines: files.reduce((sum, file) => sum + file.metrics.changedLines, 0),
  };
}

function splitRenderedLines(diff: string) {
  return diff.trimEnd().split('\n').filter(Boolean);
}

export function buildReviewModel({cwd, range, width}: BuildReviewModelOptions): ReviewModel {
  const entries = getChangedFileEntries(cwd, range);
  const metricsMap = getFileMetricsMap(cwd, range);
  const untrackedFiles = new Set(
    entries.filter((entry) => entry.status === 'untracked').map((entry) => entry.path),
  );

  const files = entries.map((entry): ReviewFile => {
    const rawDiff = getRawFileDiff(cwd, range, entry.path, untrackedFiles);
    const renderedDiff = getColoredFileDiff(cwd, range, entry.path, width, untrackedFiles);

    return {
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      metrics: metricsMap.get(entry.path) ?? emptyMetrics(entry.path),
      rawDiff,
      renderedLines: splitRenderedLines(renderedDiff),
      blocks: parseUnifiedDiffBlocks(rawDiff, entry.path),
    };
  });

  const branch = range.includeWorktree ? `${range.branch} + worktree` : range.branch;

  return {
    base: range.base,
    branch,
    label: `${range.base}...${branch}`,
    metrics: calculateBranchMetrics(files),
    files,
  };
}
