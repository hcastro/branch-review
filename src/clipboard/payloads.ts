import type {ReviewFile, ReviewBlock, ReviewModel} from '../review/model.js';

function formatNumber(value: number) {
  return value.toLocaleString('en-US');
}

function formatMetrics(model: ReviewModel) {
  return `${model.metrics.filesChanged} files · +${formatNumber(model.metrics.additions)} -${formatNumber(model.metrics.deletions)}`;
}

// The patch goes inside the fence untrimmed, so a trailing blank context line
// survives and the fenced text still applies. The fence is longer than any
// run of backticks in the patch, so no patch line can close it early.
function fencedDiff(rawDiff: string) {
  let longestRun = 0;
  for (const match of rawDiff.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}diff\n${rawDiff}${rawDiff.endsWith('\n') ? '' : '\n'}${fence}`;
}

// A path on a heading or list line, with CR and LF escaped so a file name
// can't end the line and forge another one.
function linePath(filePath: string) {
  return filePath.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

export function buildPathPayload(file: Pick<ReviewFile, 'path'>) {
  return file.path;
}

export function buildAbsolutePathPayload(absolutePath: string) {
  return absolutePath;
}

export function buildPathLinePayload(file: Pick<ReviewFile, 'path'>, block: Pick<ReviewBlock, 'lineStart'>) {
  return `${file.path}:${block.lineStart}`;
}

export function buildAllChangedPathsPayload(model: Pick<ReviewModel, 'files'>) {
  return model.files.map((file) => linePath(file.path)).join('\n');
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

export function buildFileContentsPayload(contents: string) {
  return contents;
}

export function buildBlockPromptPayload(file: Pick<ReviewFile, 'path'>, block: ReviewBlock) {
  const lines = [
    `File: ${linePath(file.path)}`,
    `Lines: ${block.lineStart}-${block.lineEnd}`,
  ];

  if (block.functionHeader) {
    lines.push(`Function: ${block.functionHeader}`);
  }

  lines.push('', fencedDiff(block.rawDiff));
  return lines.join('\n');
}

export function buildFilePromptPayload(file: Pick<ReviewFile, 'path' | 'rawDiff'>) {
  return [`File: ${linePath(file.path)}`, '', fencedDiff(file.rawDiff)].join('\n');
}

export function buildBranchPromptPayload(model: ReviewModel) {
  const lines = [
    `# Branch review · ${model.label}`,
    formatMetrics(model),
    '',
  ];

  for (const file of model.files) {
    const body = file.rawDiffError === undefined ? fencedDiff(file.rawDiff) : `Diff unavailable: ${file.rawDiffError}`;
    lines.push(`## ${linePath(file.path)}`, '', body, '');
  }

  return lines.join('\n').trimEnd();
}
