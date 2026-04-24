import type {ReviewFile, ReviewHunk, ReviewModel} from '../review/model.js';

function formatNumber(value: number) {
  return value.toLocaleString('en-US');
}

function formatMetrics(model: ReviewModel) {
  return `${model.metrics.filesChanged} files · +${formatNumber(model.metrics.additions)} -${formatNumber(model.metrics.deletions)}`;
}

function fencedDiff(rawDiff: string) {
  return ['```diff', rawDiff.trimEnd(), '```'].join('\n');
}

export function buildPathPayload(file: Pick<ReviewFile, 'path'>) {
  return file.path;
}

export function buildPathLinePayload(file: Pick<ReviewFile, 'path'>, hunk: Pick<ReviewHunk, 'lineStart'>) {
  return `${file.path}:${hunk.lineStart}`;
}

export function buildAllChangedPathsPayload(model: Pick<ReviewModel, 'files'>) {
  return model.files.map((file) => file.path).join('\n');
}

export function buildCodePayload(hunk: Pick<ReviewHunk, 'addedCode'>) {
  return hunk.addedCode;
}

export function buildHunkDiffPayload(hunk: Pick<ReviewHunk, 'rawDiff'>) {
  return hunk.rawDiff;
}

export function buildFileDiffPayload(file: Pick<ReviewFile, 'rawDiff'>) {
  return file.rawDiff;
}

export function buildHunkPromptPayload(file: Pick<ReviewFile, 'path'>, hunk: ReviewHunk) {
  const lines = [
    `File: ${file.path}`,
    `Lines: ${hunk.lineStart}-${hunk.lineEnd}`,
  ];

  if (hunk.functionHeader) {
    lines.push(`Function: ${hunk.functionHeader}`);
  }

  lines.push('', fencedDiff(hunk.rawDiff));
  return lines.join('\n');
}

export function buildFilePromptPayload(file: Pick<ReviewFile, 'path' | 'rawDiff'>) {
  return [`File: ${file.path}`, '', fencedDiff(file.rawDiff)].join('\n');
}

export function buildBranchPromptPayload(model: ReviewModel) {
  const lines = [
    `# Branch review · ${model.label}`,
    formatMetrics(model),
    '',
  ];

  for (const file of model.files) {
    lines.push(`## ${file.path}`, '', fencedDiff(file.rawDiff), '');
  }

  return lines.join('\n').trimEnd();
}
