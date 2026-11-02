import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {branchCommitsOperation, runOperationAsync, upstreamStateOperation} from '../src/git.js';
import type {ReviewRequest} from '../src/rendered/backend.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, writeFiles} from './core-helpers.js';

// What the Review in browser page's title and Commits tab read from git, on
// real temp repos: the branch's own commits, and where it stands against
// its upstream, from local refs alone.

afterEach(cleanupTempDirs);

function sshKeygen() {
  return ['/usr/bin/ssh-keygen', '/opt/homebrew/bin/ssh-keygen', '/usr/local/bin/ssh-keygen'].some((candidate) => fs.existsSync(candidate));
}

function branchRepo() {
  const cwd = initRepo({'README.md': '# widget\n'});
  git(cwd, 'checkout', '-q', '-b', 'feature/docs');
  writeFiles(cwd, {'src/a.ts': 'a\n', 'src/b.ts': 'b\n'});
  commitAll(cwd, 'feat: add two files');
  writeFiles(cwd, {'README.md': '# widget\n\nMore.\n'});
  commitAll(cwd, 'docs: say more');
  return cwd;
}

describe('branchCommitsOperation', () => {
  it('lists the commits the base lacks, newest first, with their files counted and no author', async () => {
    const cwd = branchRepo();
    const commits = await runOperationAsync(branchCommitsOperation(cwd, 'main', 'feature/docs'));
    expect(commits.map(({subject, files}) => [subject, files])).toEqual([['docs: say more', 1], ['feat: add two files', 2]]);
    expect(commits[0]!.hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(commits[0]!.time).toBeGreaterThan(1_600_000_000);
    expect(JSON.stringify(commits)).not.toMatch(/Test User|example\.com/);
  });

  it('stops at its limit, and finds none on a branch with no commits of its own', async () => {
    const cwd = branchRepo();
    expect(await runOperationAsync(branchCommitsOperation(cwd, 'main', 'feature/docs', 1))).toHaveLength(1);
    expect(await runOperationAsync(branchCommitsOperation(cwd, 'feature/docs', 'main'))).toEqual([]);
  });

  it('reads a subject holding the record separators as its own text, never as more commits', async () => {
    const cwd = branchRepo();
    writeFiles(cwd, {'f': 'f\n'});
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'real subject\x1edeadbee\x1f4102444800\x1fFake commit by nobody');
    const commits = await runOperationAsync(branchCommitsOperation(cwd, 'main', 'feature/docs'));
    expect(commits.map(({subject, files}) => [subject, files])).toEqual([
      ['real subject\x1edeadbee\x1f4102444800\x1fFake commit by nobody', 1],
      ['docs: say more', 1],
      ['feat: add two files', 2],
    ]);
    expect(commits.some((commit) => commit.hash === 'deadbee')).toBe(false);
  });

  it.skipIf(!sshKeygen())('counts only the files of signed commits when the repo shows signatures in its log', async () => {
    const cwd = branchRepo();
    const keys = makeTempDir('branch-review-signing-');
    const key = path.join(keys, 'id');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
    git(cwd, 'config', 'gpg.format', 'ssh');
    git(cwd, 'config', 'user.signingkey', key);
    writeFiles(cwd, {'f': 'f\n'});
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-S', '-m', 'signed one');
    writeFiles(cwd, {'g': 'g\n'});
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-S', '-m', 'signed two');
    git(cwd, 'config', 'log.showSignature', 'true');
    const commits = await runOperationAsync(branchCommitsOperation(cwd, 'main', 'feature/docs'));
    expect(commits.map(({subject, files}) => [subject, files])).toEqual([['signed two', 1], ['signed one', 1], ['docs: say more', 1], ['feat: add two files', 2]]);
  });
});

