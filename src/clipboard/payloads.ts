import type {ReviewFile, ReviewBlock, ReviewModel} from '../review/model.js';

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

export function buildPathLinePayload(file: Pick<ReviewFile, 'path'>, block: Pick<ReviewBlock, 'lineStart'>) {
  return `${file.path}:${block.lineStart}`;
}

export function buildAllChangedPathsPayload(model: Pick<ReviewModel, 'files'>) {
  return model.files.map((file) => file.path).join('\n');
}

export function buildCodePayload(block: Pick<ReviewBlock, 'addedCode'>) {
  return block.addedCode;
}

export function buildBlockDiffPayload(block: Pick<ReviewBlock, 'rawDiff'>) {
  return block.rawDiff;
}

export function buildFileDiffPayload(file: Pick<ReviewFile, 'rawDiff'>) {
  return file.rawDiff;
}

export function buildBlockPromptPayload(file: Pick<ReviewFile, 'path'>, block: ReviewBlock) {
  const lines = [
    `File: ${file.path}`,
    `Lines: ${block.lineStart}-${block.lineEnd}`,
  ];

  if (block.functionHeader) {
    lines.push(`Function: ${block.functionHeader}`);
  }

  lines.push('', fencedDiff(block.rawDiff));
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
