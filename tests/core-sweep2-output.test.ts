import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  getColoredFileDiff,
  getReviewFileContents,
  getReviewFingerprint,
  renderDiffForDisplay,
  resolveRefs,
} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import {buildCodePayload, buildFileDiffPayload} from '../src/clipboard/payloads.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, withEnv, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

const ANSI = /\x1B\[[0-9;]*[A-Za-z]|\x1B\]8;[^\x07\x1B]*(?:\x07|\x1B\\)/g;
const COLOR_ENV = {NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: 'xterm-256color'};

function plain(text: string) {
  return text.replace(ANSI, '');
}

function applyCheck(cwd: string, patch: string) {
  return execFileSync('git', ['apply', '--check', '-'], {cwd, input: patch, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
}

describe('type changes keep each hunk inside its own section', () => {
  for (const direction of ['file to symlink', 'symlink to file'] as const) {
    it(`ends the block at its last line for a ${direction}`, () => {
      const cwd = initRepo({'keep.txt': 'keep\n'});
      if (direction === 'file to symlink') {
        writeFiles(cwd, {cfg: 'one\ntwo\n'});
      } else {
        fs.symlinkSync('keep.txt', path.join(cwd, 'cfg'));
      }
      commitAll(cwd, 'cfg');
      git(cwd, 'checkout', '-q', '-b', 'feature');
      fs.rmSync(path.join(cwd, 'cfg'));
      if (direction === 'file to symlink') {
        fs.symlinkSync('keep.txt', path.join(cwd, 'cfg'));
      } else {
        writeFiles(cwd, {cfg: 'one\ntwo\n'});
      }
      commitAll(cwd, 'type change');

      const range = resolveRefs(cwd, 'feature', 'main');
      const file = buildReviewModel({cwd, range, width: 100}).files.find((entry) => entry.path === 'cfg')!;
      expect(file.rawDiff.match(/^diff --git /gm)).toHaveLength(2);
      expect(file.blocks).toHaveLength(2);
      for (const block of file.blocks) {
        expect(block.rawDiff).not.toContain('diff --git');
        expect(block.rawDiff).not.toContain('+++ ');
        expect(block.rawDiff.startsWith('@@')).toBe(true);
      }

      const [removed, added] = file.blocks;
      if (direction === 'file to symlink') {
        expect(removed!.rawDiff).toBe('@@ -1,2 +0,0 @@\n-one\n-two\n');
        expect(added!.addedCode).toBe('keep.txt');
        expect(added!.rawDiff).toBe('@@ -0,0 +1 @@\n+keep.txt\n\\ No newline at end of file\n');
        expect([added!.lineStart, added!.lineEnd]).toEqual([1, 1]);
      } else {
        expect(removed!.rawDiff).toBe('@@ -1 +0,0 @@\n-keep.txt\n\\ No newline at end of file\n');
        expect(added!.addedCode).toBe('one\ntwo');
        expect([added!.lineStart, added!.lineEnd]).toEqual([1, 2]);
      }
    });
  }

  it('ends a hunk by its line counts in a raw two-section patch', () => {
    const raw = [
      'diff --git a/cfg b/cfg',
      'deleted file mode 100644',
      'index 814f4a4..0000000',
      '--- a/cfg',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-one',
      '-two',
      'diff --git a/cfg b/cfg',
      'new file mode 120000',
      'index 0000000..1de5659',
      '--- /dev/null',
      '+++ b/cfg',
      '@@ -0,0 +1 @@',
      '+target',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    const blocks = parseUnifiedDiffBlocks(raw, 'cfg');
    expect(blocks.map((block) => block.rawDiff)).toEqual([
      '@@ -1,2 +0,0 @@\n-one\n-two\n',
      '@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n',
    ]);
    expect(blocks[0]!.addedCode).toBe('');
    expect(blocks[1]!.addedCode).toBe('target');
  });
});

describe('delta layout', () => {
  it('renders a line longer than 3000 characters in full', () => {
    const cwd = initRepo({'a.txt': 'one\n'});
    const long = `${'x'.repeat(5000)}TAILMARKER`;
    writeFiles(cwd, {'a.txt': `one\n${long}\n`});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    withEnv(COLOR_ENV, () => {
      const rendered = plain(getColoredFileDiff(cwd, range, 'a.txt', 100));
      expect(rendered).toContain('TAILMARKER');
      expect(rendered).toContain('x'.repeat(5000));
    });
  });

  for (const features of ['+side-by-side', '+hyperlinks', 'side-by-side hyperlinks']) {
    it(`ignores DELTA_FEATURES=${features}`, () => {
      const cwd = initRepo({'a.txt': 'one\ngone\n'});
      writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
      const range = resolveRefs(cwd, 'HEAD', 'main');

      const expected = withEnv({...COLOR_ENV, DELTA_FEATURES: undefined}, () => getColoredFileDiff(cwd, range, 'a.txt', 100));
      const actual = withEnv({...COLOR_ENV, DELTA_FEATURES: features}, () => getColoredFileDiff(cwd, range, 'a.txt', 100));
      expect(actual).toBe(expected);
      expect(actual).not.toContain('\x1B]8;');
    });
  }
});

describe('untracked special files', () => {
  it('reads an untracked file named - from disk, not stdin, and keeps its mode', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'-': 'first\nsecond\n', 'x/-': 'nested\n'});
    fs.chmodSync(path.join(cwd, '-'), 0o755);
    const range = resolveRefs(cwd, 'HEAD', 'main');

    const model = buildReviewModel({cwd, range, width: 100});
    const dash = model.files.find((file) => file.path === '-')!;
    expect(dash.error).toBeUndefined();
    expect(dash.rawDiff).toBe([
      'diff --git a/- b/-',
      'new file mode 100755',
      `index 0000000..${blobHash('first\nsecond\n').slice(0, 7)}`,
      '--- /dev/null',
      '+++ b/-',
      '@@ -0,0 +1,2 @@',
      '+first',
      '+second',
      '',
    ].join('\n'));
    expect(dash.blocks[0]?.addedCode).toBe('first\nsecond');
    expect(dash.metrics.additions).toBe(2);
    expect(model.files.find((file) => file.path === 'x/-')?.blocks[0]?.addedCode).toBe('nested');

    const scratch = makeTempDir('branch-review-apply-');
    git(scratch, 'init', '-q');
    expect(() => applyCheck(scratch, buildFileDiffPayload(dash))).not.toThrow();
  });

  it('diffs untracked symlinks to a directory, a file and nothing as their link text', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    fs.mkdirSync(path.join(cwd, 'dir'));
    writeFiles(cwd, {'dir/inside.txt': 'inside\n'});
    fs.symlinkSync('dir', path.join(cwd, 'dirlink'));
    fs.symlinkSync('a.txt', path.join(cwd, 'filelink'));
    fs.symlinkSync('missing/target', path.join(cwd, 'dangling'));
    const range = resolveRefs(cwd, 'HEAD', 'main');

    // git's own patch for a file link is the reference shape.
    fs.symlinkSync('a.txt', path.join(cwd, 'with space'));
    const reference = (name: string) => spawnSync('git', ['diff', '--no-index', '--', '/dev/null', name], {cwd, encoding: 'utf8'}).stdout;

    const model = buildReviewModel({cwd, range, width: 100});
    const byPath = new Map(model.files.map((file) => [file.path, file]));
    for (const [name, target] of [['dirlink', 'dir'], ['filelink', 'a.txt'], ['dangling', 'missing/target']] as const) {
      const file = byPath.get(name)!;
      expect(file.error).toBeUndefined();
      expect(file.rawDiff).toBe([
        `diff --git a/${name} b/${name}`,
        'new file mode 120000',
        `index 0000000..${blobHash(target).slice(0, 7)}`,
        '--- /dev/null',
        `+++ b/${name}`,
        '@@ -0,0 +1 @@',
        `+${target}`,
        '\\ No newline at end of file',
        '',
      ].join('\n'));
      expect(file.blocks[0]?.addedCode).toBe(target);
      expect(file.metrics.additions).toBe(1);
    }
    expect(byPath.get('filelink')!.rawDiff).toBe(reference('filelink'));
    // git ends a header path holding a space with a tab.
    expect(byPath.get('with space')!.rawDiff).toBe(reference('with space'));
    expect(byPath.get('with space')!.rawDiff).toContain('+++ b/with space\t\n');
  });
});

