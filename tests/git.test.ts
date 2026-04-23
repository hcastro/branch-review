import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {
  inferBaseRef,
  getBranchMetrics,
  getChangedFiles,
  getFileMetricsMap,
  getRawFileDiff,
  resolveRefs,
} from '../src/git.js';

const tempDirs: string[] = [];

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createRepo(baseBranch = 'development') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-'));
  tempDirs.push(cwd);

  runGit(cwd, 'init', '-b', baseBranch);
  runGit(cwd, 'config', 'user.name', 'Test User');
  runGit(cwd, 'config', 'user.email', 'test@example.com');

  fs.mkdirSync(path.join(cwd, 'src'), {recursive: true});
  fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export const value = 1;\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-m', 'initial');

  runGit(cwd, 'checkout', '-b', 'feature/example');
  fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export const value = 2;\nexport const next = 3;\n');
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Example\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-m', 'feature change');

  return cwd;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('git helpers', () => {
  it('resolves refs and returns changed files relative to the merge base', () => {
    const cwd = createRepo();

    const range = resolveRefs(cwd, 'feature/example', 'development');
    const files = getChangedFiles(cwd, range);

    expect(range).toMatchObject({
      base: 'development',
      branch: 'feature/example',
      diffArg: 'development...feature/example',
      includeWorktree: false,
    });
    expect(files).toEqual(['README.md', 'src/app.ts']);
  });

  it('returns a file-specific diff instead of the whole branch diff', () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'feature/example', 'development');
    const diff = getRawFileDiff(cwd, range, 'README.md');

    expect(diff).toContain('diff --git a/README.md b/README.md');
    expect(diff).toContain('+# Example');
    expect(diff).not.toContain('src/app.ts');
  });

  it('extracts per-file and branch metrics from numstat output', () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'feature/example', 'development');
    const metricsMap = getFileMetricsMap(cwd, range);
    const branchMetrics = getBranchMetrics(cwd, range);

    expect(metricsMap.get('README.md')).toMatchObject({additions: 1, deletions: 0, changedLines: 1});
    expect(metricsMap.get('src/app.ts')).toMatchObject({additions: 2, deletions: 1, changedLines: 3});
    expect(branchMetrics).toEqual({filesChanged: 2, additions: 3, deletions: 1, changedLines: 4});
  });

  it('includes unstaged, staged, and untracked changes in worktree mode', () => {
    const cwd = createRepo();

    fs.writeFileSync(path.join(cwd, 'src', 'app.ts'), 'export const value = 2;\nexport const next = 4;\nexport const extra = 5;\n');
    fs.writeFileSync(path.join(cwd, 'staged.ts'), 'export const staged = true;\n');
    runGit(cwd, 'add', 'staged.ts');
    fs.writeFileSync(path.join(cwd, 'untracked.ts'), 'export const a = 1;\nexport const b = 2;\n');

    const range = resolveRefs(cwd, 'HEAD', 'development');
    expect(range).toMatchObject({base: 'development', branch: 'HEAD', includeWorktree: true});

    const files = getChangedFiles(cwd, range);
    expect(files).toEqual(['README.md', 'src/app.ts', 'staged.ts', 'untracked.ts']);

    const metricsMap = getFileMetricsMap(cwd, range);
    expect(metricsMap.get('untracked.ts')).toEqual({
      path: 'untracked.ts',
      additions: 2,
      deletions: 0,
      changedLines: 2,
    });
    expect(metricsMap.get('staged.ts')).toMatchObject({additions: 1, deletions: 0});
    expect(metricsMap.get('src/app.ts')).toMatchObject({additions: 3, deletions: 1});
  });

  it('infers main when development is not present', () => {
    const cwd = createRepo('main');

    expect(inferBaseRef(cwd)).toBe('main');

    const range = resolveRefs(cwd, 'feature/example', inferBaseRef(cwd));
    expect(range).toMatchObject({
      base: 'main',
      branch: 'feature/example',
      diffArg: 'main...feature/example',
      includeWorktree: false,
    });
  });

  it('prefers origin HEAD when a remote default branch is configured', () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-remote-'));
    tempDirs.push(remote);
    runGit(remote, 'init', '--bare', '--initial-branch', 'main');

    const cwd = createRepo('trunk');
    runGit(cwd, 'remote', 'add', 'origin', remote);
    runGit(cwd, 'push', '-u', 'origin', 'trunk');
    runGit(cwd, 'push', 'origin', 'trunk:main');
    runGit(cwd, 'fetch', 'origin');
    runGit(cwd, 'remote', 'set-head', 'origin', 'main');

    expect(inferBaseRef(cwd)).toBe('origin/main');
  });
});
