import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {
  buildBlockDiffPayload,
  buildBlockPromptPayload,
  buildFileDiffPayload,
} from '../src/clipboard/payloads.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

function applyCheck(cwd: string, patch: string) {
  return execFileSync('git', ['apply', '--check', '-'], {
    cwd,
    input: patch,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function fencedBody(payload: string) {
  const open = payload.match(/^(`{3,})diff\n/m)!;
  const start = open.index! + open[0].length;
  const end = payload.lastIndexOf(`\n${open[1]}`) + 1;
  return payload.slice(start, end);
}

function apply(cwd: string, patch: string) {
  return execFileSync('git', ['apply', '-'], {
    cwd,
    input: patch,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('copied diffs apply with git apply', () => {
  it('keeps a trailing blank context line and the final newline', () => {
    // The hunk for line 1 ends on the blank context line 4.
    const base = 'x\n1\n2\n\n3\n4\n5\n6\n7\n8\n9\n10\nend\n';
    const cwd = initRepo({'x.js': base});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    writeFiles(cwd, {'x.js': base.replace('x\n', 'y\n').replace('end\n', 'end!\n')});
    commitAll(cwd, 'feature');

    const range = resolveRefs(cwd, 'feature', 'main');
    const file = buildReviewModel({cwd, range, width: 100}).files[0]!;
    expect(file.blocks).toHaveLength(2);
    const [first, second] = file.blocks;

    git(cwd, 'checkout', '-q', 'main');

    const filePatch = buildFileDiffPayload(file);
    expect(filePatch.endsWith('\n')).toBe(true);
    expect(() => applyCheck(cwd, filePatch)).not.toThrow();

    const header = file.rawDiff.slice(0, file.rawDiff.indexOf('@@'));
    for (const block of [first!, second!]) {
      const blockPatch = buildBlockDiffPayload(block);
      expect(blockPatch.startsWith('@@')).toBe(true);
      expect(blockPatch.endsWith('\n')).toBe(true);
      expect(() => applyCheck(cwd, header + blockPatch)).not.toThrow();
    }

    expect(first!.rawDiff.endsWith('\n \n')).toBe(true);
    expect(fencedBody(buildBlockPromptPayload(file, first!))).toBe(first!.rawDiff);
  });

  it('applies a whole-file diff whose last hunk ends on a blank context line', () => {
    const base = 'a\nb\nc\n\n';
    const cwd = initRepo({'t.txt': base});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    writeFiles(cwd, {'t.txt': base.replace('a\n', 'A\n')});
    commitAll(cwd, 'feature');

    const range = resolveRefs(cwd, 'feature', 'main');
    const file = buildReviewModel({cwd, range, width: 100}).files[0]!;

    git(cwd, 'checkout', '-q', 'main');
    expect(file.blocks).toHaveLength(1);
    const header = file.rawDiff.slice(0, file.rawDiff.indexOf('@@'));
    for (const patch of [buildFileDiffPayload(file), header + fencedBody(buildBlockPromptPayload(file, file.blocks[0]!))]) {
      expect(() => applyCheck(cwd, patch)).not.toThrow();
    }
    expect(file.rawDiff.endsWith(' c\n \n')).toBe(true);
  });

  it('recreates an untracked file byte for byte, trailing blank and space-only lines included', () => {
    const contents = 'first\n\n  \n';
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'new.txt': contents});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const file = buildReviewModel({cwd, range, width: 100}).files.find((entry) => entry.path === 'new.txt')!;

    expect(file.blocks).toHaveLength(1);
    const header = file.rawDiff.slice(0, file.rawDiff.indexOf('@@'));
    for (const patch of [buildFileDiffPayload(file), header + fencedBody(buildBlockPromptPayload(file, file.blocks[0]!))]) {
      const scratch = makeTempDir('branch-review-apply-');
      git(scratch, 'init', '-q');
      expect(() => applyCheck(scratch, patch)).not.toThrow();
      apply(scratch, patch);
      expect(fs.readFileSync(path.join(scratch, 'new.txt'), 'utf8')).toBe(contents);
    }
  });
});