describe('upstreamStateOperation', () => {
  it('says a branch with no upstream has none, and how far one with an upstream is ahead', async () => {
    const cwd = branchRepo();
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs'))).toEqual({remote: null});

    const remote = makeTempDir('branch-review-remote-');
    git(remote, 'init', '-q', '--bare');
    git(cwd, 'remote', 'add', 'origin', remote);
    git(cwd, 'push', '-q', '-u', 'origin', 'feature/docs');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs'))).toEqual({remote: 'origin', ahead: 0});
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'HEAD'))).toEqual({remote: 'origin', ahead: 0});

    writeFiles(cwd, {'src/c.ts': 'c\n'});
    commitAll(cwd, 'feat: one more');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs'))).toEqual({remote: 'origin', ahead: 1});
  });

  it('counts how far a branch is behind its upstream, and both ways once the two have diverged', async () => {
    const cwd = branchRepo();
    const remote = makeTempDir('branch-review-remote-');
    git(remote, 'init', '-q', '--bare');
    git(cwd, 'remote', 'add', 'origin', remote);
    git(cwd, 'push', '-q', '-u', 'origin', 'feature/docs');
    // The upstream has a commit the branch doesn't, as after a teammate's push.
    git(cwd, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs'))).toEqual({remote: 'origin', ahead: 0, behind: 1});

    writeFiles(cwd, {'src/c.ts': 'c\n'});
    commitAll(cwd, 'feat: a different one');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs'))).toEqual({remote: 'origin', ahead: 1, behind: 1});
  });

  it('names no state for a ref that is no local branch', async () => {
    const cwd = branchRepo();
    const commit = git(cwd, 'rev-parse', 'HEAD').trim();
    expect(await runOperationAsync(upstreamStateOperation(cwd, commit))).toBeNull();
    git(cwd, 'tag', 'v1');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'v1'))).toBeNull();
  });
});

describe('the Review in browser page in a partial clone', () => {
  it('fetches nothing for a side the clone lacks: the card draws its hunks alone', async () => {
    const before = 'export const a = 1;\n'.repeat(20);
    const after = `${before}export const b = 2;\n`;
    const source = initRepo({'src/a.ts': before});
    writeFiles(source, {'src/a.ts': after});
    commitAll(source, 'feat: add b');
    git(source, 'config', 'uploadpack.allowFilter', 'true');
    const oldId = git(source, 'rev-parse', 'HEAD~1:src/a.ts').trim();
    const newId = git(source, 'rev-parse', 'HEAD:src/a.ts').trim();
    const holder = makeTempDir('branch-review-partial-');
    git(holder, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${source}`, 'clone');
    const clone = path.join(holder, 'clone');
    const missing = () => git(clone, 'rev-list', '--objects', '--all', '--missing=print').split('\n').filter((line) => line.startsWith('?')).length;
    const lacking = missing();
    expect(lacking).toBeGreaterThanOrEqual(2);

    // Both sides named by their full ids, as a patch with core.abbrev=no names them.
    const patch = '@@ -20,0 +21 @@ export const a = 1;\n+export const b = 2;\n';
    const request: ReviewRequest = {
      key: 'k', cwd: clone, refs: {base: 'HEAD~1', branch: 'HEAD'}, title: {repo: 'clone', base: 'main', branch: 'main', worktree: false}, reviewId: 'r', links: {}, assets: null, findings: [],
      cards: [{path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0, kind: 'text', identity: 'a', blocks: [{rawDiff: patch}], sides: {before: {kind: 'blob', id: oldId}, after: {kind: 'blob', id: newId}}}],
    };
    const handler = createRenderedHandler();
    try {
      const result = await handler.handle({type: 'review', ...request}) as {ok: true; html: string};
      expect(result.ok).toBe(true);
      const data = JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(result.html)![1]!) as {cards: Array<{diff: {hunks: unknown[]; context: unknown} | null}>};
      expect(data.cards[0]!.diff!.hunks).toHaveLength(1);
      expect(data.cards[0]!.diff!.context).toBeNull();
      expect(missing()).toBe(lacking);
    } finally {
      handler.dispose();
    }
  }, 60_000);
});
