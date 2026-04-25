import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';

const tempDirs: string[] = [];

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createRepo() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-model-'));
  tempDirs.push(cwd);

  runGit(cwd, 'init', '-b', 'development');
  runGit(cwd, 'config', 'user.name', 'Test User');
  runGit(cwd, 'config', 'user.email', 'test@example.com');

  fs.writeFileSync(path.join(cwd, 'example.ts'), 'export const value = 1;\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-m', 'initial');

  runGit(cwd, 'checkout', '-b', 'feature/example');
  fs.writeFileSync(path.join(cwd, 'example.ts'), 'export const value = 2;\nexport const next = 3;\n');
  runGit(cwd, 'add', '.');
  runGit(cwd, 'commit', '-m', 'feature');
  fs.writeFileSync(path.join(cwd, 'untracked.ts'), 'export const local = true;\n');

  return cwd;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('buildReviewModel', () => {
  it('keeps raw payload data separate from rendered delta lines', () => {
    const cwd = createRepo();
    const range = resolveRefs(cwd, 'HEAD', 'development');
    const model = buildReviewModel({cwd, range, width: 100});

    expect(model).toMatchObject({
      base: 'development',
      branch: 'HEAD + worktree',
      label: 'development...HEAD + worktree',
      metrics: {filesChanged: 2, additions: 3, deletions: 1, changedLines: 4},
    });

    const example = model.files.find((file) => file.path === 'example.ts');
    expect(example).toMatchObject({
      status: 'modified',
      metrics: {additions: 2, deletions: 1, changedLines: 3},
    });
    expect(example?.rawDiff).toContain('diff --git a/example.ts b/example.ts');
    expect(example?.rawDiff).toContain('@@');
    expect(example?.renderedLines.join('\n')).toContain('example.ts');
    expect(example?.blocks[0]?.addedCode).toBe('export const value = 2;\nexport const next = 3;');

    const untracked = model.files.find((file) => file.path === 'untracked.ts');
    expect(untracked).toMatchObject({
      status: 'untracked',
      metrics: {additions: 1, deletions: 0, changedLines: 1},
    });
    expect(untracked?.rawDiff).toContain('--- /dev/null');
    expect(untracked?.blocks[0]?.addedCode).toBe('export const local = true;');
  });
});