function blobHash(contents: string) {
  return execFileSync('git', ['hash-object', '--stdin'], {input: contents, encoding: 'utf8'}).trim();
}

describe('user diff config cannot change copied patches', () => {
  it('keeps a/ b/ prefixes and blank context lines under noprefix, mnemonicPrefix and suppressBlankEmpty', () => {
    const base = 'a\nb\nc\n\nd\n';
    const cwd = initRepo({'f.txt': base});
    git(cwd, 'config', 'diff.noprefix', 'true');
    git(cwd, 'config', 'diff.mnemonicPrefix', 'true');
    git(cwd, 'config', 'diff.suppressBlankEmpty', 'true');
    writeFiles(cwd, {'f.txt': base.replace('c\n', 'C\n'), 'new.txt': 'new\n'});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    const tracked = model.files.find((file) => file.path === 'f.txt')!;
    const untracked = model.files.find((file) => file.path === 'new.txt')!;

    expect(tracked.rawDiff).toContain('diff --git a/f.txt b/f.txt\n');
    expect(tracked.rawDiff).toContain('--- a/f.txt\n+++ b/f.txt\n');
    expect(tracked.rawDiff).toContain('\n \n');
    expect(untracked.rawDiff).toContain('diff --git a/new.txt b/new.txt\n');

    git(cwd, 'stash', '-q', '-u');
    expect(() => applyCheck(cwd, buildFileDiffPayload(tracked))).not.toThrow();
    expect(() => applyCheck(cwd, buildFileDiffPayload(untracked))).not.toThrow();
  });
});

