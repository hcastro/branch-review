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

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
  // Every test blocks in spawnSync. Yielding one macrotask between tests lets
  // the worker answer vitest's RPC, which times out after 60 s of blocking.
  await new Promise((resolve) => setTimeout(resolve, 0));
});

type Sandbox = {
  root: string;
  bin: string;
  tools: string;
  home: string;
  tmp: string;
  clipOut: string;
  cliOut: string;
  gitEnvLog: string;
  env: NodeJS.ProcessEnv;
};

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body, {mode: 0o755});
}

type SandboxOptions = {
  clipboard?: 'pbcopy' | 'forking-xclip' | 'failing-pbcopy' | 'none';
  cli?: boolean;
  // Put a git on PATH that logs GIT_OPTIONAL_LOCKS and GIT_TERMINAL_PROMPT
  // for every call to `gitEnvLog`, then runs the real git.
  logGitEnv?: boolean;
  // Put a git on PATH that runs the real git, except that it fails any call
  // with an argument equal to $FAIL_GIT, and logs `ls -ld` of $GIT_INDEX_FILE
  // and its directory to $INDEX_MODE_LOG. Set those variables in `env` after
  // the repo is built, since the test's own git calls share `env`.
  wrapGit?: boolean;
};

function createSandbox(options: SandboxOptions = {}) {
  const {clipboard = 'pbcopy', cli = true, logGitEnv = false, wrapGit = false} = options;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-skill-')));
  tempDirs.push(root);

  const bin = path.join(root, 'fake-bin');
  const tools = path.join(root, 'tools');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  for (const dir of [bin, tools, home, tmp]) fs.mkdirSync(dir);

  const gitEnvLog = path.join(root, 'git-env.log');
  for (const tool of realTools) {
    const found = which(tool);
    if (!found) continue;
    if (tool === 'git' && logGitEnv) {
      writeExecutable(
        path.join(tools, 'git'),
        `#!/bin/sh\nprintf '%s %s\\n' "\${GIT_OPTIONAL_LOCKS-unset}" "\${GIT_TERMINAL_PROMPT-unset}" >> "$GIT_ENV_LOG"\nexec '${found}' "$@"\n`,
      );
    } else if (tool === 'git' && wrapGit) {
      const ls = which('ls')!;
      writeExecutable(
        path.join(tools, 'git'),
        [
          '#!/bin/sh',
          'if [ -n "$FAIL_GIT" ]; then',
          '  for arg in "$@"; do',
          '    if [ "$arg" = "$FAIL_GIT" ]; then echo "fatal: simulated failure of $arg" >&2; exit 128; fi',
          '  done',
          'fi',
          'if [ -n "$INDEX_MODE_LOG" ] && [ -n "$GIT_INDEX_FILE" ]; then',
          `  '${ls}' -ld "$GIT_INDEX_FILE" >> "$INDEX_MODE_LOG" 2>&1`,
          `  '${ls}' -ld "\${GIT_INDEX_FILE%/*}" >> "$INDEX_MODE_LOG" 2>&1`,
          'fi',
          `exec '${found}' "$@"`,
          '',
        ].join('\n'),
      );
    } else {
      fs.symlinkSync(found, path.join(tools, tool));
    }
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
    GIT_ENV_LOG: gitEnvLog,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    LC_ALL: 'C',
  };

  return {root, bin, tools, home, tmp, clipOut, cliOut, gitEnvLog, env} satisfies Sandbox;
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

// Every file under `dir`, keyed by relative path, valued by content hash. A
// new, removed or rewritten file changes the snapshot; a refreshed mtime
// alone does not.
function snapshotFiles(dir: string, prefix = ''): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const relative = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, snapshotFiles(full, relative));
    else if (entry.isFile()) snapshot[relative] = sha256(full);
  }
  return snapshot;
}

// Sets a file's atime and mtime to a whole second, so git sees no sub-second part.
function setMtime(file: string, seconds: number) {
  fs.utimesSync(file, seconds, seconds);
}

