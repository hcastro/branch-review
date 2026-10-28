import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';

// Runs skills/branch-review/scripts/review-command.sh against throwaway repos
// with a PATH that holds only fake clipboard tools, a fake `branch-review` that
// records its cwd and argv, and links to the few real tools the script needs.
// No directory on that PATH contains a real clipboard tool.

const scriptPath = path.resolve(__dirname, '../skills/branch-review/scripts/review-command.sh');
const skillDocPath = path.resolve(__dirname, '../skills/branch-review/SKILL.md');

const realTools = ['git', 'dirname', 'grep', 'cp', 'rm', 'mktemp', 'cat', 'sleep', 'touch', 'id'];
const clipboardTools = ['pbcopy', 'wl-copy', 'xclip', 'clip.exe'];

function which(name: string): string | undefined {
  const result = spawnSync('/bin/sh', ['-c', `command -v "$1"`, 'sh', name], {encoding: 'utf8'});
  const found = result.stdout.trim();
  return result.status === 0 && found.startsWith('/') ? found : undefined;
}

// The macOS system bash is 3.2 and the PATH bash is usually 5.x; the script
// must behave the same under both.
const scriptShells = [...new Map(
  ['/bin/bash', which('bash')]
    .filter((bin): bin is string => Boolean(bin) && fs.existsSync(bin!))
    .map((bin) => [fs.realpathSync(bin), bin]),
).values()];
const zsh = which('zsh');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

type Sandbox = {
  root: string;
  bin: string;
  tools: string;
  home: string;
  tmp: string;
  clipOut: string;
  cliOut: string;
  env: NodeJS.ProcessEnv;
};

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body, {mode: 0o755});
}

