import {
  currentBranchNameOperation,
  fileKey,
  fileMetricsOperation,
  isFatalToolError,
  progressTick,
  rawFileDiffOperation,
  renderDiffOperation,
  resolveRefsOperation,
  reviewChangesOperation,
  reviewFingerprintOperation,
  runOperation,
  runOperationAsync,
  runWithPrivateIndexAsync,
  withPrivateIndex,
  type ChangedFileEntry,
  type DiffRange,
  type GitOperation,
  type ReviewChanges,
  type ReviewMetrics,
} from '../git.js';
import {escapeHiddenCharacters} from '../controlChars.js';
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
function* reviewFileOperation(
  {cwd, range, width}: BuildReviewModelOptions,
  entry: ChangedFileEntry,
  metrics: FileMetrics,
  metricsError: string | undefined,
  untrackedFiles: ReadonlySet<string>,
): GitOperation<ReviewFile> {
  let rawDiff = '';
  let renderedLines: string[] = [];
  let error: string | undefined;
  let rawDiffError: string | undefined;
  let loaded = false;

  try {
    // A name that isn't UTF-8 names no file git or the filesystem can find.
    if (entry.nameError !== undefined) throw new Error(entry.nameError);
    const diff = yield* rawFileDiffOperation(cwd, range, entry.path, untrackedFiles, entry.oldPath);
    rawDiff = diff.text;
    loaded = true;
    if (!diff.utf8) rawDiffError = 'not UTF-8 text';
    renderedLines = splitRenderedLines(yield* renderDiffOperation(cwd, rawDiff, width));
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
    ...(entry.nameError === undefined ? {} : {pathError: entry.nameError}),
  };
}

// The build from changes and metrics already read for the range.
function* reviewModelOperation(
  options: BuildReviewModelOptions,
  {entries}: ReviewChanges,
  {metrics: metricsMap, errors: metricsErrors}: ReviewMetrics,
): GitOperation<ReviewModel> {
  const {range} = options;
  // Paths that are diffed as new files. A name that is not UTF-8 is never
  // diffed, and its escaped stand-in may be the name of a real tracked file,
  // so it is left out.
  const untrackedFiles = new Set(
    entries.filter((entry) => entry.status === 'untracked' && entry.nameError === undefined).map((entry) => entry.path),
  );

  const files: ReviewFile[] = [];
  for (const entry of entries) {
    files.push(yield* reviewFileOperation(
      options,
      entry,
      metricsMap.get(fileKey(entry)) ?? emptyMetrics(entry.path),
      metricsErrors.get(fileKey(entry)),
      untrackedFiles,
    ));
    yield* progressTick();
  }

  const branch = range.includeWorktree ? `${range.branch} + worktree` : range.branch;

  return {
    base: range.base,
    branch,
    label: `${range.base}...${branch}`,
    metrics: calculateBranchMetrics(files),
    files,
  };
}

export function buildReviewModel(options: BuildReviewModelOptions): ReviewModel {
  const {cwd, range} = options;

  return withPrivateIndex(cwd, () => runOperation((function* () {
    const changes = yield* reviewChangesOperation(cwd, range);
    const metrics = yield* fileMetricsOperation(cwd, range, changes);
    return yield* reviewModelOperation(options, changes, metrics);
  })()));
}

export type RefreshReviewOptions = {
  cwd: string;
  requestedBranch: string;
  requestedBase: string;
  width: number;
  /** The fingerprint of the review on screen; the build is skipped while it still matches. */
  previousFingerprint: string | null;
  /** Called once per file in every loop over the changed files, and on every chunk git or delta prints. */
  onProgress?: () => void;
  /** Aborting kills the git or delta that is running and rejects with AbortedError. */
  signal?: AbortSignal;
};

export type RefreshReviewResult = {
  range: DiffRange;
  fingerprint: string;
  branchName: string | null;
  /** Set only when the fingerprint differs from `previousFingerprint`. */
  review?: ReviewModel;
};

/**
 * Resolves the refs, takes the review fingerprint and the current branch,
 * and builds the review when the fingerprint changed, all with asynchronous
 * git and delta calls so the event loop stays free. The changes and line
 * counts are read once and shared by the fingerprint and the build; the
 * fingerprint is taken before any diff is read, so a write that lands during
 * the build changes the next fingerprint. Errors are the ones the synchronous
 * functions throw, with git's stderr attached.
 */
export async function refreshReview({
  cwd,
  requestedBranch,
  requestedBase,
  width,
  previousFingerprint,
  onProgress,
  signal,
}: RefreshReviewOptions): Promise<RefreshReviewResult> {
  const control = {onProgress, signal};
  const range = await runOperationAsync(resolveRefsOperation(cwd, requestedBranch, requestedBase), control);

  return runWithPrivateIndexAsync(cwd, function* (): GitOperation<RefreshReviewResult> {
    const changes = yield* reviewChangesOperation(cwd, range);
    const metrics = yield* fileMetricsOperation(cwd, range, changes);
    const fingerprint = yield* reviewFingerprintOperation(cwd, range, changes, metrics);
    const branchName = yield* currentBranchNameOperation(cwd);
    if (fingerprint === previousFingerprint) return {range, fingerprint, branchName};

    const review = yield* reviewModelOperation({cwd, range, width}, changes, metrics);
    return {range, fingerprint, branchName, review};
  }, control);
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
