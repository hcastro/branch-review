import fs from 'node:fs';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  getChangedFileEntries,
  getReviewFileContents,
  getReviewFingerprint,
  readRawFileDiff,
  renderDiffForDisplay,
  resolveRefs,
} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {writeClipboard} from '../src/clipboard/write.js';
import {executeCopyCommand} from '../src/commands/execute.js';
import type {CommandContext} from '../src/commands/registry.js';
import {cleanupTempDirs, commitAll, git, gitSpy, initRepo, makeTempDir, withEnv, writeExecutable, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 60_000});

afterEach(cleanupTempDirs);

function gitWithInput(cwd: string, args: string[], input: Buffer | string) {
  return execFileSync('git', args, {cwd, input, encoding: 'utf8'}).trim();
}

// Commits files whose names are raw bytes on top of HEAD as branch `name`,
// with plumbing, so it works on filesystems that reject such names.
function commitRawNames(cwd: string, name: string, files: Array<{name: Buffer; contents: string}>) {
  const tree = execFileSync('git', ['ls-tree', '-z', 'HEAD'], {cwd});
  const entries = files.map(({name: fileName, contents}) => {
    const blob = gitWithInput(cwd, ['hash-object', '-w', '--stdin'], contents);
    return Buffer.concat([Buffer.from(`100644 blob ${blob}\t`), fileName, Buffer.from([0])]);
  });
  const newTree = gitWithInput(cwd, ['mktree', '-z'], Buffer.concat([tree, ...entries]));
  const commit = gitWithInput(cwd, ['commit-tree', newTree, '-p', 'HEAD', '-m', 'raw names'], '');
  git(cwd, 'update-ref', `refs/heads/${name}`, commit);
}

function recordingWriter() {
  const writes: string[] = [];
  return {
    writes,
    write: (text: string) => {
      writes.push(text);
      return {ok: true as const, command: {command: 'fake', args: [], displayName: 'fake'}};
    },
  };
}

const latin1Name = (stem: string, byte: number) => Buffer.concat([Buffer.from(stem), Buffer.from([byte]), Buffer.from('.txt')]);

describe('file names that are not UTF-8', () => {
  it('become error rows under distinct escaped names, and every copy of them fails with the reason', async () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    commitRawNames(cwd, 'feat', [
      {name: latin1Name('caf', 0xE9), contents: 'one\ntwo\n'},
      {name: latin1Name('caf', 0xE8), contents: 'three\n'},
      {name: Buffer.from('ok.txt'), contents: 'fine\n'},
    ]);

    const range = resolveRefs(cwd, 'feat', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    expect(model.files.map((file) => file.path)).toEqual(['caf\\350.txt', 'caf\\351.txt', 'ok.txt']);

    for (const file of model.files.slice(0, 2)) {
      expect(file.error).toBe('file name is not UTF-8');
      expect(file.rawDiffError).toBe('file name is not UTF-8');
      expect(file.pathError).toBe('file name is not UTF-8');
      expect(file.renderedLines).toEqual([]);
    }
    const ok = model.files[2]!;
    expect(ok.error).toBeUndefined();
    expect(ok.pathError).toBeUndefined();
    expect(ok.blocks[0]?.addedCode).toBe('fine');

    const bad = model.files[1]!;
    const writer = recordingWriter();
    const context: CommandContext = {
      model,
      activeFile: bad,
      readFileContent: (target) => getReviewFileContents(cwd, range, target),
      resolveAbsolutePath: (target) => path.join(cwd, target.path),
    };
    for (const id of ['copy.path', 'copy.absolutePath', 'copy.fileContents', 'copy.fileDiff', 'copy.filePrompt']) {
      const result = await executeCopyCommand(id, context, {write: writer.write});
      expect(result, id).toMatchObject({ok: false, hint: 'file name is not UTF-8'});
    }
    const allPaths = await executeCopyCommand('copy.allPaths', context, {write: writer.write});
    expect(allPaths).toMatchObject({ok: false, hint: 'file name is not UTF-8: caf\\350.txt'});
    expect(writer.writes).toEqual([]);

    // The UTF-8 file next to them still copies.
    const okCopy = await executeCopyCommand('copy.path', {...context, activeFile: ok}, {write: writer.write});
    expect(okCopy.ok).toBe(true);
    expect(writer.writes).toEqual(['ok.txt']);
  });

  it('marks an untracked file whose name is not UTF-8, where the filesystem allows one', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    try {
      fs.writeFileSync(Buffer.concat([Buffer.from(`${cwd}/`), latin1Name('caf', 0xE9)]), 'one\n');
    } catch (error) {
      // APFS and other UTF-8-only filesystems refuse the name outright.
      expect((error as NodeJS.ErrnoException).code).toBe('EILSEQ');
      return;
    }

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    expect(model.files).toHaveLength(1);
    expect(model.files[0]).toMatchObject({
      path: 'caf\\351.txt',
      status: 'untracked',
      error: 'file name is not UTF-8',
      rawDiffError: 'file name is not UTF-8',
      pathError: 'file name is not UTF-8',
    });
  });
});

