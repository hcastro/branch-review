import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const tempDirs: string[] = [];

export function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function makeTempDir(prefix = 'branch-review-core-') {
  // realpath so comparisons with `git rev-parse --show-toplevel` hold on macOS,
  // where the temp dir sits behind the /var -> /private/var symlink.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export function cleanupTempDirs() {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

export function initRepo(files: Record<string, string> = {}, branch = 'main') {
  const cwd = makeTempDir('branch-review-repo-');
  git(cwd, 'init', '-q', '-b', branch);
  git(cwd, 'config', 'user.name', 'Test User');
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'commit.gpgsign', 'false');
  writeFiles(cwd, files);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'initial');
  return cwd;
}

export function writeFiles(cwd: string, files: Record<string, string>) {
  for (const [filePath, contents] of Object.entries(files)) {
    const absolute = path.join(cwd, filePath);
    fs.mkdirSync(path.dirname(absolute), {recursive: true});
    fs.writeFileSync(absolute, contents);
  }
}

export function commitAll(cwd: string, message: string) {
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
}

export function hashFile(filePath: string) {
  return createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

export function writeExecutable(filePath: string, contents: string) {
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

// A PATH directory that exposes only the named tools, each linked to the real
// binary found on the current PATH.
export function pathWithOnly(tools: string[]) {
  const dir = makeTempDir('branch-review-bin-');
  for (const tool of tools) {
    const resolved = execFileSync('/usr/bin/which', [tool], {encoding: 'utf8'}).trim();
    fs.symlinkSync(resolved, path.join(dir, tool));
  }
  return dir;
}

export function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export type GitSpyCall = {optionalLocks: string; terminalPrompt: string; indexFile: string; args: string};

// A PATH directory whose `git` logs the environment each call received, then
// runs the real git. Prepend it to PATH and read the calls back with `calls()`.
export function gitSpy() {
  const dir = makeTempDir('branch-review-gitspy-');
  const log = path.join(dir, 'calls.log');
  const realGit = execFileSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).trim();
  writeExecutable(path.join(dir, 'git'), [
    '#!/bin/sh',
    `printf '%s\\t%s\\t%s\\t%s\\n' "\${GIT_OPTIONAL_LOCKS-unset}" "\${GIT_TERMINAL_PROMPT-unset}" "\${GIT_INDEX_FILE-unset}" "$*" >> '${log}'`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));

  return {
    pathValue: `${dir}${path.delimiter}${process.env.PATH ?? ''}`,
    calls(): GitSpyCall[] {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => {
        const [optionalLocks = '', terminalPrompt = '', indexFile = '', args = ''] = line.split('\t');
        return {optionalLocks, terminalPrompt, indexFile, args};
      });
    },
  };
}

// Every file under `dir` with its content hash and mtime, keyed by relative path.
export function snapshotTree(dir: string) {
  const files = new Map<string, {hash: string; mtimeMs: number}>();
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        files.set(path.relative(dir, absolute), {hash: hashFile(absolute), mtimeMs: fs.statSync(absolute).mtimeMs});
      }
    }
  };
  walk(dir);
  return files;
}