// The characters a terminal acts on or hides: C0 (newline and tab included),
// DEL, C1, bidi controls and invisible format characters.
const rawHidden =
  /[\x00-\x1f\x7f\u0080-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/u;

// stderr split into lines, each checked for raw hidden characters. Only the
// line terminators may be newlines.
function stderrLines(stderr: string) {
  expect(stderr.endsWith('\n')).toBe(true);
  const lines = stderr.slice(0, -1).split('\n');
  for (const line of lines) expect(line, JSON.stringify(line)).not.toMatch(rawHidden);
  return lines;
}

// ls -l permission string, e.g. "drwx------". True when a user other than the
// owner could read the file: it is group/other readable and every listed
// directory lets them through.
function readableByOthers(fileMode: string, dirMode: string) {
  const fileOpen = fileMode[4] === 'r' || fileMode[7] === 'r';
  const dirOpen = dirMode[6] === 'x' || dirMode[9] === 'x';
  return fileOpen && dirOpen;
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

    it('ignores stat-only changes when the repo sets diff.autoRefreshIndex=false', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      git(sandbox, repo, 'config', 'diff.autoRefreshIndex', 'false');
      const future = new Date(Date.now() + 3_600_000);
      fs.utimesSync(path.join(repo, 'b.txt'), future, future);
      expect(git(sandbox, repo, 'diff-files', '--name-only')).toBe('b.txt');

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
    });

    it('reads the range as revisions when a file in the worktree has the same name', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'main...feat'), '');
      fs.writeFileSync(path.join(repo, git(sandbox, repo, 'merge-base', 'main', 'HEAD')), '');

      const branch = runScript(sandbox, shell, [repo, 'feat', 'main']);
      expect(branch.status, branch.stderr).toBe(0);
      expect(branch.stderr).not.toContain('git diff failed');
      expect(report(branch.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');

      const head = runScript(sandbox, shell, [repo]);
      expect(head.status, head.stderr).toBe(0);
      expect(head.stderr).not.toContain('git diff failed');
      expect(report(head.stderr, 'in review')).toBe('3 files (1 tracked, 2 untracked)');
    });

    it('leaves a submodule index alone when a file inside the submodule is stat-dirty', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const source = path.join(sandbox.root, 'sub-source');
      fs.mkdirSync(source);
      git(sandbox, source, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(source, 'inner.txt'), 'inner\n');
      git(sandbox, source, 'add', '.');
      git(sandbox, source, '-c', 'user.name=Test User', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'sub');
      git(sandbox, repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', source, 'sub');
      git(sandbox, repo, 'commit', '-q', '-m', 'add submodule');

      const future = new Date(Date.now() + 3_600_000);
      fs.utimesSync(path.join(repo, 'sub', 'inner.txt'), future, future);
      expect(git(sandbox, path.join(repo, 'sub'), 'diff-files', '--name-only')).toBe('inner.txt');
      expect(fs.existsSync(path.join(repo, '.git', 'modules', 'sub', 'index'))).toBe(true);

      const before = snapshotFiles(path.join(repo, '.git'));
      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(snapshotFiles(path.join(repo, '.git'))).toEqual(before);
      expect(git(sandbox, path.join(repo, 'sub'), 'diff-files', '--name-only')).toBe('inner.txt');
    });

    it('writes no shared index into .git when the repo uses a split index', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const names = Array.from({length: 50}, (_, i) => `split-${i}.txt`);
      for (const name of names) fs.writeFileSync(path.join(repo, name), `${name}\n`);
      git(sandbox, repo, 'add', '.');
      git(sandbox, repo, 'commit', '-q', '-m', 'many files');
      // The files must match the base: git refreshes the index only after it
      // finds stat-dirty files whose content is unchanged.
      git(sandbox, repo, 'branch', '-f', 'main', 'HEAD');
      fs.writeFileSync(path.join(repo, 'a.txt'), 'edited\n');
      git(sandbox, repo, 'config', 'core.splitIndex', 'true');
      git(sandbox, repo, 'config', 'splitIndex.maxPercentChange', '0');
      git(sandbox, repo, 'update-index', '--split-index');
      expect(fs.readdirSync(path.join(repo, '.git')).some((name) => name.startsWith('sharedindex.'))).toBe(true);

      const future = new Date(Date.now() + 3_600_000);
      for (const name of names) fs.utimesSync(path.join(repo, name), future, future);

      const before = snapshotFiles(path.join(repo, '.git'));
      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(Object.keys(snapshotFiles(path.join(repo, '.git'))).sort()).toEqual(Object.keys(before).sort());
      expect(snapshotFiles(path.join(repo, '.git'))).toEqual(before);
      expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
    });

    it('sees a same-size edit made in the same second the index was written', () => {
      const sandbox = createSandbox();
      const repo = path.join(sandbox.root, 'racy');
      fs.mkdirSync(repo);
      git(sandbox, repo, 'init', '-q', '-b', 'main');
      git(sandbox, repo, 'config', 'user.name', 'Test User');
      git(sandbox, repo, 'config', 'user.email', 'test@example.com');
      // ctime can't be set from a test; with it out of the stat check, the
      // file and the index sharing one mtime second is the whole race.
      git(sandbox, repo, 'config', 'core.trustctime', 'false');
      const file = path.join(repo, 'f');
      const second = Math.floor(Date.now() / 1000) - 100;
      fs.writeFileSync(file, 'aaa\n');
      setMtime(file, second);
      git(sandbox, repo, 'add', 'f');
      git(sandbox, repo, 'commit', '-q', '-m', 'base');
      fs.writeFileSync(file, 'bbb\n');
      setMtime(file, second);
      setMtime(path.join(repo, '.git', 'index'), second);
      expect(git(sandbox, repo, 'diff', '--name-only', 'HEAD')).toBe('f');

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
      expect(run.stderr).not.toContain('no changes in this range');
    });

    it('runs every git call with optional locks off and prompts disabled', () => {
      const sandbox = createSandbox({logGitEnv: true});
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'b.txt'), 'two changed\n');

      for (const args of [[repo], [repo, 'feat', 'main']]) {
        fs.rmSync(sandbox.gitEnvLog, {force: true});
        const run = runScript(sandbox, shell, args);
        expect(run.status, run.stderr).toBe(0);
        const calls = fs.readFileSync(sandbox.gitEnvLog, 'utf8').split('\n').filter(Boolean);
        expect(calls.length).toBeGreaterThan(3);
        expect(new Set(calls)).toEqual(new Set(['0 0']));
      }
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

    it('still prints and copies the command when TMPDIR is unusable', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
      const missing = path.join(sandbox.root, 'no-such-dir');
      sandbox.env.TMPDIR = missing;

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.command).toBe(`cd '${repo}' && branch-review`);
      expect(fs.readFileSync(sandbox.clipOut, 'utf8')).toBe(run.command);
      expect(report(run.stderr, 'in review')).toBe('unknown (tracked count unknown, 1 untracked)');
      expect(run.stderr).toContain('warning: cannot copy the index to a temp file');
      expect(run.stderr).not.toContain('no changes in this range');
      expect(fs.existsSync(missing)).toBe(false);
    });

    it('leaves an untracked nested repo out of the count, as the CLI does', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const nested = path.join(repo, 'nested');
      fs.mkdirSync(nested);
      git(sandbox, nested, 'init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(nested, 'inside.txt'), 'inside\n');
      fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n');
      expect(git(sandbox, repo, 'ls-files', '--others', '--exclude-standard').split('\n')).toEqual(['nested/', 'new.txt']);

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('2 files (1 tracked, 1 untracked)');
    });

    it('counts a rename as one file even with diff.renames=false', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      git(sandbox, repo, 'config', 'diff.renames', 'false');
      git(sandbox, repo, 'mv', 'b.txt', 'renamed.txt');

      const head = runScript(sandbox, shell, [repo]);
      expect(head.status, head.stderr).toBe(0);
      expect(report(head.stderr, 'in review')).toBe('2 files (2 tracked, 0 untracked)');

      git(sandbox, repo, 'commit', '-q', '-m', 'rename');
      const branch = runScript(sandbox, shell, [repo, 'feat', 'main']);
      expect(branch.status, branch.stderr).toBe(0);
      expect(report(branch.stderr, 'in review')).toBe('2 files (2 tracked, 0 untracked)');
    });

    it('counts a file whose name holds a newline once', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'two\nlines.txt'), 'tracked\n');
      git(sandbox, repo, 'add', '.');
      git(sandbox, repo, 'commit', '-q', '-m', 'odd name');
      fs.writeFileSync(path.join(repo, 'new\nline.txt'), 'untracked\n');

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('3 files (2 tracked, 1 untracked)');
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

    it('refuses a named-branch review with no merge base', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      git(sandbox, repo, 'checkout', '-q', '--orphan', 'lonely');
      git(sandbox, repo, 'commit', '-q', '-m', 'unrelated history');

      for (const args of [[repo, 'lonely', 'main'], [repo]]) {
        const run = runScript(sandbox, shell, args);
        expect(run.status, run.stderr).toBe(1);
        expect(run.stdout).toBe('');
        expect(run.stderr).toMatch(/error: no merge base for main and (lonely|HEAD)/);
        expect(run.stderr).not.toContain('no changes in this range');
        expect(fs.existsSync(sandbox.clipOut)).toBe(false);
      }
    });

    it('reports a count as unknown when the git call behind it fails', {timeout: 60_000}, () => {
      const sandbox = createSandbox({wrapGit: true});
      const repo = createRepo(sandbox);
      const cases: Array<{fail: string; args: string[]; label: string; expected: string}> = [
        {fail: 'diff', args: [repo], label: 'in review', expected: 'unknown (tracked count unknown, 0 untracked)'},
        {
          fail: 'diff',
          args: [repo, 'feat', 'main'],
          label: 'in review',
          expected: 'unknown (tracked count unknown, 0 untracked)',
        },
        {fail: 'ls-files', args: [repo], label: 'in review', expected: 'unknown (1 tracked, untracked count unknown)'},
        {fail: 'status', args: [repo], label: 'uncommitted', expected: 'unknown (git status failed)'},
        {fail: 'rev-list', args: [repo], label: 'commits', expected: 'unknown (git rev-list failed)'},
      ];

      for (const {fail, args, label, expected} of cases) {
        sandbox.env.FAIL_GIT = fail;
        const run = runScript(sandbox, shell, args);
        expect(run.status, run.stderr).toBe(0);
        expect(report(run.stderr, label), `${fail} ${args.length}`).toBe(expected);
        expect(run.stderr).not.toContain('no changes in this range');
        if (fail === 'diff') expect(run.stderr).toContain('warning: git diff failed, so the tracked count is unknown');
        expect(fs.readFileSync(sandbox.clipOut, 'utf8')).toBe(run.command);
      }
    });

    it('makes a relative TMPDIR absolute before git reads the index copy', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const relative = path.join(sandbox.root, 'reltmp');
      fs.mkdirSync(relative);
      sandbox.env.TMPDIR = 'reltmp';

      const run = runScript(sandbox, shell, [repo], sandbox.root);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
      expect(fs.readdirSync(relative)).toEqual([]);
    });

    it('keeps the private index copy unreadable by other users', () => {
      const sandbox = createSandbox({wrapGit: true});
      const repo = createRepo(sandbox);
      fs.writeFileSync(path.join(repo, 'b.txt'), 'two changed\n');
      // A repo index readable by everyone, as git writes it under umask 022.
      fs.chmodSync(path.join(repo, '.git', 'index'), 0o644);
      const log = path.join(sandbox.root, 'index-mode.log');
      sandbox.env.INDEX_MODE_LOG = log;

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('2 files (2 tracked, 0 untracked)');
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines.length % 2).toBe(0);
      for (let i = 0; i + 1 < lines.length; i += 2) {
        const [fileLine, dirLine] = [lines[i], lines[i + 1]];
        expect(fileLine.startsWith('-'), fileLine).toBe(true);
        expect(dirLine.startsWith('d'), dirLine).toBe(true);
        expect(readableByOthers(fileLine, dirLine), `${fileLine}\n${dirLine}`).toBe(false);
      }
      expect(fs.readdirSync(sandbox.tmp)).toEqual([]);
    });

    it('names the step that failed when git cannot locate the index', () => {
      const sandbox = createSandbox({wrapGit: true});
      const repo = createRepo(sandbox);
      sandbox.env.FAIL_GIT = '--git-path';

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'in review')).toBe('unknown (tracked count unknown, 0 untracked)');
      expect(run.stderr).toContain(
        'warning: cannot locate the index (git rev-parse --git-path index failed), so the tracked count is unknown',
      );
      expect(run.stderr).not.toContain(sandbox.tmp);
      expect(fs.readdirSync(sandbox.tmp)).toEqual([]);
    });

    it.skipIf(process.getuid?.() === 0)('names the index, not TMPDIR, when the index cannot be copied', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      const index = path.join(repo, '.git', 'index');
      fs.chmodSync(index, 0o000);
      try {
        const run = runScript(sandbox, shell, [repo]);
        expect(run.status, run.stderr).toBe(0);
        expect(report(run.stderr, 'in review')).toMatch(/^unknown \(tracked count unknown, /);
        expect(run.stderr).toContain('warning: cannot copy the index: cp: ');
        expect(run.stderr).toContain(index);
        expect(run.stderr).not.toContain('to a temp file');
        expect(run.stderr).not.toContain(sandbox.tmp);
        expect(fs.readdirSync(sandbox.tmp)).toEqual([]);
      } finally {
        fs.chmodSync(index, 0o644);
      }
    });
  });

  describe('hidden characters', () => {
    // An empty repo is enough: the script must refuse before it looks for a base.
    function emptyRepo(sandbox: Sandbox, name: string) {
      const dir = path.join(sandbox.root, name);
      fs.mkdirSync(dir);
      git(sandbox, dir, 'init', '-q', '-b', 'main');
      return fs.realpathSync(dir);
    }

    it('refuses a repo path holding a paste-ending escape and copies nothing', () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox, path.join(sandbox.root, 'evil\x1b[201~\x15\nname', 'app'));

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(1);
      expect(run.stdout).toBe('');
      expect(fs.existsSync(sandbox.clipOut)).toBe(false);
      const lines = stderrLines(run.stderr);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^error: repo path contains control or invisible characters/);
      expect(lines[0]).toContain('evil\\x1b[201~\\x15\\x0aname/app');
    });

    const hidden: Array<[string, string]> = [
      ['tab\tname', 'tab\\x09name'],
      ['del\x7fname', 'del\\x7fname'],
      ['c1\u009bname', 'c1\\u009bname'],
      ['nel\u0085name', 'nel\\u0085name'],
      ['shy\u00adname', 'shy\\u00adname'],
      ['alm\u061cname', 'alm\\u061cname'],
      ['zwsp\u200bname', 'zwsp\\u200bname'],
      ['lrm\u200ename', 'lrm\\u200ename'],
      ['ls\u2028name', 'ls\\u2028name'],
      ['rlo\u202ename', 'rlo\\u202ename'],
      ['wj\u2060name', 'wj\\u2060name'],
      ['lri\u2066name', 'lri\\u2066name'],
      ['pdi\u2069name', 'pdi\\u2069name'],
      ['bom\ufeffname', 'bom\\ufeffname'],
      ['tag\u{e0001}name', 'tag\\U000e0001name'],
      ['tag\u{e007f}name', 'tag\\U000e007fname'],
      ['trailing-newline\n', 'trailing-newline\\x0a'],
    ];

    it('refuses every kind of hidden character in the repo path', {timeout: 60_000}, () => {
      const sandbox = createSandbox();
      for (const [name, escaped] of hidden) {
        const repo = emptyRepo(sandbox, name);
        const run = runScript(sandbox, shell, [repo]);
        expect(run.status, JSON.stringify(name)).toBe(1);
        expect(run.stdout).toBe('');
        const lines = stderrLines(run.stderr);
        expect(lines, JSON.stringify(name)).toHaveLength(1);
        expect(lines[0]).toContain('repo path contains control or invisible characters');
        expect(lines[0]).toContain(`${sandbox.root}/${escaped}`);
      }
      expect(fs.existsSync(sandbox.clipOut)).toBe(false);
    });

    it('refuses hidden characters in the branch and base arguments', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      git(sandbox, repo, 'branch', 'feat\u202erev', 'feat');
      git(sandbox, repo, 'branch', 'ma\u0085in', 'main');
      const cases: Array<{args: string[]; label: string; escaped: string}> = [
        {args: [repo, 'feat\u202erev', 'main'], label: 'branch', escaped: 'feat\\u202erev'},
        {args: [repo, 'feat', 'ma\u0085in'], label: 'base', escaped: 'ma\\u0085in'},
        {args: [repo, 'x\x1b[201~y'], label: 'branch', escaped: 'x\\x1b[201~y'},
        {args: [repo, 'HEAD', 'ma\nin'], label: 'base', escaped: 'ma\\x0ain'},
      ];

      for (const {args, label, escaped} of cases) {
        const run = runScript(sandbox, shell, args);
        expect(run.status, run.stderr).toBe(1);
        expect(run.stdout).toBe('');
        const lines = stderrLines(run.stderr);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`${label} contains control or invisible characters`);
        expect(lines[0]).toContain(escaped);
      }
      expect(fs.existsSync(sandbox.clipOut)).toBe(false);
    });

    it('escapes hidden characters in every line it prints', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox);
      // Git refuses C0 and DEL in ref names but allows bidi controls.
      git(sandbox, repo, 'checkout', '-q', '-b', 'topic\u202eevil');
      git(sandbox, repo, 'branch', 'ma\u2066in', 'main');
      git(sandbox, repo, 'update-ref', 'refs/remotes/origin/ma\u2066in', 'main');
      git(sandbox, repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/ma\u2066in');

      const run = runScript(sandbox, shell, [repo]);
      expect(run.status, run.stderr).toBe(0);
      stderrLines(run.stderr);
      expect(report(run.stderr, 'branch')).toBe('topic\\u202eevil  (reviewing: HEAD)');
      expect(report(run.stderr, 'base')).toBe('origin/ma\\u2066in (auto-detected)');
      expect(run.command).toBe(`cd '${repo}' && branch-review`);

      const missing = runScript(sandbox, shell, [path.join(repo, 'gone\x1b]0;title\x07')]);
      expect(missing.status).toBe(1);
      expect(stderrLines(missing.stderr)).toEqual([`error: path does not exist: ${repo}/gone\\x1b]0;title\\x07`]);
    });

    it('accepts visible non-ASCII in the repo path and ref names', {timeout: 30_000}, () => {
      const sandbox = createSandbox();
      const repo = createRepo(sandbox, path.join(sandbox.root, 'café 日本 😀 a\u00a0b — ü', 'app'));
      git(sandbox, repo, 'branch', 'feat-ü—😀', 'feat');

      const run = runScript(sandbox, shell, [repo, 'feat-ü—😀', 'main']);
      expect(run.status, run.stderr).toBe(0);
      expect(report(run.stderr, 'repo')).toBe(repo);
      expect(report(run.stderr, 'in review')).toBe('1 files (1 tracked, 0 untracked)');
      for (const pasteShell of pasteShells(shell)) {
        expect(paste(sandbox, pasteShell, run.command)).toEqual({cwd: repo, argv: ['feat-ü—😀', 'main']});
      }
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

  it('says which shells the command is for and that hidden characters are refused', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../README.md'), 'utf8');
    for (const doc of [fs.readFileSync(skillDocPath, 'utf8'), readme]) {
      expect(doc).toContain('POSIX shells and zsh');
      expect(doc.replace(/\s+/g, ' ')).toMatch(/refuses .*repo path or ref name that holds control or invisible characters/);
    }
  });

  it('names every quit key wherever it says how the UI exits', () => {
    const paragraphs = fs.readFileSync(skillDocPath, 'utf8').split(/\n\s*\n/);
    const quitting = paragraphs.filter((paragraph) => /`q`/.test(paragraph));
    expect(quitting.length).toBeGreaterThan(0);
    for (const paragraph of quitting) {
      expect(paragraph).toContain('`Esc`');
      expect(paragraph).toContain('Ctrl-C');
    }
  });
});
