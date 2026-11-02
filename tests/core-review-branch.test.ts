import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {reviewCardRequest} from '../src/rendered/review/request.js';
import {prepareStartup} from '../src/startup.js';
import {readTips, startRenderedService} from '../src/rendered/service.js';
import type {BranchReading} from '../src/rendered/review/build.js';
import {branchCommitCountOperation, branchCommitsOperation, branchTipsOperation, runOperationAsync, upstreamStateOperation} from '../src/git.js';
import type {ReviewRequest} from '../src/rendered/backend.js';
import {createReviewBuilder} from '../src/rendered/review/build.js';
import type {SourceReader} from '../src/rendered/source.js';
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

// `count` commits on `feat` over `main`, written by one git fast-import.
function longBranch(count: number) {
  const cwd = initRepo({'README.md': '# widget\n'});
  const base = git(cwd, 'rev-parse', 'main').trim();
  // After the base's commit time: a branch dated before its base skews git's walk.
  const start = Math.floor(Date.now() / 1000) + 60;
  const stream = Array.from({length: count}, (_, index) => {
    const message = `commit ${index + 1}\n`;
    return [`commit refs/heads/feat`, `committer Test <test@example.com> ${start + index} +0000`, `data ${Buffer.byteLength(message)}`, message, ...(index === 0 ? [`from ${base}`] : []), ''].join('\n');
  }).join('\n');
  execFileSync('git', ['-C', cwd, 'fast-import', '--quiet'], {input: stream});
  return cwd;
}

const noSides = {read: async () => ({kind: 'unavailable', reason: 'none'})} as unknown as SourceReader;
// The page for `base..branch`, with no cards, its branch facts read by git or by `readBranch`.
const pageFor = (cwd: string, branch: string, readBranch?: Parameters<typeof createReviewBuilder>[0]['branch'], base = 'main') => {
  const builder = createReviewBuilder({sources: noSides, fragment: async () => ({body: {kind: 'pending'}}), ...(readBranch ? {branch: readBranch} : {})});
  return builder.page({key: 'k', cwd, refs: {base, branch}, title: {repo: 'widget', base, branch, worktree: false}, reviewId: 'r', cards: [], links: {}, assets: null, findings: []});
};
// The page for the repo's branch with git reads that may take at most `gitBudgetMs`.
const pageForBudget = (cwd: string, gitBudgetMs: number) => createReviewBuilder({sources: noSides, fragment: async () => ({body: {kind: 'pending'}}), gitBudgetMs})
  .page({key: 'k', cwd, refs: {base: 'main', branch: 'feature/docs'}, title: {repo: 'widget', base: 'main', branch: 'feature/docs', worktree: false}, reviewId: 'r', cards: [], links: {}, assets: null, findings: []});
const pillOf = async (cwd: string, branch: string) => /<span class="rv-state[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/.exec((await pageFor(cwd, branch)).html)?.[1] ?? null;

