import {
  MissingToolError,
  getChangedFileEntries,
  getFileMetricsMap,
  getRawFileDiff,
  renderDiffForDisplay,
  withPrivateIndex,
  type ChangedFileEntry,
  type DiffRange,
} from '../git.js';
import {buildDiffSections, type BranchMetrics, type DiffSection, type FileMetrics} from '../sections.js';
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

function hashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] || 'unknown error';
}

// One file that can't be diffed or rendered becomes a file with `error` set
// instead of failing the whole review. A missing git or delta affects every
// file, so it still fails the build.
function buildReviewFile(
  {cwd, range, width}: BuildReviewModelOptions,
  entry: ChangedFileEntry,
  metrics: FileMetrics,
  untrackedFiles: ReadonlySet<string>,
): ReviewFile {
  let rawDiff = '';
  let renderedLines: string[] = [];
  let error: string | undefined;

  try {
    rawDiff = getRawFileDiff(cwd, range, entry.path, untrackedFiles, entry.oldPath);
    renderedLines = splitRenderedLines(renderDiffForDisplay(cwd, rawDiff, width));
  } catch (caught) {
    if (caught instanceof MissingToolError) throw caught;
    error = errorMessage(caught);
    renderedLines = [];
  }

  return {
    path: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    signature: hashText(`${entry.status}:${error ?? ''}:${rawDiff}`),
    metrics,
    rawDiff,
    renderedLines,
    blocks: parseUnifiedDiffBlocks(rawDiff, entry.path),
    ...(error === undefined ? {} : {error}),
  };
}

export function buildReviewModel(options: BuildReviewModelOptions): ReviewModel {
  const {cwd, range} = options;

  return withPrivateIndex(cwd, () => {
    const entries = getChangedFileEntries(cwd, range);
    const metricsMap = getFileMetricsMap(cwd, range);
    const untrackedFiles = new Set(
      entries.filter((entry) => entry.status === 'untracked').map((entry) => entry.path),
    );

    const files = entries.map((entry) => buildReviewFile(
      options,
      entry,
      metricsMap.get(entry.path) ?? emptyMetrics(entry.path),
      untrackedFiles,
    ));

    const branch = range.includeWorktree ? `${range.branch} + worktree` : range.branch;

    return {
      base: range.base,
      branch,
      label: `${range.base}...${branch}`,
      metrics: calculateBranchMetrics(files),
      files,
    };
  });
}

export function buildReviewSections(review: Pick<ReviewModel, 'files'>): DiffSection[] {
  return buildDiffSections(
    review.files.map((file) => ({
      path: file.path,
      signature: file.signature,
      metrics: file.metrics,
      diff: file.renderedLines.join('\n'),
    })),
  );
}
