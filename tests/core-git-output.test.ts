import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  getChangedFileEntries,
  getFileMetricsMap,
  getRawFileDiff,
  getReviewFileContents,
  getReviewFingerprint,
  resolveRefs,
} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

const gitModule = fileURLToPath(new URL('../src/git.ts', import.meta.url));

describe('reading git output byte for byte', () => {
  it('keeps non-ASCII, space-padded and tab names exact', () => {
    const cwd = initRepo({'café.txt': 'one\n', ' lead.txt': 'one\n'});
    writeFiles(cwd, {'café.txt': 'one\ntwo\n', ' lead.txt': 'one\ntwo\n', 'tab\tname.txt': 'x\n'});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const entries = getChangedFileEntries(cwd, range);
    expect(entries.map((entry) => entry.path)).toEqual([' lead.txt', 'café.txt', 'tab\tname.txt']);

    const metrics = getFileMetricsMap(cwd, range);
    expect(metrics.get('café.txt')).toMatchObject({additions: 1, deletions: 0});
    expect(metrics.get(' lead.txt')).toMatchObject({additions: 1, deletions: 0});
    expect(metrics.get('tab\tname.txt')).toMatchObject({additions: 1});

    const model = buildReviewModel({cwd, range, width: 100});
    const cafe = model.files.find((file) => file.path === 'café.txt');
    expect(cafe?.blocks[0]?.addedCode).toBe('two');
    expect(getReviewFileContents(cwd, range, {path: 'café.txt', status: 'modified'})).toBe('one\ntwo\n');
  });

  it('never folds a copy record into a path when diff.renames=copies', () => {
    const cwd = initRepo({'orig.txt': 'line 1\nline 2\nline 3\nline 4\nline 5\n'});
    git(cwd, 'config', 'diff.renames', 'copies');
    fs.copyFileSync(path.join(cwd, 'orig.txt'), path.join(cwd, 'copy.txt'));
    writeFiles(cwd, {'orig.txt': 'line 1\nline 2\nline 3\nline 4\nline 5 changed\n'});
    git(cwd, 'add', '-A');

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const entries = getChangedFileEntries(cwd, range);
    expect(entries.every((entry) => !entry.path.includes('\t'))).toBe(true);
    expect(new Map(entries.map((entry) => [entry.path, entry.status]))).toEqual(new Map([
      ['copy.txt', 'added'],
      ['orig.txt', 'modified'],
    ]));
  });
});

describe('renamed files', () => {
  it('diffs a renamed file against its old path and keeps its metrics', () => {
    const cwd = initRepo({'src/old.txt': 'a\nb\nc\nd\ne\n'});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    git(cwd, 'mv', 'src/old.txt', 'src/renamed.txt');
    writeFiles(cwd, {'src/renamed.txt': 'a\nb\nc\nd\ne\nf\n'});
    commitAll(cwd, 'rename');

    for (const range of [resolveRefs(cwd, 'feature', 'main'), resolveRefs(cwd, 'HEAD', 'main')]) {
      const model = buildReviewModel({cwd, range, width: 100});
      const renamed = model.files.find((file) => file.path === 'src/renamed.txt');
      expect(renamed).toMatchObject({status: 'renamed', oldPath: 'src/old.txt'});
      expect(renamed?.metrics).toMatchObject({additions: 1, deletions: 0});
      expect(renamed?.rawDiff).toContain('rename from src/old.txt\n');
      expect(renamed?.rawDiff).not.toContain('new file mode');
      expect(renamed?.blocks[0]?.addedCode).toBe('f');
    }
  });
});

