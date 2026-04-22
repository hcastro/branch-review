import {execFileSync} from 'node:child_process';
import type {BranchMetrics, FileMetrics} from './sections.js';

function runGit(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

function hasRef(cwd: string, ref: string) {
  try {
    runGit(cwd, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function quoteShell(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function parseNumstatValue(value: string) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

export function resolveRefs(cwd: string, requestedBranch: string, requestedBase: string) {
  const base = hasRef(cwd, requestedBase)
    ? requestedBase
    : hasRef(cwd, `origin/${requestedBase}`)
      ? `origin/${requestedBase}`
      : null;

  if (!base) {
    throw new Error(`Base ref not found: ${requestedBase}`);
  }

  const branch = hasRef(cwd, requestedBranch)
    ? requestedBranch
    : hasRef(cwd, `origin/${requestedBranch}`)
      ? `origin/${requestedBranch}`
      : null;

  if (!branch) {
    throw new Error(`Branch ref not found: ${requestedBranch}`);
  }

  return {base, branch};
}

export function getChangedFiles(cwd: string, base: string, branch: string) {
  const output = runGit(cwd, ['diff', '--name-only', `${base}...${branch}`]);
  return output.split('\n').map((line) => line.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

export function getRawFileDiff(cwd: string, base: string, branch: string, filePath: string) {
  return runGit(cwd, ['diff', '--no-color', `${base}...${branch}`, '--', filePath]);
}

export function getFileStat(cwd: string, base: string, branch: string, filePath: string) {
  return runGit(cwd, ['diff', '--stat', '--color=never', `${base}...${branch}`, '--', filePath]);
}

export function getFileMetricsMap(cwd: string, base: string, branch: string) {
  const output = runGit(cwd, ['diff', '--numstat', `${base}...${branch}`]);
  const metrics = new Map<string, FileMetrics>();

  for (const line of output.split('\n').map((value) => value.trim()).filter(Boolean)) {
    const [addsRaw, deletesRaw, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t');
    const additions = parseNumstatValue(addsRaw);
    const deletions = parseNumstatValue(deletesRaw);

    metrics.set(path, {
      path,
      additions,
      deletions,
      changedLines: additions + deletions,
    });
  }

  return metrics;
}

export function getBranchMetrics(cwd: string, base: string, branch: string): BranchMetrics {
  const fileMetrics = [...getFileMetricsMap(cwd, base, branch).values()];

  return {
    filesChanged: fileMetrics.length,
    additions: fileMetrics.reduce((sum, item) => sum + item.additions, 0),
    deletions: fileMetrics.reduce((sum, item) => sum + item.deletions, 0),
    changedLines: fileMetrics.reduce((sum, item) => sum + item.changedLines, 0),
  };
}

export function getColoredFileDiff(cwd: string, base: string, branch: string, filePath: string, width: number) {
  const diff = execFileSync('bash', ['-lc', `git diff --color=always ${quoteShell(`${base}...${branch}`)} -- ${quoteShell(filePath)} | delta --no-gitconfig --dark --paging=never --width='${Math.max(width, 80)}' --line-numbers --navigate --syntax-theme='Monokai Extended' --file-style='bold yellow' --file-decoration-style='yellow box' --hunk-header-style='syntax file line-number' --plus-style='syntax #003800' --minus-style='syntax #3f0001'`], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return diff.trimEnd();
}
