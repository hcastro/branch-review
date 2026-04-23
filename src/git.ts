import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import type {BranchMetrics, FileMetrics} from './sections.js';

function runGit(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

function tryRunGit(cwd: string, args: string[]) {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
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

export type DiffRange = {
  base: string;
  branch: string;
  diffArg: string;
  includeWorktree: boolean;
};

function resolveRef(cwd: string, requested: string) {
  if (hasRef(cwd, requested)) return requested;
  if (hasRef(cwd, `origin/${requested}`)) return `origin/${requested}`;
  return null;
}

export function inferBaseRef(cwd: string) {
  const originHead = tryRunGit(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (originHead && hasRef(cwd, originHead)) {
    return originHead;
  }

  for (const candidate of ['development', 'main', 'master', 'trunk']) {
    const resolved = resolveRef(cwd, candidate);
    if (resolved) {
      return resolved;
    }
  }

  const currentBranch = tryRunGit(cwd, ['branch', '--show-current']);
  if (currentBranch) {
    const resolved = resolveRef(cwd, currentBranch);
    if (resolved) {
      return resolved;
    }
  }

  throw new Error('Could not infer a base ref. Pass one explicitly, for example: branch-review HEAD main');
}

export function resolveRefs(cwd: string, requestedBranch: string, requestedBase: string): DiffRange {
  const base = resolveRef(cwd, requestedBase);
  if (!base) {
    throw new Error(`Base ref not found: ${requestedBase}`);
  }

  if (requestedBranch === 'HEAD') {
    const mergeBase = runGit(cwd, ['merge-base', base, 'HEAD']);
    return {
      base,
      branch: 'HEAD',
      diffArg: mergeBase,
      includeWorktree: true,
    };
  }

  const branch = resolveRef(cwd, requestedBranch);
  if (!branch) {
    throw new Error(`Branch ref not found: ${requestedBranch}`);
  }

  return {
    base,
    branch,
    diffArg: `${base}...${branch}`,
    includeWorktree: false,
  };
}

export function getUntrackedFiles(cwd: string) {
  const output = runGit(cwd, ['ls-files', '--others', '--exclude-standard']);
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function getChangedFiles(cwd: string, range: DiffRange) {
  const tracked = runGit(cwd, ['diff', '--name-only', range.diffArg])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const all = new Set(tracked);
  if (range.includeWorktree) {
    for (const file of getUntrackedFiles(cwd)) {
      all.add(file);
    }
  }

  return [...all].sort((a, b) => a.localeCompare(b));
}

export function getRawFileDiff(cwd: string, range: DiffRange, filePath: string) {
  return runGit(cwd, ['diff', '--no-color', range.diffArg, '--', filePath]);
}

export function getFileStat(cwd: string, range: DiffRange, filePath: string) {
  return runGit(cwd, ['diff', '--stat', '--color=never', range.diffArg, '--', filePath]);
}

function countUntrackedLines(cwd: string, filePath: string) {
  try {
    const contents = fs.readFileSync(path.join(cwd, filePath), 'utf8');
    if (contents.length === 0) return 0;
    const parts = contents.split('\n');
    return parts.at(-1) === '' ? parts.length - 1 : parts.length;
  } catch {
    return 0;
  }
}

export function getFileMetricsMap(cwd: string, range: DiffRange) {
  const output = runGit(cwd, ['diff', '--numstat', range.diffArg]);
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

  if (range.includeWorktree) {
    for (const filePath of getUntrackedFiles(cwd)) {
      const additions = countUntrackedLines(cwd, filePath);
      metrics.set(filePath, {
        path: filePath,
        additions,
        deletions: 0,
        changedLines: additions,
      });
    }
  }

  return metrics;
}

export function getBranchMetrics(cwd: string, range: DiffRange): BranchMetrics {
  const fileMetrics = [...getFileMetricsMap(cwd, range).values()];

  return {
    filesChanged: fileMetrics.length,
    additions: fileMetrics.reduce((sum, item) => sum + item.additions, 0),
    deletions: fileMetrics.reduce((sum, item) => sum + item.deletions, 0),
    changedLines: fileMetrics.reduce((sum, item) => sum + item.changedLines, 0),
  };
}

const DELTA_FLAGS = "delta --no-gitconfig --dark --paging=never --line-numbers --navigate --line-fill-method=spaces --syntax-theme='Monokai Extended' --file-style='bold yellow' --file-decoration-style='yellow box' --hunk-header-style='syntax file line-number' --plus-style='syntax #003800' --minus-style='syntax #3f0001'";

function pipeThroughDelta(cwd: string, gitCommand: string, width: number) {
  const widthFlag = `--width='${Math.max(width, 80)}'`;
  try {
    const diff = execFileSync('bash', ['-lc', `${gitCommand} | ${DELTA_FLAGS} ${widthFlag}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return diff.trimEnd();
  } catch (err) {
    const stdout = (err as {stdout?: Buffer | string}).stdout;
    if (stdout !== undefined) {
      const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      return text.trimEnd();
    }
    throw err;
  }
}

export function getColoredFileDiff(
  cwd: string,
  range: DiffRange,
  filePath: string,
  width: number,
  untrackedFiles?: ReadonlySet<string>,
) {
  const isUntracked = range.includeWorktree && (untrackedFiles?.has(filePath) ?? false);

  if (isUntracked) {
    return pipeThroughDelta(
      cwd,
      `git diff --no-index --color=always -- /dev/null ${quoteShell(filePath)}`,
      width,
    );
  }

  return pipeThroughDelta(
    cwd,
    `git diff --color=always ${quoteShell(range.diffArg)} -- ${quoteShell(filePath)}`,
    width,
  );
}
