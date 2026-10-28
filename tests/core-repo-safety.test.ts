import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getChangedFileEntries, getReviewFingerprint, resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {cleanupTempDirs, commitAll, git, gitSpy, hashFile, initRepo, makeTempDir, withEnv, writeExecutable, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

function touchLater(filePath: string) {
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(filePath, future, future);
}

describe('git calls never write the reviewed repo', () => {
  it('leaves .git/index untouched for a stat-dirty file and does not list it', () => {
    const cwd = initRepo({'a.txt': 'a\n', 'b.txt': 'b\n'});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    writeFiles(cwd, {'b.txt': 'b changed\n'});
    touchLater(path.join(cwd, 'a.txt'));

    const indexPath = path.join(cwd, '.git', 'index');
    const before = hashFile(indexPath);
    const range = resolveRefs(cwd, 'HEAD', 'main');

    const model = buildReviewModel({cwd, range, width: 100});
    expect(hashFile(indexPath)).toBe(before);

    getReviewFingerprint(cwd, range);
    expect(hashFile(indexPath)).toBe(before);

    expect(model.files.map((file) => file.path)).toEqual(['b.txt']);
    expect(fs.existsSync(path.join(cwd, '.git', 'index.lock'))).toBe(false);
  });

  it('lists a same-size edit made in the same second as the last index write', () => {
    // A racily clean entry: its stat matches the worktree file (same size,
    // inode and mtime second) and its mtime is not older than the index file,
    // so only git's racy-clean content check can see the edit. trustctime is
    // off so the ctime from the rewrite can't give the change away.
    const cwd = initRepo({});
    git(cwd, 'config', 'core.trustctime', 'false');
    const file = path.join(cwd, 'value.ts');
    const past = new Date('2020-01-01T00:00:00Z');
    fs.writeFileSync(file, 'export const value = 1;\n');
    fs.utimesSync(file, past, past);
    commitAll(cwd, 'value');

    fs.writeFileSync(file, 'export const value = 2;\n');
    fs.utimesSync(file, past, past);
    fs.utimesSync(path.join(cwd, '.git', 'index'), past, past);

    const range = resolveRefs(cwd, 'HEAD', 'main');
    expect(getChangedFileEntries(cwd, range)).toEqual([{path: 'value.ts', status: 'modified'}]);
    expect(buildReviewModel({cwd, range, width: 100}).files[0]?.blocks[0]?.addedCode).toBe('export const value = 2;');
  });

  it('works in a repo that has no index file yet', () => {
    const cwd = makeTempDir('branch-review-empty-');
    git(cwd, 'init', '-q', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Test User');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'empty');
    fs.rmSync(path.join(cwd, '.git', 'index'), {force: true});
    writeFiles(cwd, {'new.txt': 'new\n'});
    const spy = gitSpy();

    const range = resolveRefs(cwd, 'HEAD', 'main');
    withEnv({PATH: spy.pathValue, GIT_INDEX_FILE: undefined}, () => {
      expect(getChangedFileEntries(cwd, range).map((entry) => entry.path)).toEqual(['new.txt']);
    });
    expect(fs.existsSync(path.join(cwd, '.git', 'index'))).toBe(false);

    // git writes no index for these reads when none exists, so the check above
    // alone can't tell a private index from none. Every listing call must
    // still be pointed at a temp index outside the repo.
    const listing = spy.calls().filter((call) => /^-c .* (diff|ls-files) /.test(call.args));
    expect(listing.length).toBeGreaterThan(0);
    for (const call of listing) {
      expect(call.indexFile).toMatch(/branch-review-index-[^/]+\/index$/);
      expect(call.indexFile.startsWith(cwd)).toBe(false);
    }
  });
});

describe('repo config cannot change what git prints or run commands', () => {
  it('ignores diff.external and textconv drivers', () => {
    const cwd = initRepo({'notes.txt': 'hello\n'});
    const tools = makeTempDir('branch-review-tools-');
    const external = writeExecutable(path.join(tools, 'extdiff.sh'), '#!/bin/sh\necho EXTERNAL-DIFF-OUTPUT\n');
    const textconv = writeExecutable(path.join(tools, 'upper.sh'), '#!/bin/sh\ntr a-z A-Z < "$1"\n');
    git(cwd, 'config', 'diff.external', external);
    git(cwd, 'config', 'diff.upper.textconv', textconv);
    writeFiles(cwd, {'.gitattributes': '*.txt diff=upper\n'});
    commitAll(cwd, 'attributes');
    writeFiles(cwd, {'notes.txt': 'hello\nworld\n'});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    const notes = model.files.find((file) => file.path === 'notes.txt');

    expect(notes?.rawDiff).not.toContain('EXTERNAL-DIFF-OUTPUT');
    expect(notes?.rawDiff).not.toContain('WORLD');
    expect(notes?.rawDiff).toContain('+world\n');
    expect(notes?.blocks).toHaveLength(1);
    expect(notes?.blocks[0]?.addedCode).toBe('world');
    expect(notes?.renderedLines.join('\n')).not.toContain('EXTERNAL-DIFF-OUTPUT');
  });

  it('never runs a core.fsmonitor hook', () => {
    const cwd = initRepo({'a.txt': 'a\n'});
    const tools = makeTempDir('branch-review-tools-');
    const marker = path.join(tools, 'fsmonitor-ran');
    const hook = writeExecutable(path.join(tools, 'fsmonitor.sh'), `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`);
    git(cwd, 'config', 'core.fsmonitor', hook);
    writeFiles(cwd, {'a.txt': 'a changed\n', 'u.txt': 'untracked\n'});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    buildReviewModel({cwd, range, width: 100});
    getReviewFingerprint(cwd, range);

    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe('file names are literal, never pathspec patterns', () => {
  it('keeps [ab].txt from matching a.txt and b.txt', () => {
    const cwd = initRepo({'[ab].txt': 'x\n', 'a.txt': 'a\n', 'b.txt': 'b\n'});
    writeFiles(cwd, {'[ab].txt': 'x2\n', 'a.txt': 'a2\n', 'b.txt': 'b2\n', 'app/[id]/page.tsx': 'page\n'});
    git(cwd, 'add', 'app');

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    const glob = model.files.find((file) => file.path === '[ab].txt');

    expect(glob?.blocks).toHaveLength(1);
    expect(glob?.rawDiff).not.toContain('a/a.txt');
    expect(glob?.rawDiff).not.toContain('a/b.txt');
    expect(glob?.blocks[0]?.addedCode).toBe('x2');

    const page = model.files.find((file) => file.path === 'app/[id]/page.tsx');
    expect(page?.blocks[0]?.addedCode).toBe('page');
  });
});
