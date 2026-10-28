import {
  getChangedFileEntries,
  isFatalToolError,
  readFileMetrics,
  readRawFileDiff,
  renderDiffForDisplay,
  withPrivateIndex,
  type ChangedFileEntry,
  type DiffRange,
} from '../git.js';
import {escapeHiddenCharacters} from '../controlChars.js';
import {buildDiffSections, type BranchMetrics, type DiffSection, type FileMetrics} from '../sections.js';
import {parseUnifiedDiffBlocks} from '../blocks/parse.js';
import type {ReviewFile, ReviewModel} from './model.js';

type BuildReviewModelOptions = {
  cwd: string;
  range: DiffRange;
  width: number;
  /** Called after each file is built, error rows included, before the next starts. */
  onFileBuilt?: () => void;
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

// delta prints nothing for a file whose diff has no hunks, which would leave
// the file without a line to show or make active. This builds one line from
// the patch header instead: `renamed from a.txt`, `new empty file`,
// `mode 100644 → 100755`, `binary file changed`.
function describeNoTextChange(rawDiff: string) {
  let renamedFrom: string | undefined;
  let oldMode: string | undefined;
  let newMode: string | undefined;
  let kind: string | undefined;

  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('rename from ')) renamedFrom = line.slice('rename from '.length);
    else if (line.startsWith('old mode ')) oldMode = line.slice('old mode '.length);
    else if (line.startsWith('new mode ')) newMode = line.slice('new mode '.length);
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') kind = 'binary file changed';
    else if (line.startsWith('new file mode ')) kind ??= 'new empty file';
    else if (line.startsWith('deleted file mode ')) kind ??= 'deleted empty file';
  }

  const parts = [
    renamedFrom === undefined ? undefined : `renamed from ${renamedFrom}`,
    kind,
    oldMode && newMode ? `mode ${oldMode} → ${newMode}` : undefined,
  ].filter((part): part is string => part !== undefined);

  return escapeHiddenCharacters(parts.join(', ') || 'no text changes');
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
// file, and an interrupt stops the build, so those still throw.
function buildReviewFile(
  {cwd, range, width}: BuildReviewModelOptions,
  entry: ChangedFileEntry,
  metrics: FileMetrics,
  metricsError: string | undefined,
  untrackedFiles: ReadonlySet<string>,
): ReviewFile {
  let rawDiff = '';
  let renderedLines: string[] = [];
  let error: string | undefined;
  let rawDiffError: string | undefined;
  let loaded = false;

  try {
    const diff = readRawFileDiff(cwd, range, entry.path, untrackedFiles, entry.oldPath);
    rawDiff = diff.text;
    loaded = true;
    if (!diff.utf8) rawDiffError = 'not UTF-8 text';
    renderedLines = splitRenderedLines(renderDiffForDisplay(cwd, rawDiff, width));
    if (renderedLines.length === 0) renderedLines = [describeNoTextChange(rawDiff)];
  } catch (caught) {
    if (isFatalToolError(caught)) throw caught;
    error = errorMessage(caught);
    if (!loaded) rawDiffError = error;
    renderedLines = [];
  }

  if (error === undefined && metricsError !== undefined) {
    error = metricsError;
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
    ...(rawDiffError === undefined ? {} : {rawDiffError}),
  };
}

export function buildReviewModel(options: BuildReviewModelOptions): ReviewModel {
  const {cwd, range} = options;

  return withPrivateIndex(cwd, () => {
    const entries = getChangedFileEntries(cwd, range);
    const {metrics: metricsMap, errors: metricsErrors} = readFileMetrics(cwd, range);
    const untrackedFiles = new Set(
      entries.filter((entry) => entry.status === 'untracked').map((entry) => entry.path),
    );

    const files = entries.map((entry) => {
      const file = buildReviewFile(
        options,
        entry,
        metricsMap.get(entry.path) ?? emptyMetrics(entry.path),
        metricsErrors.get(entry.path),
        untrackedFiles,
      );
      options.onFileBuilt?.();
      return file;
    });

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