describe('non-ASCII paths', () => {
  it('shows non-ASCII names unquoted in patches and block headers', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'café 日本.ts': 'export {};\n', 'tracked é.ts': 'x\n'});
    git(cwd, 'add', 'tracked é.ts');
    const range = resolveRefs(cwd, 'HEAD', 'main');

    withEnv(COLOR_ENV, () => {
      const model = buildReviewModel({cwd, range, width: 100});
      for (const name of ['café 日本.ts', 'tracked é.ts']) {
        const file = model.files.find((entry) => entry.path === name)!;
        // git ends a header path holding a space with a tab.
        expect(file.rawDiff).toContain(`+++ b/${name}\t\n`);
        expect(file.rawDiff).not.toContain('\\303');
        expect(plain(file.renderedLines.join('\n'))).toContain(`${name}:1:`);
      }
    });
  });
});

describe('refs without a merge base', () => {
  it('names both refs and says they share no history', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    git(cwd, 'checkout', '-q', '--orphan', 'orphan');
    git(cwd, 'rm', '-q', '-rf', '.');
    writeFiles(cwd, {'b.txt': 'b\n'});
    commitAll(cwd, 'orphan root');

    expect(() => resolveRefs(cwd, 'HEAD', 'main')).toThrow(/^main and HEAD share no history \(shallow clone or unrelated branches\)$/);
    expect(() => resolveRefs(cwd, 'orphan', 'main')).toThrow(/^main and orphan share no history \(shallow clone or unrelated branches\)$/);
  });
});

describe('an unreadable tracked file', () => {
  it('becomes an error row instead of failing the review, and the fingerprint still tracks it', () => {
    const cwd = initRepo({'a.txt': 'a\n', 'b.txt': 'b\n'});
    writeFiles(cwd, {'a.txt': 'a2\n', 'b.txt': 'b2\n'});
    const locked = path.join(cwd, 'a.txt');
    fs.chmodSync(locked, 0o000);

    try {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const model = buildReviewModel({cwd, range, width: 100});
      const byPath = new Map(model.files.map((file) => [file.path, file]));
      expect([...byPath.keys()]).toEqual(['a.txt', 'b.txt']);
      expect(byPath.get('a.txt')?.error).toMatch(/a\.txt/);
      expect(byPath.get('b.txt')?.error).toBeUndefined();
      expect(byPath.get('b.txt')?.metrics).toMatchObject({additions: 1, deletions: 1});

      const before = getReviewFingerprint(cwd, range);
      expect(getReviewFingerprint(cwd, range)).toBe(before);
      fs.chmodSync(locked, 0o644);
      fs.writeFileSync(locked, 'a3\n');
      fs.chmodSync(locked, 0o000);
      const future = new Date(Date.now() + 120_000);
      fs.utimesSync(locked, future, future);
      expect(getReviewFingerprint(cwd, range)).not.toBe(before);
    } finally {
      fs.chmodSync(locked, 0o644);
    }
  });
});

