import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {createWatchIgnoreMatcher, listIgnoredPaths} from '../src/watch/repoWatcher.js';
import {formatRefreshError} from '../src/ui/ReviewController.js';

const tempDirs: string[] = [];

function runGit(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-c', 'user.name=Test User', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function writeFile(root: string, relativePath: string, text: string) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), {recursive: true});
  fs.writeFileSync(filePath, text);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('watch ignore matcher', () => {
  it('skips .git and what git ignores, and watches everything git tracks', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-review-ignore-'));
    tempDirs.push(cwd);
    runGit(cwd, 'init', '-q', '-b', 'main');
    writeFile(cwd, '.gitignore', 'dist/\nnode_modules\n');
    writeFile(cwd, 'src/cli.tsx', 'cli\n');
    writeFile(cwd, 'packages/app/lib/source.ts', 'source\n');
    writeFile(cwd, 'lib/index.js', 'lib\n');
    writeFile(cwd, 'dist/keep.js', 'tracked despite the ignore rule\n');
    runGit(cwd, 'add', '.');
    runGit(cwd, 'add', '-f', 'dist/keep.js');
    runGit(cwd, 'commit', '-q', '-m', 'initial');
    writeFile(cwd, 'dist/cli.js', 'build output\n');
    writeFile(cwd, 'node_modules/react/index.js', 'dependency\n');

    const matcher = createWatchIgnoreMatcher(cwd, listIgnoredPaths(cwd));

    expect(matcher.isIgnored(path.join(cwd, '.git', 'index'))).toBe(true);
    expect(matcher.isIgnored(path.join(cwd, 'node_modules', 'react', 'index.js'))).toBe(true);
    expect(matcher.isIgnored(path.join(cwd, 'dist', 'cli.js'))).toBe(true);
    expect(matcher.isIgnored(path.join(cwd, 'src', 'cli.tsx'))).toBe(false);
    expect(matcher.isIgnored(path.join(cwd, 'packages', 'app', 'lib', 'source.ts'))).toBe(false);
    expect(matcher.isIgnored(path.join(cwd, 'lib', 'index.js'))).toBe(false);
    expect(matcher.isIgnored(path.join(cwd, 'dist', 'keep.js'))).toBe(false);
    expect(matcher.isIgnored(cwd)).toBe(false);
  });
});

describe('formatRefreshError', () => {
  it('prefers the fatal or error line from stderr', () => {
    const error = Object.assign(new Error('Command failed: git merge-base main HEAD'), {
      stderr: 'warning: something minor\nfatal: Not a valid object name main\n',
    });

    expect(formatRefreshError(error)).toBe('fatal: Not a valid object name main');
  });

  it('finds the reason in the message of a failed git call', () => {
    let error: unknown;
    try {
      execFileSync('git', ['rev-parse', '--verify', 'no-such-ref'], {cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe']});
    } catch (caught) {
      error = caught;
    }

    expect(formatRefreshError(Object.assign(error as Error, {stderr: undefined}))).toMatch(/^fatal: /);
  });

  it('falls back to the first line of other errors', () => {
    expect(formatRefreshError(new Error('Base ref not found: main\nmore'))).toBe('Base ref not found: main');
    expect(formatRefreshError('nope')).toBe('unknown error');
  });
});