describe('the commit count', () => {
  const commitsTab = (html: string) => html.slice(html.indexOf('id="panel-commits"'), html.indexOf('id="menu"'));

  it('counts every commit on the branch, all of them', async () => {
    const cwd = longBranch(260);
    expect(await runOperationAsync(branchCommitCountOperation(cwd, 'main', 'feat'))).toBe(260);
    expect(await runOperationAsync(branchCommitCountOperation(cwd, 'feat', 'main'))).toBe(0);
  });

  it('gives the full count in the heading, the toolbar and the tab, and says the list shows the newest 250', async () => {
    const cwd = longBranch(260);
    const {html, partial} = await pageFor(cwd, 'feat');
    expect(partial).toBe(false);
    expect(html).toContain('260 commits on <span class="rv-ref">feat</span> that are not on <span class="rv-ref">main</span>');
    expect(html).toContain('Showing changes from <b>all 260 commits</b>');
    expect(html).toMatch(/Commits<span class="rv-count">260<\/span>/);
    const tab = commitsTab(html);
    expect(tab.match(/<li>/g)).toHaveLength(250);
    expect(tab).toContain('Showing the newest 250 of 260 commits.');
  }, 60_000);

  it('says 250+ and that the page is partial when the list came back full and the count didn\'t', async () => {
    const commits = Array.from({length: 250}, (_, index) => ({hash: `abc${String(index).padStart(4, '0')}`, subject: `commit ${index}`, time: 1_700_000_000 - index, files: 1}));
    const {html, partial} = await pageFor('/repo', 'feat', async () => ({commits, upstream: {remote: null}}));
    expect(partial).toBe(true);
    expect(html).toContain('250+ commits on <span class="rv-ref">feat</span> that are not on');
    expect(html).toContain('Showing changes from <b>all 250+ commits</b>');
    expect(html).toMatch(/Commits<span class="rv-count">250\+<\/span>/);
    expect(commitsTab(html)).toContain('Showing the newest 250 commits.');
  });

  it('adds no line under a list that holds every commit', async () => {
    const cwd = longBranch(3);
    const {html, partial} = await pageFor(cwd, 'feat');
    expect(partial).toBe(false);
    expect(html).toContain('3 commits on <span class="rv-ref">feat</span>');
    expect(commitsTab(html)).not.toContain('Showing the newest');
    // A short list needs no count from git to be whole.
    const short = await pageFor('/repo', 'feat', async () => ({commits: [{hash: 'abc1234', subject: 'one', time: 1, files: 1}], upstream: {remote: null}}));
    expect(short.partial).toBe(false);
    expect(short.html).toMatch(/Commits<span class="rv-count">1<\/span>/);
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

describe('the pill for a branch with no upstream set', () => {
  const bare = () => {
    const remote = makeTempDir('branch-review-remote-');
    git(remote, 'init', '-q', '--bare');
    return remote;
  };

  it('compares a branch pushed without -u with its branch on the remote, and says Not pushed while it has none there', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    expect(await pillOf(cwd, 'feature/docs')).toBe('Not pushed');
    git(cwd, 'push', '-q', 'origin', 'feature/docs');
    // No upstream was set by that push.
    expect(() => git(cwd, 'config', '--get', 'branch.feature/docs.merge')).toThrow();
    expect(await pillOf(cwd, 'feature/docs')).toBe('Up to date with origin');
    writeFiles(cwd, {'src/c.ts': 'c\n'});
    commitAll(cwd, 'feat: one more');
    expect(await pillOf(cwd, 'feature/docs')).toBe('Ahead of origin by 1');
  }, 60_000);

  it('compares with the push remote when the branch names one, over the repo\'s other remote', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    git(cwd, 'remote', 'add', 'fork', bare());
    git(cwd, 'push', '-q', 'origin', 'feature/docs');
    // Two remotes and none named: no remote to compare with.
    expect(await pillOf(cwd, 'feature/docs')).toBe('Not pushed');
    writeFiles(cwd, {'src/c.ts': 'c\n'});
    commitAll(cwd, 'feat: one more');
    git(cwd, 'push', '-q', 'fork', 'feature/docs');
    git(cwd, 'config', 'branch.feature/docs.pushRemote', 'fork');
    expect(await pillOf(cwd, 'feature/docs')).toBe('Up to date with fork');
    git(cwd, 'config', '--unset', 'branch.feature/docs.pushRemote');
    git(cwd, 'config', 'remote.pushDefault', 'origin');
    expect(await pillOf(cwd, 'feature/docs')).toBe('Ahead of origin by 1');
  }, 60_000);

  it('falls back to the push remote when the upstream set is gone', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    git(cwd, 'push', '-q', '-u', 'origin', 'feature/docs:elsewhere');
    git(cwd, 'push', '-q', 'origin', 'feature/docs');
    git(cwd, 'update-ref', '-d', 'refs/remotes/origin/elsewhere');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs'))).toEqual({remote: 'origin', ahead: 0});
  }, 60_000);

  it('gives the page a new key after a push without -u', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    // What the page key hashes, read with no time budget: a loaded machine can't make it null.
    const tips = () => runOperationAsync(branchTipsOperation(cwd, 'main', 'feature/docs'));
    const before = await tips();
    git(cwd, 'push', '-q', 'origin', 'feature/docs');
    const after = await tips();
    expect(before).toMatch(/ -$/);
    expect(after).not.toBe(before);
    expect(after.split(' ')[2]).toBe(git(cwd, 'rev-parse', 'feature/docs').trim());
  }, 60_000);
});