// git's own patch for an untracked file at `name`, with the same diff options
// the review uses.
function gitNoIndexPatch(cwd: string, name: string) {
  const result = spawnSync('git', [
    '-c', 'core.quotePath=false',
    'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
    '--', '/dev/null', name,
  ], {cwd, encoding: 'utf8'});
  expect(result.status).toBe(1);
  return result.stdout;
}

describe('untracked symlinks', () => {
  it('get the patch git prints for a link whose text has or ends in a newline, and for a quoted name', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const links: Array<[string, string]> = [
      ['two-lines', 'first\nsecond'],
      ['trailing-newline', 'first\n'],
      ['three-lines-newline', 'one\ntwo\nthree\n'],
      ['we"ird\\\x01name', 'target'],
      ['has space', 'target'],
    ];
    for (const [name, target] of links) fs.symlinkSync(target, path.join(cwd, name));

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const untracked = new Set(links.map(([name]) => name));
    for (const [name] of links) {
      expect(readRawFileDiff(cwd, range, name, untracked).text, name).toBe(gitNoIndexPatch(cwd, name));
    }

    // The block holds every line of the link text.
    const model = buildReviewModel({cwd, range, width: 100});
    expect(model.files.find((file) => file.path === 'two-lines')?.blocks[0]?.addedCode).toBe('first\nsecond');
  });
});

describe('the worktree fingerprint', () => {
  it('changes when an untracked file becomes executable, and the rebuilt diff shows the new mode', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'run.sh': 'echo hi\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    const before = getReviewFingerprint(cwd, range);
    expect(getReviewFingerprint(cwd, range)).toBe(before);
    fs.chmodSync(path.join(cwd, 'run.sh'), 0o755);

    expect(getReviewFingerprint(cwd, range)).not.toBe(before);
    expect(buildReviewModel({cwd, range, width: 100}).files[0]?.rawDiff).toContain('new file mode 100755');
  });
});

describe('diff.autoRefreshIndex=false in the repo config', () => {
  it('does not list a touched but unchanged file as modified', () => {
    const cwd = initRepo({'a.txt': 'a\n', 'b.txt': 'b\n'});
    git(cwd, 'config', 'diff.autoRefreshIndex', 'false');
    writeFiles(cwd, {'b.txt': 'b2\n'});
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(cwd, 'a.txt'), later, later);

    const range = resolveRefs(cwd, 'HEAD', 'main');
    expect(getChangedFileEntries(cwd, range).map((entry) => entry.path)).toEqual(['b.txt']);
    expect(buildReviewModel({cwd, range, width: 100}).files.map((file) => file.path)).toEqual(['b.txt']);
  });
});