describe('non-UTF-8 contents', () => {
  it('marks a Latin-1 file so copies refuse it, and leaves UTF-8 files alone', () => {
    const cwd = initRepo({'latin.txt': 'plain\n', 'utf.txt': 'plain\n'});
    fs.writeFileSync(path.join(cwd, 'latin.txt'), Buffer.from('plain\ncaf\xe9\n', 'latin1'));
    writeFiles(cwd, {'utf.txt': 'plain\ncafé\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    const model = buildReviewModel({cwd, range, width: 100});
    const latin = model.files.find((file) => file.path === 'latin.txt')!;
    const utf = model.files.find((file) => file.path === 'utf.txt')!;

    expect(latin.rawDiffError).toBe('not UTF-8 text');
    expect(latin.error).toBeUndefined();
    expect(latin.renderedLines.length).toBeGreaterThan(0);
    expect(() => getReviewFileContents(cwd, range, latin)).toThrow(/not UTF-8 text/);

    expect(utf.rawDiffError).toBeUndefined();
    expect(getReviewFileContents(cwd, range, utf)).toBe('plain\ncafé\n');
    expect(buildCodePayload(utf.blocks[0]!)).toBe('café');

    git(cwd, 'checkout', '-q', '-b', 'feature');
    commitAll(cwd, 'latin');
    const committed = resolveRefs(cwd, 'feature', 'main');
    expect(() => getReviewFileContents(cwd, committed, latin)).toThrow(/not UTF-8 text/);
    expect(getReviewFileContents(cwd, committed, utf)).toBe('plain\ncafé\n');
  });
});

describe('files with no text diff', () => {
  it('gets one visible placeholder line built from the diff header', () => {
    const cwd = initRepo({'old.txt': 'same\n', 'run.sh': 'echo\n', 'data.bin': 'bin\0\x01', 'gone-empty.txt': ''});
    git(cwd, 'checkout', '-q', '-b', 'delete-empty');
    fs.rmSync(path.join(cwd, 'gone-empty.txt'));
    commitAll(cwd, 'delete an empty file');
    git(cwd, 'checkout', '-q', 'main');
    git(cwd, 'checkout', '-q', '-b', 'feature');
    git(cwd, 'mv', 'old.txt', 'renamed.txt');
    fs.chmodSync(path.join(cwd, 'run.sh'), 0o755);
    fs.writeFileSync(path.join(cwd, 'data.bin'), 'bin\0\x02');
    fs.writeFileSync(path.join(cwd, 'empty.txt'), '');
    commitAll(cwd, 'no text changes');

    withEnv(COLOR_ENV, () => {
      const range = resolveRefs(cwd, 'feature', 'main');
      const model = buildReviewModel({cwd, range, width: 100});
      const lines = Object.fromEntries(model.files.map((file) => [file.path, file.renderedLines]));

      expect(lines).toEqual({
        'data.bin': ['binary file changed'],
        'empty.txt': ['new empty file'],
        'renamed.txt': ['renamed from old.txt'],
        'run.sh': ['mode 100644 → 100755'],
      });

      const deleted = buildReviewModel({cwd, range: resolveRefs(cwd, 'delete-empty', 'main'), width: 100});
      expect(deleted.files.map((file) => [file.path, file.renderedLines])).toEqual([['gone-empty.txt', ['deleted empty file']]]);
    });
  });

  it('escapes control characters in a rename placeholder and keeps ordinary diffs unchanged', () => {
    const cwd = initRepo({'old\u202Ename.txt': 'same\n', 'a.txt': 'a\n'});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    git(cwd, 'mv', 'old\u202Ename.txt', 'new.txt');
    writeFiles(cwd, {'a.txt': 'a2\n'});
    commitAll(cwd, 'rename');

    withEnv(COLOR_ENV, () => {
      const range = resolveRefs(cwd, 'feature', 'main');
      const model = buildReviewModel({cwd, range, width: 100});
      expect(model.files.find((file) => file.path === 'new.txt')?.renderedLines).toEqual(['renamed from old<U+202E>name.txt']);
      const a = model.files.find((file) => file.path === 'a.txt')!;
      expect(a.renderedLines).toEqual(renderDiffForDisplay(cwd, a.rawDiff, 100).split('\n').filter(Boolean));
    });
  });
});

describe('building file by file', () => {
  it('builds each file once, in order, an unreadable one as an error row', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a2\n', 'b.txt': 'b\n', 'locked.txt': 'secret\n', 'z.txt': 'z\n'});
    fs.chmodSync(path.join(cwd, 'locked.txt'), 0o000);

    try {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      const model = buildReviewModel({cwd, range, width: 100});

      expect(model.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'locked.txt', 'z.txt']);
      expect(model.files.filter((file) => file.error !== undefined).map((file) => file.path)).toEqual(['locked.txt']);
    } finally {
      fs.chmodSync(path.join(cwd, 'locked.txt'), 0o644);
    }
  });

  it('reads each file when its turn comes, so one deleted mid-build becomes an error row', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a2\n', 'b.txt': 'b\n', 'c.txt': 'c\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');
    // A delta that deletes c.txt while it renders b.txt, then prints the
    // patch as it came in. c.txt is affected only if it has not been read yet.
    const bin = makeTempDir('branch-review-deleting-delta-');
    const delta = path.join(bin, 'delta');
    fs.writeFileSync(delta, [
      '#!/bin/sh',
      'input=$(cat)',
      `case "$input" in *'+++ b/b.txt'*) rm -f '${path.join(cwd, 'c.txt')}';; esac`,
      `printf '%s\\n' "$input"`,
      '',
    ].join('\n'));
    fs.chmodSync(delta, 0o755);

    const model = withEnv({PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}, () => buildReviewModel({cwd, range, width: 100}));

    expect(model.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(model.files.find((file) => file.path === 'b.txt')?.error).toBeUndefined();
    expect(model.files.find((file) => file.path === 'b.txt')?.renderedLines).toContain('+b');
    expect(model.files.find((file) => file.path === 'c.txt')?.error).toMatch(/c\.txt/);
    expect(fs.existsSync(path.join(cwd, 'c.txt'))).toBe(false);
  });
});
