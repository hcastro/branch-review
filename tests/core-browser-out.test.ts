import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {browserPagesDir, browserPagesParent} from '../src/rendered/browserOut.js';
import {runCli} from '../src/startup.js';
import {cleanupTempDirs, initRepo, makeTempDir, writeExecutable, writeFiles} from './core-helpers.js';

// `--browser`: the review page opens straight in the browser, the terminal
// UI never mounts, and the page stays on disk after the run exits.
vi.setConfig({testTimeout: 60_000});

afterEach(cleanupTempDirs);

class FakeProcess extends EventEmitter {
  exits: number[] = [];
  exit = (code?: number) => {
    this.exits.push(code ?? 0);
    this.emit('exit', code ?? 0);
  };
}

// The run's output and what it asked the opener to open. A fake xdg-open on
// PATH stands in for Linux's opener: it is found, never run.
async function runBrowser(cwd: string, {env = {}, argv = ['HEAD', 'main', '--browser']}: {env?: NodeJS.ProcessEnv; argv?: string[]} = {}) {
  const parent = env.BRANCH_REVIEW_TMPDIR ?? makeTempDir('branch-review-browser-parent-');
  const bin = makeTempDir('branch-review-fake-opener-');
  writeExecutable(path.join(bin, 'xdg-open'), '#!/bin/sh\nexit 0\n');
  const proc = new FakeProcess();
  const opened: Array<[string, string[]]> = [];
  let stdout = '';
  let stderr = '';
  let mounted = false;
  await runCli({
    argv,
    cwd,
    proc,
    env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, CMUX_WORKSPACE_ID: undefined, SSH_CONNECTION: undefined, BRANCH_REVIEW_TMPDIR: parent, ...env},
    opener: (command, args) => opened.push([command, args]),
    stdout: {isTTY: true, columns: 120, write: (text: string, done?: () => void) => {
      stdout += text;
      done?.();
      return true;
    }},
    stderr: {write: (text: string) => {
      stderr += text;
      return true;
    }},
    render: () => {
      mounted = true;
      return {waitUntilExit: () => new Promise(() => {}), unmount: () => undefined};
    },
  });
  return {proc, opened, stdout, stderr, mounted, parent};
}

describe('branch-review --browser', () => {
  it('opens the review page in the browser with no UI, and keeps the page after the run', async () => {
    const cwd = initRepo({'README.md': '# Readme\n\nOne.\n'});
    writeFiles(cwd, {'README.md': '# Readme\n\nOne, edited.\n'});
    const run = await runBrowser(cwd);

    expect(run.mounted).toBe(false);
    expect(run.stderr).toBe('');
    expect(run.proc.exits).toEqual([0]);
    expect(run.opened).toHaveLength(1);
    const [command, args] = run.opened[0]!;
    expect([path.basename(command), args.length]).toEqual([process.platform === 'darwin' ? 'open' : 'xdg-open', 1]);
    const page = fileURLToPath(args[0]!);
    expect(path.dirname(path.dirname(page))).toBe(browserPagesParent({BRANCH_REVIEW_TMPDIR: fs.realpathSync(run.parent)}));
    if (process.getuid) expect(path.basename(path.dirname(path.dirname(page)))).toBe(`branch-review-pages-${process.getuid()}`);
    expect(run.stdout).toBe(`⇗ 1 file opened in your browser\n  ${page}\n`);
    // The exit hooks ran, and the page is still there to read.
    expect(fs.readFileSync(page, 'utf8')).toContain('One<span class="x">, edited</span>.');
    if (process.getuid) expect(fs.statSync(path.dirname(path.dirname(page))).mode & 0o777).toBe(0o700);

    // The same review again: the same folder, with the newest page in it.
    writeFiles(cwd, {'README.md': '# Readme\n\nOne, edited twice.\n'});
    const again = await runBrowser(cwd, {env: {BRANCH_REVIEW_TMPDIR: run.parent}});
    expect(fileURLToPath(again.opened[0]![1][0]!)).toBe(page);
    expect(fs.readFileSync(page, 'utf8')).toContain('edited twice');
  });

  it('builds nothing over SSH, and says how to get the page instead', async () => {
    const cwd = initRepo({'README.md': '# Readme\n'});
    writeFiles(cwd, {'README.md': '# Readme, edited\n'});
    const run = await runBrowser(cwd, {env: {SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}});
    expect(run.proc.exits).toEqual([1]);
    expect(run.stderr).toBe("branch-review: open isn't available over SSH · branch-review --export-html <dir> writes the pages\n");
    expect(run.opened).toEqual([]);
    expect(fs.readdirSync(run.parent)).toEqual([]);
  });

  it('opens the browser when cmux is slow, and kills that cmux before exiting, so no split opens late', async () => {
    const cwd = initRepo({'README.md': '# Readme\n'});
    writeFiles(cwd, {'README.md': '# Readme, edited\n'});
    const bin = makeTempDir('branch-review-slow-cmux-');
    const late = path.join(bin, 'late');
    writeExecutable(path.join(bin, 'xdg-open'), '#!/bin/sh\nexit 0\n');
    writeExecutable(path.join(bin, 'cmux'), `#!/bin/sh\nsleep 3\ntouch '${late}'\necho '{"surface_ref":"surface:2"}'\n`);
    const run = await runBrowser(cwd, {env: {CMUX_WORKSPACE_ID: 'workspace:test', PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}});
    expect(run.proc.exits).toEqual([0]);
    expect(run.stdout).toMatch(/^⇗ 1 file opened in your browser · cmux didn't answer\n/);
    expect(run.opened).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    expect(fs.existsSync(late)).toBe(false);
  });

  it('opens nothing when nothing changed', async () => {
    const cwd = initRepo({'README.md': '# Readme\n'});
    const run = await runBrowser(cwd);
    expect(run.proc.exits).toEqual([0]);
    expect(run.stdout).toBe('No file changes between main and HEAD.\n');
    expect(run.opened).toEqual([]);
    expect(run.mounted).toBe(false);
  });

  it('keeps one folder per repo and range', () => {
    const range = {base: 'main', branch: 'HEAD', diffArg: 'main...HEAD', includeWorktree: true};
    const env = {BRANCH_REVIEW_TMPDIR: '/tmp/parent'};
    const dir = browserPagesDir(env, '/repo/a', range);
    expect(path.dirname(dir)).toBe(browserPagesParent(env));
    expect(path.dirname(path.dirname(dir))).toBe('/tmp/parent');
    expect(browserPagesDir(env, '/repo/a', range)).toBe(dir);
    expect(browserPagesDir(env, '/repo/b', range)).not.toBe(dir);
    expect(browserPagesDir(env, '/repo/a', {...range, base: 'development'})).not.toBe(dir);
  });
});