describe('a file named like the range argument', () => {
  it('does not break a branch review when a file is named base...branch', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    git(cwd, 'checkout', '-q', '-b', 'feat2');
    writeFiles(cwd, {'a.txt': 'a\nb\n'});
    commitAll(cwd, 'change');
    writeFiles(cwd, {'main...feat2': 'decoy\n'});

    const range = resolveRefs(cwd, 'feat2', 'main');
    expect(range.diffArg).toBe('main...feat2');
    const spy = gitSpy();
    const model = withEnv({PATH: spy.pathValue}, () => buildReviewModel({cwd, range, width: 100}));
    expect(model.files.map((file) => [file.path, file.error])).toEqual([['a.txt', undefined]]);
    // The whole-range count succeeds, so the per-file fallback never runs.
    expect(spy.calls().filter((call) => call.args.includes('--numstat'))).toHaveLength(1);
    expect(() => getReviewFingerprint(cwd, range)).not.toThrow();
  });

  it('does not break a worktree review when a file is named after the merge-base sha', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');
    writeFiles(cwd, {'a.txt': 'a\nb\n', [range.diffArg]: 'decoy\n'});

    const model = buildReviewModel({cwd, range, width: 100});
    expect(model.files.map((file) => [file.path, file.status, file.error])).toEqual([
      [range.diffArg, 'untracked', undefined],
      ['a.txt', 'modified', undefined],
    ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    expect(() => getReviewFingerprint(cwd, range)).not.toThrow();
  });
});

describe('a relative temp dir', () => {
  it('still points git at the private index copy', () => {
    // Deeper than this process's directory, so the relative path resolves
    // to somewhere else when git resolves it from the repo.
    const cwd = path.join(makeTempDir('branch-review-deep-'), 'one', 'two', 'three', 'repo');
    fs.mkdirSync(cwd, {recursive: true});
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Test User');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    writeFiles(cwd, {'a.txt': 'a\n', 'b.txt': 'b\n'});
    commitAll(cwd, 'initial');
    writeFiles(cwd, {'a.txt': 'a\nmore\n'});
    const tmp = makeTempDir('branch-review-reltmp-');
    const relative = path.relative(process.cwd(), tmp);
    expect(path.isAbsolute(relative)).toBe(false);
    const spy = gitSpy();

    const model = withEnv({BRANCH_REVIEW_TMPDIR: relative, PATH: spy.pathValue}, () => {
      const range = resolveRefs(cwd, 'HEAD', 'main');
      return buildReviewModel({cwd, range, width: 100});
    });

    expect(model.files.map((file) => [file.path, file.status])).toEqual([['a.txt', 'modified']]);
    const indexFiles = spy.calls().map((call) => call.indexFile).filter((file) => file !== 'unset');
    expect(indexFiles.length).toBeGreaterThan(0);
    for (const file of indexFiles) {
      expect(path.isAbsolute(file), file).toBe(true);
      expect(file.startsWith(`${tmp}${path.sep}branch-review-index-`), file).toBe(true);
    }
  });
});

describe('a tool killed by a signal', () => {
  it('names the signal when delta is killed', () => {
    const bin = makeTempDir('branch-review-killed-delta-');
    writeExecutable(path.join(bin, 'delta'), '#!/bin/sh\nkill -KILL $$\n');
    const cwd = makeTempDir('branch-review-killed-cwd-');

    withEnv({PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}, () => {
      expect(() => renderDiffForDisplay(cwd, 'diff --git a/x b/x\n', 100)).toThrow('delta failed: killed by SIGKILL');
    });
  });

  it('names the signal when git is killed', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    writeFiles(cwd, {'a.txt': 'a\nb\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const bin = makeTempDir('branch-review-killed-git-');
    const realGit = execFileSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).trim();
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      'case "$*" in *--name-status*) kill -KILL $$;; esac',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));

    withEnv({PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}, () => {
      expect(() => getChangedFileEntries(cwd, range)).toThrow('git diff failed: killed by SIGKILL');
    });
  });

  it('names the signal when the clipboard tool is killed', async () => {
    const bin = makeTempDir('branch-review-killed-clip-');
    const tool = writeExecutable(path.join(bin, 'fake-clip'), '#!/bin/sh\nkill -KILL $$\n');

    const result = await writeClipboard('text', {command: {command: tool, args: [], displayName: 'fake-clip'}});

    expect(result).toEqual({ok: false, message: 'Clipboard write failed using fake-clip.', hint: 'Process killed by SIGKILL.'});
  });
});