describe('large output and per-file failures', () => {
  it('renders a diff larger than 1 MiB in full', () => {
    const cwd = initRepo({'keep.txt': 'keep\n'});
    const lines = Array.from({length: 12_000}, (_, index) => `line ${index} ${'x'.repeat(100)}`);
    writeFiles(cwd, {'big.txt': `${lines.join('\n')}\n`});
    commitAll(cwd, 'big');
    git(cwd, 'checkout', '-q', '-b', 'feature');
    fs.rmSync(path.join(cwd, 'big.txt'));
    writeFiles(cwd, {'big.txt': `${lines.map((line) => `${line}!`).join('\n')}\n`});
    commitAll(cwd, 'edit big');

    const range = resolveRefs(cwd, 'feature', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    const big = model.files.find((file) => file.path === 'big.txt');

    expect(big?.error).toBeUndefined();
    expect(Buffer.byteLength(big?.rawDiff ?? '')).toBeGreaterThan(1024 * 1024 * 2);
    expect(big?.rawDiff).toContain('+line 11999 ');
    expect(big?.renderedLines.length).toBeGreaterThanOrEqual(24_000);
    expect(getReviewFileContents(cwd, range, {path: 'big.txt', status: 'modified'})).toContain('line 11999');
  }, 60_000);

  it('turns one unreadable file into an error row and keeps the rest', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a2\n', 'locked.txt': 'secret\n', 'fine.txt': 'fine\n'});
    fs.chmodSync(path.join(cwd, 'locked.txt'), 0o000);

    try {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const model = buildReviewModel({cwd, range, width: 100});
      const byPath = new Map(model.files.map((file) => [file.path, file]));

      expect(byPath.get('locked.txt')?.error).toMatch(/locked\.txt/);
      expect(byPath.get('locked.txt')?.renderedLines).toEqual([]);
      expect(byPath.get('fine.txt')?.error).toBeUndefined();
      expect(byPath.get('fine.txt')?.blocks[0]?.addedCode).toBe('fine');
      expect(byPath.get('a.txt')?.blocks[0]?.addedCode).toBe('a2');
    } finally {
      fs.chmodSync(path.join(cwd, 'locked.txt'), 0o644);
    }
  });

  it('treats a file deleted between listing and diffing as an error, not an empty diff', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'gone.txt': 'soon gone\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const untracked = new Set(['gone.txt']);
    expect(getRawFileDiff(cwd, range, 'gone.txt', untracked)).toContain('+soon gone\n');

    fs.rmSync(path.join(cwd, 'gone.txt'));
    expect(() => getRawFileDiff(cwd, range, 'gone.txt', untracked)).toThrow(/gone\.txt/);
  });

  it('skips an untracked nested repository instead of showing an empty diff', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const nested = path.join(cwd, 'nested');
    fs.mkdirSync(nested);
    git(nested, 'init', '-q');
    writeFiles(cwd, {'nested/inner.txt': 'inner\n', 'loose.txt': 'loose\n'});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});

    expect(model.files.map((file) => file.path)).toEqual(['loose.txt']);
    expect(model.files[0]?.blocks[0]?.addedCode).toBe('loose');
  });
});

describe('file reads never follow symlinks or block', () => {
  it('shows and copies a symlink as its link text', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const outside = makeTempDir('branch-review-outside-');
    const secret = path.join(outside, 'secret.txt');
    fs.writeFileSync(secret, Array.from({length: 15}, (_, index) => `secret ${index}`).join('\n'));
    fs.symlinkSync(secret, path.join(cwd, 'hosts-link'));

    const range = resolveRefs(cwd, 'HEAD', 'main');
    expect(getFileMetricsMap(cwd, range).get('hosts-link')).toMatchObject({additions: 1});
    expect(getReviewFileContents(cwd, range, {path: 'hosts-link', status: 'untracked'})).toBe(secret);
  });

  it('does not block on a symlink to a FIFO', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const outside = makeTempDir('branch-review-outside-');
    const fifo = path.join(outside, 'fifo');
    const made = spawnSync('mkfifo', [fifo]);
    expect(made.status).toBe(0);
    fs.symlinkSync(fifo, path.join(cwd, 'fifo-link'));

    // Run in a child so a regression blocks there and fails on the timeout
    // instead of hanging the test runner.
    const script = `
      import {getFileMetricsMap, getReviewFileContents, resolveRefs} from ${JSON.stringify(gitModule)};
      const cwd = ${JSON.stringify(cwd)};
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const additions = getFileMetricsMap(cwd, range).get('fifo-link')?.additions;
      const contents = getReviewFileContents(cwd, range, {path: 'fifo-link', status: 'untracked'});
      console.log(JSON.stringify({additions, contents}));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual({additions: 1, contents: fifo});
  }, 20_000);

  it('refuses to read files that are too large or not regular', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const huge = path.join(cwd, 'huge.bin');
    fs.writeFileSync(huge, '');
    fs.truncateSync(huge, 64 * 1024 * 1024 + 1);
    fs.mkdirSync(path.join(cwd, 'dir'));

    const range = resolveRefs(cwd, 'HEAD', 'main');
    expect(() => getReviewFileContents(cwd, range, {path: 'huge.bin', status: 'untracked'})).toThrow(/larger than/);
    expect(() => getReviewFileContents(cwd, range, {path: 'dir', status: 'untracked'})).toThrow(/not a regular file/);
    expect(() => getReviewFileContents(cwd, range, {path: 'gone.txt', status: 'modified'})).toThrow(/no longer exists/);
  });
});

describe('review fingerprint', () => {
  it('changes for a same-size edit that keeps the mtime', () => {
    const cwd = initRepo({'value.ts': 'export const value = 1;\n'});
    const file = path.join(cwd, 'value.ts');
    writeFiles(cwd, {'value.ts': 'export const value = 2;\n'});
    const stamp = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, stamp, stamp);

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const before = getReviewFingerprint(cwd, range);

    fs.writeFileSync(file, 'export const value = 3;\n');
    fs.utimesSync(file, stamp, stamp);

    expect(getReviewFingerprint(cwd, range)).not.toBe(before);
  });

  it('stays the same when nothing changed', () => {
    const cwd = initRepo({'value.ts': 'export const value = 1;\n'});
    writeFiles(cwd, {'value.ts': 'export const value = 2;\n', 'new.ts': 'new\n'});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    expect(getReviewFingerprint(cwd, range)).toBe(getReviewFingerprint(cwd, range));
  });
});
