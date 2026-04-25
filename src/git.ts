import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import type {BranchMetrics, FileMetrics} from './sections.js';

function runGit(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trimEnd();
}

function runGitRaw(cwd: string, args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function tryRunGit(cwd: string, args: string[]) {
  try {
    return runGit(cwd, args);
  } catch {
    return null;
  }
}

function runGitDiff(cwd: string, args: string[]) {
  try {
    return runGit(cwd, args);
  } catch (err) {
    const exitCode = (err as {status?: number}).status;
    const stdout = (err as {stdout?: Buffer | string}).stdout;
    if (exitCode === 1 && stdout !== undefined) {
      const text = typeof stdout === 'string' ? stdout : stdout.toString('utf8');
      return text.trimEnd();
    }

    throw err;
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

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked';

export type ChangedFileEntry = {
  path: string;
  status: FileStatus;
  oldPath?: string;
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
  return getChangedFileEntries(cwd, range).map((entry) => entry.path);
}

function parseNameStatusLine(line: string): ChangedFileEntry | null {
  const parts = line.split('\t');
  const statusCode = parts[0];
  if (!statusCode) return null;

  if (statusCode.startsWith('R')) {
    const oldPath = parts[1];
    const nextPath = parts[2];
    if (!oldPath || !nextPath) return null;
    return {path: nextPath, oldPath, status: 'renamed'};
  }

  const filePath = parts.slice(1).join('\t');
  if (!filePath) return null;

  if (statusCode === 'A') return {path: filePath, status: 'added'};
  if (statusCode === 'D') return {path: filePath, status: 'deleted'};
  return {path: filePath, status: 'modified'};
}

export function getChangedFileEntries(cwd: string, range: DiffRange): ChangedFileEntry[] {
  const entries = runGit(cwd, ['diff', '--name-status', range.diffArg])
    .split('\n')
    .map((line) => parseNameStatusLine(line.trim()))
    .filter((entry): entry is ChangedFileEntry => Boolean(entry));

  if (range.includeWorktree) {
    const seen = new Set(entries.map((entry) => entry.path));
    for (const filePath of getUntrackedFiles(cwd)) {
      if (!seen.has(filePath)) {
        entries.push({path: filePath, status: 'untracked'});
        seen.add(filePath);
      }
    }
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function getRawFileDiff(
  cwd: string,
  range: DiffRange,
  filePath: string,
  untrackedFiles?: ReadonlySet<string>,
) {
  const isUntracked = range.includeWorktree && (untrackedFiles?.has(filePath) ?? false);

  if (isUntracked) {
    return runGitDiff(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', filePath]);
  }

  return runGit(cwd, ['diff', '--no-color', range.diffArg, '--', filePath]);
}

export function getReviewFileContents(
  cwd: string,
  range: DiffRange,
  file: Pick<ChangedFileEntry, 'path' | 'status'>,
) {
  if (file.status === 'deleted') {
    return null;
  }

  if (range.includeWorktree || file.status === 'untracked') {
    try {
      return fs.readFileSync(path.join(cwd, file.path), 'utf8');
    } catch {
      return null;
    }
  }

  try {
    return runGitRaw(cwd, ['show', `${range.branch}:${file.path}`]);
  } catch {
    return null;
  }
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

function statFingerprint(cwd: string, filePath: string) {
  try {
    const stat = fs.statSync(path.join(cwd, filePath));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

export function getReviewFingerprint(cwd: string, range: DiffRange) {
  const entries = getChangedFileEntries(cwd, range);
  const metrics = getFileMetricsMap(cwd, range);
  const head = tryRunGit(cwd, ['rev-parse', 'HEAD']) ?? '';
  const raw = runGitDiff(cwd, ['diff', '--raw', '-z', range.diffArg]);
  const hash = createHash('sha1');

  hash.update(range.base);
  hash.update('\0');
  hash.update(range.branch);
  hash.update('\0');
  hash.update(head);
  hash.update('\0');
  hash.update(raw);

  for (const entry of entries) {
    const metric = metrics.get(entry.path);
    hash.update('\0');
    hash.update(entry.status);
    hash.update('\0');
    hash.update(entry.oldPath ?? '');
    hash.update('\0');
    hash.update(entry.path);
    hash.update('\0');
    hash.update(metric ? `${metric.additions}:${metric.deletions}:${metric.changedLines}` : '0:0:0');
    hash.update('\0');
    hash.update(statFingerprint(cwd, entry.path));
  }

  return hash.digest('hex');
}

const DELTA_FLAGS = "delta --no-gitconfig --dark --paging=never --line-numbers --navigate --line-fill-method=spaces --syntax-theme='Monokai Extended' --file-style='omit' --hunk-header-style='syntax file line-number' --hunk-header-decoration-style='omit' --plus-style='syntax #003800' --minus-style='syntax #3f0001'";

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