function createSandbox(options: {clipboard?: 'pbcopy' | 'forking-xclip' | 'failing-pbcopy' | 'none'; cli?: boolean} = {}) {
  const {clipboard = 'pbcopy', cli = true} = options;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-skill-')));
  tempDirs.push(root);

  const bin = path.join(root, 'fake-bin');
  const tools = path.join(root, 'tools');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  for (const dir of [bin, tools, home, tmp]) fs.mkdirSync(dir);

  for (const tool of realTools) {
    const found = which(tool);
    if (found) fs.symlinkSync(found, path.join(tools, tool));
  }

  const clipOut = path.join(root, 'clipboard.txt');
  const cliOut = path.join(root, 'cli-argv.bin');

  if (clipboard === 'pbcopy') {
    writeExecutable(path.join(bin, 'pbcopy'), '#!/bin/sh\ncat > "$CLIP_OUT"\n');
  } else if (clipboard === 'failing-pbcopy') {
    writeExecutable(path.join(bin, 'pbcopy'), '#!/bin/sh\ncat >/dev/null\nexit 1\n');
  } else if (clipboard === 'forking-xclip') {
    // Like the real xclip: return at once but leave a child running that
    // inherited stdout and stderr.
    writeExecutable(
      path.join(bin, 'xclip'),
      '#!/bin/sh\ncat > "$CLIP_OUT"\nsleep 10 &\necho $! > "$CLIP_OUT.pid"\n',
    );
  }

  if (cli) {
    writeExecutable(path.join(bin, 'branch-review'), '#!/bin/sh\nprintf \'%s\\0\' "$(pwd -P)" "$@" > "$CLI_OUT"\n');
  }

  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${tools}`,
    HOME: home,
    TMPDIR: tmp,
    CLIP_OUT: clipOut,
    CLI_OUT: cliOut,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
  };

  return {root, bin, tools, home, tmp, clipOut, cliOut, env} satisfies Sandbox;
}

function git(sandbox: Sandbox, cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {...sandbox.env, PATH: `${sandbox.tools}:${process.env.PATH ?? ''}`},
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

// main has one commit; feat adds one more on top of it.
function createRepo(sandbox: Sandbox, dir = path.join(sandbox.root, 'repo')) {
  fs.mkdirSync(dir, {recursive: true});
  git(sandbox, dir, 'init', '-q', '-b', 'main');
  git(sandbox, dir, 'config', 'user.name', 'Test User');
  git(sandbox, dir, 'config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  git(sandbox, dir, 'add', '.');
  git(sandbox, dir, 'commit', '-q', '-m', 'initial');
  git(sandbox, dir, 'checkout', '-q', '-b', 'feat');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one changed\n');
  git(sandbox, dir, 'commit', '-q', '-am', 'feature change');
  return fs.realpathSync(dir);
}

function assertNoRealClipboard(sandbox: Sandbox, shell: string) {
  for (const tool of clipboardTools) {
    const result = spawnSync(shell, ['-c', 'command -v "$1" || true', 'sh', tool], {
      encoding: 'utf8',
      env: sandbox.env,
    });
    const found = result.stdout.trim();
    if (found) expect(path.dirname(found)).toBe(sandbox.bin);
  }
}

function runScript(sandbox: Sandbox, shell: string, args: string[], cwd = sandbox.root) {
  assertNoRealClipboard(sandbox, shell);
  const started = Date.now();
  const result = spawnSync(shell, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: sandbox.env,
    timeout: 15_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    command: result.stdout.replace(/\n$/, ''),
    elapsed: Date.now() - started,
  };
}

// Runs the printed command the way a user would after pasting it, and returns
// the cwd and argv the fake `branch-review` saw.
function paste(sandbox: Sandbox, shell: string, command: string) {
  fs.rmSync(sandbox.cliOut, {force: true});
  const pasteDir = path.join(sandbox.root, 'paste-cwd');
  fs.mkdirSync(pasteDir, {recursive: true});
  const args = path.basename(shell) === 'zsh' ? ['-f', '-c', command] : ['-c', command];
  const result = spawnSync(shell, args, {cwd: pasteDir, encoding: 'utf8', env: sandbox.env, timeout: 10_000});
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const [cwd, ...argv] = fs.readFileSync(sandbox.cliOut, 'utf8').split('\0').slice(0, -1);
  return {cwd, argv};
}

function pasteShells(scriptShell: string) {
  return zsh ? [scriptShell, zsh] : [scriptShell];
}

function findInjected(dir: string): string[] {
  const hits: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    if (entry.name.startsWith('PWN')) hits.push(path.join(dir, entry.name));
    if (entry.isDirectory() && entry.name !== '.git') hits.push(...findInjected(path.join(dir, entry.name)));
  }
  return hits;
}

function report(stderr: string, label: string) {
  const line = stderr.split('\n').find((l) => l.startsWith(`${label}:`));
  return line?.slice(label.length + 1).trim();
}

function sha256(file: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

it('runs the script under the macOS system bash when on macOS', () => {
  if (process.platform === 'darwin') expect(scriptShells).toContain('/bin/bash');
  expect(scriptShells.length).toBeGreaterThan(0);
});

describe.each(scriptShells)('review-command.sh under %s', (shell) => {
  describe('the printed command', () => {
    const hostileRefs = [
      'x;touch${IFS}PWNED1',
      'y$(touch${IFS}PWNED2)',
      'z&touch${IFS}PWNED3',
      'w`touch${IFS}PWNED4`',
      'feat;id>PWNED5',
      'q|touch${IFS}PWNED6',
      'topic/fix(auth)',
      "it's",
      'has"double',
    ];

    it('passes every branch name to the CLI as one literal argument', {timeout: 60_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      for (const ref of hostileRefs) git(sandbox, repo, 'branch', ref, 'feat');

      for (const ref of hostileRefs) {
        const run = runScript(sandbox, shell, [repo, ref, 'main']);
        expect(run.status, run.stderr).toBe(0);
        expect(fs.readFileSync(sandbox.clipOut, 'utf8')).toBe(run.command);

        for (const pasteShell of pasteShells(shell)) {
          const seen = paste(sandbox, pasteShell, run.command);
          expect(seen).toEqual({cwd: repo, argv: [ref, 'main']});
        }
      }

      expect(findInjected(sandbox.root)).toEqual([]);
    });

    it('passes a hostile base name to the CLI as one literal argument', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const base = 'b;touch${IFS}PWNED7';
      git(sandbox, repo, 'branch', base, 'main');

      const run = runScript(sandbox, shell, [repo, 'feat', base]);
      expect(run.status, run.stderr).toBe(0);
      for (const pasteShell of pasteShells(shell)) {
        expect(paste(sandbox, pasteShell, run.command)).toEqual({cwd: repo, argv: ['feat', base]});
      }
      expect(findInjected(sandbox.root)).toEqual([]);
    });

    it('keeps the default command free of ref arguments', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      for (const pasteShell of pasteShells(shell)) {
        expect(paste(sandbox, pasteShell, run.command)).toEqual({cwd: repo, argv: []});
      }
    });

    const hostileDirs = [
      "Henry's code",
      "x';touch PWNED8;#",
      'a $HOME "q" `touch PWNED9` \\ end',
      'with space',
    ];

    it('opens the right repo for paths with quotes, spaces and $', {timeout: 60_000}, () => {
      const sandbox = createSandbox();
      for (const name of hostileDirs) {
        const repo = createRepo(sandbox, path.join(sandbox.root, name, 'app'));

        const run = runScript(sandbox, shell, [path.join(repo, 'a.txt')]);
        expect(run.status, run.stderr).toBe(0);
        expect(report(run.stderr, 'repo')).toBe(repo);
        for (const pasteShell of pasteShells(shell)) {
          expect(paste(sandbox, pasteShell, run.command)).toEqual({cwd: repo, argv: []});
        }
      }
      expect(findInjected(sandbox.root)).toEqual([]);
    });
  });

  describe('the clipboard', () => {
    it('returns promptly when the clipboard tool leaves a child holding its output', {timeout: 20_000}, () => {
      const sandbox = createSandbox({clipboard: 'forking-xclip'});
      const repo = createRepo(sandbox);
      try {
        const run = runScript(sandbox, shell, [repo]);
        expect(run.status, run.stderr).toBe(0);
        expect(run.elapsed).toBeLessThan(6_000);
        expect(run.stderr).toContain('copied to clipboard via xclip');
        expect(fs.readFileSync(sandbox.clipOut, 'utf8')).toBe(run.command);
      } finally {
        const pidFile = `${sandbox.clipOut}.pid`;
        if (fs.existsSync(pidFile)) {
          try {
            process.kill(Number(fs.readFileSync(pidFile, 'utf8').trim()));
          } catch {
            // Already exited.
          }
        }
      }
    });

    it('reports a failed copy instead of claiming success', () => {
      const sandbox = createSandbox({clipboard: 'failing-pbcopy'});
      const repo = createRepo(sandbox);

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('copied to clipboard');
      expect(run.stderr).toContain('no clipboard tool');
      expect(run.command).toMatch(/&& branch-review$/);
    });
  });

  describe('the reviewed repo', () => {
    it('leaves .git/index untouched and ignores stat-only changes', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const index = path.join(repo, '.git', 'index');
      const future = new Date(Date.now() + 3_600_000);
      fs.utimesSync(path.join(repo, 'b.txt'), future, future);
      // The touched file is stat-dirty: diff-files (which never refreshes)
      // lists it although its content matches the index.
      expect(git(sandbox, repo, 'diff-files', '--name-only')).toBe('b.txt');

      for (const args of [[repo], [repo, 'feat', 'main'], [repo, 'HEAD', 'HEAD']]) {
        const before = {hash: sha256(index), mtime: fs.statSync(index).mtimeMs};
        const run = runScript(sandbox, shell, args);
        expect(run.status, run.stderr).toBe(0);
        expect({hash: sha256(index), mtime: fs.statSync(index).mtimeMs}).toEqual(before);
        expect(fs.existsSync(`${index}.lock`)).toBe(false);
        expect(fs.readdirSync(sandbox.tmp)).toEqual([]);
        if (args.length === 3 && args[2] === 'HEAD') {
          expect(report(run.stderr, 'in review')).toBe('0 files (0 tracked, 0 untracked)');
        } else {
          expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
        }
      }
      expect(git(sandbox, repo, 'diff-files', '--name-only')).toBe('b.txt');
    });

    it('still counts real worktree edits and untracked files', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'b.txt'), 'two changed\n');
      fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('3 files (2 tracked, 1 untracked)');
      expect(report(run.stderr, 'uncommitted')).toBe('2 entries');
    });
  });

  describe('the state report', () => {
    it('counts commits on the reviewed branch, not on HEAD', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      git(sandbox, repo, 'checkout', '-q', 'main');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'dirty on main\n');

      const run = runScript(sandbox, shell, [repo, 'feat', 'main']);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'commits')).toBe('1 ahead of base');
      expect(report(run.stderr, 'uncommitted')).toBe('not in this review (reviewing feat, not the worktree)');
      expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
    });

    it('counts commits ahead of base for the default HEAD review', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'c.txt'), 'three\n');
      git(sandbox, repo, 'add', 'c.txt');
      git(sandbox, repo, 'commit', '-q', '-m', 'second');
      fs.writeFileSync(path.join(repo, 'b.txt'), 'dirty\n');

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'commits')).toBe('2 ahead of base');
      expect(report(run.stderr, 'uncommitted')).toBe('1 entries');
    });

    it('reports a linked worktree as a worktree', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const linked = path.join(sandbox.root, 'linked');
      git(sandbox, repo, 'worktree', 'add', '-q', '-b', 'linked-branch', linked, 'feat');

      expect(report(runScript(sandbox, shell, [repo]).stderr, 'worktree')).toBe('no');
      const run = runScript(sandbox, shell, [linked]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'worktree')).toBe('yes');
      expect(report(run.stderr, 'repo')).toBe(fs.realpathSync(linked));
    });

    it('does not report a repo with a .git file of its own as a worktree', () => {
      const sandbox = createSandbox();
      const repo = path.join(sandbox.root, 'separate');
      fs.mkdirSync(repo);
      // A submodule checkout has the same layout: .git is a file pointing at a
      // git dir that is its own common dir.
      git(sandbox, repo, 'init', '-q', '-b', 'main', `--separate-git-dir=${path.join(sandbox.root, 'separate.git')}`);
      git(sandbox, repo, 'config', 'user.name', 'Test User');
      git(sandbox, repo, 'config', 'user.email', 'test@example.com');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
      git(sandbox, repo, 'add', '.');
      git(sandbox, repo, 'commit', '-q', '-m', 'initial');
      expect(fs.statSync(path.join(repo, '.git')).isFile()).toBe(true);

      const run = runScript(sandbox, shell, [repo, 'HEAD', 'HEAD']);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'worktree')).toBe('no');
    });

    it('points at the GitHub install when branch-review is missing', () => {
      const sandbox = createSandbox({cli: false});
      const repo = createRepo(sandbox);

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stderr).toContain(
        'install with: pnpm add -g --allow-build=branch-review github:hcastro/branch-review',
      );
      expect(run.stderr).not.toMatch(/pnpm add -g branch-review/);
    });
  });
});

describe('SKILL.md', () => {
  it('runs the script by its path under the skill directory, never from the cwd', () => {
    const lines = fs.readFileSync(skillDocPath, 'utf8').split('\n');
    let inFence = false;
    const invocations: string[] = [];
    for (const line of lines) {
      if (/^\s*(```|````)/.test(line)) inFence = !inFence;
      else if (inFence && line.includes('review-command.sh')) invocations.push(line);
    }
    expect(invocations.length).toBeGreaterThan(0);
    for (const line of invocations) {
      expect(line.trimStart()).toMatch(/^"<skill-dir>\/scripts\/review-command\.sh"/);
    }
    for (const line of lines) {
      expect(line).not.toMatch(/(^|[\s`(])scripts\/review-command\.sh/);
    }
  });
});