describe('the tips read for a branch with no upstream set', () => {
  const bare = () => {
    const remote = makeTempDir('branch-review-remote-');
    git(remote, 'init', '-q', '--bare');
    return remote;
  };
  // A git ahead on PATH that counts its runs, then runs the real one.
  const countingGit = () => {
    const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim();
    const binDir = makeTempDir('branch-review-counting-git-');
    const log = path.join(binDir, 'runs');
    fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, {mode: 0o755});
    // A new program's first start on macOS waits for its check: run it once.
    execFileSync(path.join(binDir, 'git'), ['version']);
    const runs = async <T>(work: () => Promise<T>) => {
      fs.writeFileSync(log, '');
      const original = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${original ?? ''}`;
      try {
        const value = await work();
        return {value, runs: fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)};
      } finally {
        process.env.PATH = original;
      }
    };
    return runs;
  };

  it('gives the page a new key after a push without -u, read through the tips\' own budget', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    const refs = {base: 'main', branch: 'feature/docs'};
    // git's first run in a new repo is the slow one.
    await readTips(cwd, refs);
    const before = await readTips(cwd, refs);
    git(cwd, 'push', '-q', 'origin', 'feature/docs');
    const after = await readTips(cwd, refs);
    expect(before).toMatch(/ -$/);
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
    expect(after!.split(' ')[2]).toBe(git(cwd, 'rev-parse', 'feature/docs').trim());
  }, 60_000);

  it('reads where a branch with no upstream would push in three git runs past the tips, one with no remote, and two past the state\'s own', async () => {
    const counted = countingGit();
    const cwd = branchRepo();
    const tips = () => runOperationAsync(branchTipsOperation(cwd, 'main', 'feature/docs'));
    // No remote: one config read past the three tips.
    const alone = await counted(tips);
    expect(alone.value).toMatch(/ -$/);
    expect(alone.runs).toHaveLength(4);
    git(cwd, 'remote', 'add', 'origin', bare());
    git(cwd, 'push', '-q', 'origin', 'feature/docs');
    const pushed = await counted(tips);
    expect(pushed.value.split(' ')[2]).toBe(git(cwd, 'rev-parse', 'feature/docs').trim());
    expect(pushed.runs).toHaveLength(6);
    // The state: the branch, its upstream, the config, the ref and the count.
    const state = await counted(() => runOperationAsync(upstreamStateOperation(cwd, 'feature/docs')));
    expect(state.value).toEqual({remote: 'origin', ahead: 0});
    expect(state.runs).toHaveLength(5);
    // A branch with an upstream reads it as before.
    git(cwd, 'branch', '-q', '--set-upstream-to', 'origin/feature/docs');
    const upstream = await counted(tips);
    expect(upstream.value).toBe(pushed.value);
    expect(upstream.runs).toHaveLength(3);
  }, 60_000);

  it('finds the ref of the branch alone, never one under it as a folder, and the push remote by its exact name', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    // origin has feat-x/sub, which the pattern refs/remotes/origin/feat-x matches as a folder, but no feat-x.
    git(cwd, 'update-ref', 'refs/remotes/origin/feat-x/sub', 'HEAD');
    git(cwd, 'checkout', '-q', '-b', 'feat-x');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'feat-x'))).toEqual({remote: null});
    expect(await runOperationAsync(branchTipsOperation(cwd, 'main', 'feat-x'))).toMatch(/ -$/);
    // A branch whose name is a pattern's own characters, pushed to the remote its pushRemote names.
    git(cwd, 'checkout', '-q', '-b', 'Fix.1+2');
    git(cwd, 'remote', 'add', 'Fork.Two', bare());
    git(cwd, 'push', '-q', 'Fork.Two', 'Fix.1+2');
    git(cwd, 'config', 'branch.Fix.1+2.pushRemote', 'Fork.Two');
    expect(await runOperationAsync(upstreamStateOperation(cwd, 'Fix.1+2'))).toEqual({remote: 'Fork.Two', ahead: 0});
  }, 60_000);

  it('takes the value git takes for each push setting: the repo\'s own over the global one, and the last one a file sets twice', async () => {
    const cwd = branchRepo();
    git(cwd, 'remote', 'add', 'origin', bare());
    git(cwd, 'remote', 'add', 'fork', bare());
    // origin's copy of the branch is two commits behind; fork's is up to date.
    git(cwd, 'push', '-q', 'origin', 'feature/docs~2:refs/heads/feature/docs');
    git(cwd, 'push', '-q', 'fork', 'feature/docs');
    git(cwd, 'fetch', '-q', 'origin');
    git(cwd, 'fetch', '-q', 'fork');
    const head = git(cwd, 'rev-parse', 'feature/docs').trim();
    const behind = git(cwd, 'rev-parse', 'origin/feature/docs').trim();
    expect(behind).not.toBe(head);
    const global = path.join(makeTempDir('branch-review-global-config-'), 'gitconfig');
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    try {
      const read = async () => ({
        state: await runOperationAsync(upstreamStateOperation(cwd, 'feature/docs')),
        // The tips readTips gives the page's key, read here with no budget, so a loaded machine can't time them out.
        tip: (await runOperationAsync(branchTipsOperation(cwd, 'main', 'feature/docs'))).split(' ')[2],
      });
      const setting = (scope: string[], key: string) => execFileSync('git', ['config', ...scope, '--get', key], {cwd, encoding: 'utf8', env: process.env}).trim();
      // The global value alone still counts.
      git(path.dirname(global), 'config', '--file', global, 'remote.pushDefault', 'origin');
      expect(await read()).toEqual({state: {remote: 'origin', ahead: 2}, tip: behind});
      // The repo's own value overrides it, as git push and git config --get read it.
      git(cwd, 'config', 'remote.pushDefault', 'fork');
      expect(setting([], 'remote.pushDefault')).toBe('fork');
      expect(await read()).toEqual({state: {remote: 'fork', ahead: 0}, tip: head});
      // And the other way round.
      git(path.dirname(global), 'config', '--file', global, 'remote.pushDefault', 'fork');
      git(cwd, 'config', 'remote.pushDefault', 'origin');
      expect(await read()).toEqual({state: {remote: 'origin', ahead: 2}, tip: behind});
      // A key set twice in one file: the last value wins.
      git(cwd, 'config', '--unset', 'remote.pushDefault');
      git(path.dirname(global), 'config', '--file', global, '--unset', 'remote.pushDefault');
      git(cwd, 'config', '--add', 'branch.feature/docs.remote', 'origin');
      git(cwd, 'config', '--add', 'branch.feature/docs.remote', 'fork');
      expect(setting([], 'branch.feature/docs.remote')).toBe('fork');
      expect(await read()).toEqual({state: {remote: 'fork', ahead: 0}, tip: head});
    } finally {
      if (original === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = original;
    }
  }, 60_000);
});

const dataOf = (html: string) => JSON.parse(/<script type="application\/json" id="rv-data">([\s\S]*?)<\/script>/.exec(html)![1]!) as {cards: Array<{diff: {context: string[] | null} | null}>};

describe('the page\'s git reads and the work tree', () => {
  it('draws a work tree file rewritten after the review read its diff from the diff alone, its context left out', async () => {
    const cwd = initRepo({'src/a.ts': 'one\ntwo\nthree\n'});
    writeFiles(cwd, {'src/a.ts': 'one\nTWO\nthree\n'});
    const {range, review} = await prepareStartup({cwd, options: {requestedBranch: 'HEAD', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    // An agent rewrites the file, keeping its line count.
    writeFiles(cwd, {'src/a.ts': 'uno\ndos\ntres\n'});
    const file = review.files.find((each) => each.path === 'src/a.ts')!;
    const request: ReviewRequest = {key: 'k', cwd, refs: {base: range.base, branch: range.branch}, title: {repo: 'r', base: 'main', branch: 'HEAD', worktree: true}, reviewId: 'r', links: {}, assets: null, findings: [], cards: [reviewCardRequest(file, range, null)]};
    const handler = createRenderedHandler();
    try {
      const result = await handler.handle({type: 'review', ...request}) as {ok: true; html: string};
      expect(result.ok).toBe(true);
      const added = /<tr class="add">.*?<td class="cd"><span class="mk">\+<\/span>(.*?)<\/td><\/tr>/.exec(result.html)![1]!;
      expect(added.replace(/<[^>]+>/g, '')).toBe('TWO');
      expect(result.html).not.toContain('dos');
      expect(dataOf(result.html).cards[0]!.diff!.context).toBeNull();
    } finally {
      handler.dispose();
    }
  }, 60_000);

  it('stops the git it started once the git budget runs out', async () => {
    const cwd = branchRepo();
    const pidFile = path.join(makeTempDir('branch-review-git-pid-'), 'pid');
    const realGit = execFileSync('sh', ['-c', 'command -v git'], {encoding: 'utf8'}).trim();
    const binDir = makeTempDir('branch-review-fake-git-');
    // A git whose log hangs, recording its pid; everything else is the real one.
    fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\ncase " $* " in *" log "*) echo $$ > '${pidFile}'; exec sleep 30;; esac\nexec '${realGit}' "$@"\n`, {mode: 0o755});
    // git's version for this repo is asked once and kept: asked now, through
    // the real git, so the log starts well inside the budget.
    await runOperationAsync(branchCommitsOperation(cwd, 'main', 'feature/docs'));
    // A new program's first start on macOS waits for its check: run it once.
    execFileSync(path.join(binDir, 'git'), ['version']);
    const original = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${original ?? ''}`;
    try {
      const {partial} = await pageForBudget(cwd, 200);
      expect(partial).toBe(true);
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      const alive = () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let wait = 0; wait < 20 && alive(); wait += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(alive()).toBe(false);
    } finally {
      process.env.PATH = original;
    }
  }, 60_000);

  it('aborts an injected branch reader\'s signal once the git budget runs out', async () => {
    let seen: AbortSignal | undefined;
    const branch = (_cwd: string, _refs: unknown, signal: AbortSignal) => {
      seen = signal;
      return new Promise<BranchReading>(() => undefined);
    };
    const builder = createReviewBuilder({sources: noSides, fragment: async () => ({body: {kind: 'pending'}}), branch, gitBudgetMs: 50});
    const {partial} = await builder.page({key: 'k', cwd: '/repo', refs: {base: 'main', branch: 'feat'}, title: {repo: 'r', base: 'main', branch: 'feat', worktree: false}, reviewId: 'r', cards: [], links: {}, assets: null, findings: []});
    expect(partial).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it('says a page whose git budget ran out in the worker\'s job is partial', async () => {
    const handler = createRenderedHandler({branch: () => new Promise(() => undefined), gitBudgetMs: 0});
    try {
      const result = await handler.handle({type: 'review', key: 'k', cwd: '/repo', refs: {base: 'main', branch: 'feat'}, title: {repo: 'r', base: 'main', branch: 'feat', worktree: false}, reviewId: 'r', cards: [], links: {}, assets: null, findings: []}) as {ok: true; html: string; partial?: true};
      expect(result).toMatchObject({ok: true, partial: true});
      expect(result.html).toContain('Branch state unavailable');
    } finally {
      handler.dispose();
    }
  });

  it('draws the new state on the next page after a push, through the service the CLI runs', async () => {
    const cwd = branchRepo();
    const remote = makeTempDir('branch-review-remote-');
    git(remote, 'init', '-q', '--bare');
    git(cwd, 'remote', 'add', 'origin', remote);
    const {range, review} = await prepareStartup({cwd, options: {requestedBranch: 'feature/docs', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    const session = makeTempDir('branch-review-service-');
    const service = startRenderedService({tempDir: () => session, env: {...process.env, CMUX_WORKSPACE_ID: ''}, cwd, opener: {open: async () => ({ok: true})} as never});
    try {
      service.setReview(review, {cwd, range});
      const pill = async () => {
        const outcome = await service.page();
        expect(outcome.ok).toBe(true);
        return /<span class="rv-state[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]*)<\/span>/.exec(fs.readFileSync(new URL((outcome as {url: string}).url), 'utf8'))?.[1];
      };
      expect(await pill()).toBe('Not pushed');
      git(cwd, 'push', '-q', '-u', 'origin', 'feature/docs');
      expect(await pill()).toBe('Up to date with origin');
    } finally {
      service.dispose();
    }
  }, 60_000);
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
