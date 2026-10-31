import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, snapshotTree, writeExecutable, writeFiles} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// Each test builds a real repo and runs the CLI in a child, git and delta
// included.
vi.setConfig({testTimeout: 60_000});

afterEach(cleanupTempDirs);

const cliEntry = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
const tsxLoader = new URL('../node_modules/tsx/dist/loader.mjs', import.meta.url).href;

// The child gets its own temp dir for everything branch-review writes there,
// so the test can check it is left empty. TMPDIR stays as it is unless a
// test asks for a fresh one: tsx keeps its compile cache there.
function runCli(cwd: string, args: string[], {osTmp, binDir}: {osTmp?: string; binDir?: string} = {}) {
  const tmp = makeTempDir('branch-review-render-tmp-');
  const result = spawnSync(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {
    cwd,
    env: {
      ...process.env,
      BRANCH_REVIEW_TMPDIR: tmp,
      ...(osTmp ? {TMPDIR: osTmp} : {}),
      ...(binDir ? {PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`} : {}),
    },
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {...result, tmp};
}

// The CLI with its stdout on a pipe that nobody reads for the first second,
// as when a slow consumer such as `jq` starts late.
function runCliIntoSlowPipe(cwd: string, args: string[]): Promise<{status: number | null; stdout: string; stderr: string}> {
  const child = spawn(process.execPath, ['--import', tsxLoader, cliEntry, ...args], {cwd, env: {...process.env, BRANCH_REVIEW_TMPDIR: makeTempDir('branch-review-render-tmp-')}});
  child.stdout.pause();
  setTimeout(() => child.stdout.resume(), 1000);
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  return new Promise((resolve) => {
    child.on('close', (status) => resolve({status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8')}));
  });
}

// A `delta` that runs `before` in the shell first and then hands its input
// to the real delta, so a test can fail one file's terminal diff or change a
// file after the review read its diff.
function wrappedDelta(before: string) {
  const bin = makeTempDir('branch-review-delta-');
  const realDelta = spawnSync('/usr/bin/which', ['delta'], {encoding: 'utf8'}).stdout.trim();
  writeExecutable(path.join(bin, 'delta'), ['#!/bin/sh', before, `exec '${realDelta}' "$@"`, ''].join('\n'));
  return bin;
}

// Every character controlChars.ts keeps off the terminal, as a test sees it.
const HIDDEN = /[\u007F-\u009F\u00AD\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

type Report = {
  version: number;
  base: string;
  branch: string;
  dir: string;
  pages: Array<{
    path: string;
    status: string;
    file: string;
    state: string;
    changes: {changed: number; removed: number};
    differences: Array<{kind: string; count: number}>;
    reason?: string;
  }>;
};

// A branch that touches every kind of markdown change the report knows:
// modified, added, deleted and renamed, plus files that aren't markdown.
function featureRepo() {
  const repo = initRepo({
    'README.md': '# Project\n\nSee the [guide](docs/guide.md) and the [code](src/app.ts).\n',
    'docs/guide.md': '# Guide\n\nStep one.\n\nStep two.\n\nGone soon.\n\nStep three.\n',
    'docs/old.md': '# Old\n\nRetired.\n',
    'docs/moved.md': '# Moved\n\nSame text.\n',
    'src/app.ts': 'export const a = 1;\n',
  });
  git(repo, 'checkout', '-q', '-b', 'feature');
  writeFiles(repo, {
    'docs/guide.md': '# Guide\n\nStep one, edited.\n\nStep two.\n\nStep three.\n',
    'docs/new.md': '# New\n\n> [!TIP]\n> Fresh.\n\n![badge](https://img.shields.io/badge/x-y-green)\n',
    'src/app.ts': 'export const a = 2;\n',
  });
  fs.rmSync(path.join(repo, 'docs/old.md'));
  git(repo, 'mv', 'docs/moved.md', 'docs/renamed.md');
  commitAll(repo, 'feature work');
  return repo;
}

describe('startup cost', () => {
  it('loads the renderer only for --render-out, so the UI starts without it', () => {
    const startup = fs.readFileSync(fileURLToPath(new URL('../src/startup.ts', import.meta.url)), 'utf8');
    expect(startup).not.toMatch(/^import .* from '\.\/rendered\//m);
    expect(startup).toContain("await import('./rendered/renderOut.js')");
  });
});

describe('--render-out', () => {
  it('writes one page per markdown file and prints a JSON report of them', () => {
    const repo = featureRepo();
    const out = path.join(makeTempDir('branch-review-out-'), 'pages');
    const result = runCli(repo, ['feature', 'main', '--render-out', out, '--json']);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report).toMatchObject({version: 1, base: 'main', branch: 'feature', dir: out});
    expect(report.pages.map((page) => [page.path, page.status, page.state])).toEqual([
      ['docs/guide.md', 'modified', 'rendered'],
      ['docs/new.md', 'added', 'rendered'],
      ['docs/old.md', 'deleted', 'rendered'],
      ['docs/renamed.md', 'renamed', 'rendered'],
    ]);
    const guide = report.pages[0]!;
    expect(guide.changes).toEqual({changed: 1, removed: 1});
    expect(report.pages[1]!.differences).toEqual([{kind: 'remoteImage', count: 1}]);

    // Content-addressed names, never repo text, and nothing else in the dir.
    const files = fs.readdirSync(out).sort();
    expect(files).toEqual(report.pages.map((page) => page.file).sort());
    for (const file of files) expect(file).toMatch(/^[0-9a-f]{20}\.html$/);

    const guideHtml = fs.readFileSync(path.join(out, guide.file), 'utf8');
    expect(guideHtml).toMatch(/^<!doctype html>\n<html lang="en">\n<head>\n<meta http-equiv="Content-Security-Policy"/);
    expect(guideHtml).toContain('data-mark="modified"');
    expect(guideHtml).toContain('− 1 paragraph removed · show');
    // The rail links every page by its relative file name.
    for (const page of report.pages) expect(guideHtml).toContain(`href="${page.file}"`);
    expect(fs.readFileSync(path.join(out, report.pages[2]!.file), 'utf8')).toContain('deleted on this branch · shown from main');
    expect(fs.readFileSync(path.join(out, report.pages[3]!.file), 'utf8')).toContain('renamed from docs/moved.md');
  });

  it('links pages to each other and leaves links to files outside the review inert', () => {
    const repo = initRepo({'README.md': '# Readme\n', 'docs/a.md': '# A\n', 'src/app.ts': 'x\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {
      'README.md': '# Readme\n\nRead [A](docs/a.md#a), [the app](src/app.ts) and [gone](docs/missing.md).\n',
      'docs/a.md': '# A\n\nBack to the [readme](../README.md).\n',
    });
    commitAll(repo, 'links');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const file = (repoPath: string) => report.pages.find((page) => page.path === repoPath)!.file;
    const readme = fs.readFileSync(path.join(out, file('README.md')), 'utf8');
    expect(readme).toContain(`<a href="${file('docs/a.md')}#user-content-a">A</a>`);
    expect(readme).toContain('<a class="br-inert" title="not part of this review">the app</a>');
    expect(readme).toContain('<a class="br-inert" title="not part of this review">gone</a>');
    expect(fs.readFileSync(path.join(out, file('docs/a.md')), 'utf8')).toContain(`<a href="${file('README.md')}">readme</a>`);
  });

  it('renders the work tree for HEAD, untracked markdown included, and writes nothing outside the out dir', () => {
    const repo = initRepo({'README.md': '# Readme\n\nOld line.\n'});
    writeFiles(repo, {'README.md': '# Readme\n\nNew line.\n', 'notes/draft.md': '# Draft\n\nNot added yet.\n'});
    // git status refreshes the index's stat cache, so it runs before the
    // snapshot, and the comparison after it reads the snapshot first.
    const status = git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
    const before = snapshotTree(repo);
    const out = makeTempDir('branch-review-out-');

    const result = runCli(path.join(repo, 'notes'), ['HEAD', 'main', '--render-out', out, '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.branch).toBe('HEAD + worktree');
    // In the review's own order, which sorts by locale.
    expect(report.pages.map((page) => [page.path, page.status])).toEqual([['notes/draft.md', 'untracked'], ['README.md', 'modified']]);
    expect(fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8')).toContain('untracked · not part of a push yet');

    // The repo, its index and the child's temp dir are as they were.
    expect(snapshotTree(repo)).toEqual(before);
    expect(git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
    expect(fs.readdirSync(result.tmp)).toEqual([]);
  });

  it('resolves a relative out dir from where it was started, and can write over its own last run', () => {
    const repo = initRepo({'docs/a.md': '# A\n'});
    writeFiles(repo, {'docs/a.md': '# A\n\nMore.\n'});
    const work = makeTempDir('branch-review-work-');
    const first = runCli(work, ['--render-out', 'rendered']);
    expect(first.status).toBe(1);
    expect(first.stderr).toMatch(/^branch-review: not a git repository/);

    const inRepo = runCli(path.join(repo, 'docs'), ['--render-out', 'rendered', '--json']);
    expect(inRepo.status).toBe(0);
    const report = JSON.parse(inRepo.stdout) as Report;
    expect(report.dir).toBe(path.join(repo, 'docs', 'rendered'));
    const again = runCli(path.join(repo, 'docs'), ['--render-out', 'rendered', '--json']);
    expect(again.status).toBe(0);
    expect(fs.readdirSync(path.join(repo, 'docs', 'rendered'))).toEqual([report.pages[0]!.file]);
  });

  it('prints a short summary without --json, with paths as given', () => {
    const repo = featureRepo();
    const result = runCli(repo, ['feature', 'main', '--render-out', 'out']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('Rendered 4 pages to out/ · nothing left this machine');
    expect(lines.slice(1).map((line) => line.replace(/[0-9a-f]{20}/, 'KEY'))).toEqual([
      '  M docs/guide.md     out/KEY.html  1 changed · 1 removed',
      '  A docs/new.md       out/KEY.html  new file · 1 difference',
      '  D docs/old.md       out/KEY.html  deleted',
      '  R docs/renamed.md   out/KEY.html  renamed',
    ]);
    // No terminal codes: the output is for logs and agents.
    expect(result.stdout).not.toContain('\u001B');
  });

  it('says there is nothing to render when no markdown changed', () => {
    const repo = initRepo({'a.ts': 'x\n'});
    writeFiles(repo, {'a.ts': 'y\n'});
    const out = makeTempDir('branch-review-out-');
    const text = runCli(repo, ['HEAD', 'main', '--render-out', out]);
    expect(text.status).toBe(0);
    expect(text.stdout).toBe('nothing to render · no markdown files on this branch\n');
    const json = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json']);
    expect(json.status).toBe(0);
    expect((JSON.parse(json.stdout) as Report).pages).toEqual([]);
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('shows a card, not a failure, for an empty, oversized or non-UTF-8 file', () => {
    const repo = initRepo({'empty.md': 'x\n', 'big.md': 'x\n', 'latin.md': 'x\n'});
    fs.writeFileSync(path.join(repo, 'empty.md'), '');
    fs.writeFileSync(path.join(repo, 'big.md'), `# Big\n\n${'word '.repeat(450_000)}\n`);
    fs.writeFileSync(path.join(repo, 'latin.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.state])).toEqual([['big.md', 'tooLarge'], ['empty.md', 'empty'], ['latin.md', 'notUtf8']]);
    const big = fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8');
    expect(big).toContain('too large to render (2.1 MB)');
    expect(big).toContain('<pre class="br-raw"># Big');
    for (const page of report.pages) {
      expect(fs.readFileSync(path.join(out, page.file), 'utf8')).not.toMatch(/\/Users\/|\/home\/|\n {4}at /);
    }
  });

  it('fails with one line when the out dir can\'t be written', () => {
    const repo = initRepo({'a.md': '# A\n'});
    writeFiles(repo, {'a.md': '# A\n\nB.\n'});
    const parent = makeTempDir('branch-review-out-');
    fs.writeFileSync(path.join(parent, 'taken'), 'a file, not a dir');
    const result = runCli(repo, ['HEAD', 'main', '--render-out', path.join(parent, 'taken')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^branch-review: can't write the pages to .*taken: not a directory\n$/);
  });

  it('refuses a missing directory and a lone --json with a usage line', () => {
    const repo = initRepo({'a.md': '# A\n'});
    const missing = runCli(repo, ['--render-out']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe('branch-review: --render-out needs a directory, for example --render-out ./rendered\n');
    const lone = runCli(repo, ['--json']);
    expect(lone.status).toBe(1);
    expect(lone.stderr).toBe('branch-review: --json works only with --render-out\n');
  });

  it('writes the whole report into a pipe that is read late, past the pipe\'s 64 KiB buffer', async () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    // Long paths keep the file count, and the run, small.
    const dir = Array.from({length: 5}, (_, level) => `folder-${level}-${'x'.repeat(160)}`).join('/');
    const files: Record<string, string> = {};
    for (let index = 0; index < 75; index += 1) files[`${dir}/page-${String(index).padStart(3, '0')}.md`] = `# Page ${index}\n`;
    writeFiles(repo, files);
    const out = makeTempDir('branch-review-out-');

    const json = await runCliIntoSlowPipe(repo, ['HEAD', 'main', '--render-out', out, '--json']);
    expect(json.stderr).toBe('');
    expect(json.status).toBe(0);
    expect(Buffer.byteLength(json.stdout)).toBeGreaterThan(64 * 1024);
    expect((JSON.parse(json.stdout) as Report).pages).toHaveLength(75);

    const text = await runCliIntoSlowPipe(repo, ['HEAD', 'main', '--render-out', out]);
    expect(text.status).toBe(0);
    const lines = text.stdout.trimEnd().split('\n');
    expect(Buffer.byteLength(text.stdout)).toBeGreaterThan(64 * 1024);
    expect(lines).toHaveLength(76);
    expect(lines.at(-1)).toContain('page-074.md');
    // Two runs over 75 files take a while on a loaded machine.
  }, 180_000);

  it('gives a file that keeps the renderer busy past its deadline a card, and renders the rest', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    // Emphasis markers the parser resolves in quadratic time: about a
    // minute of work, cut off at the deadline.
    writeFiles(repo, {'a-slow.md': `${'*a'.repeat(100_000)}\n`, 'b-fine.md': '# Fine\n'});
    const out = makeTempDir('branch-review-out-');
    const started = Date.now();
    const result = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.state, page.reason])).toEqual([
      ['a-slow.md', 'failed', 'took too long to render'],
      ['b-fine.md', 'rendered', undefined],
    ]);
    const slow = fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8');
    expect(slow).toContain("couldn't render this file · took too long to render");
    expect(slow).toContain('<pre class="br-raw">*a*a*a');
  });

  it('keeps hidden characters in repo paths off the terminal, in the JSON report and the summary', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    const name = 'evil\u009B31m‮DM\u001B[2J.md';
    writeFiles(repo, {[name]: '# Evil\n'});
    const out = makeTempDir('branch-review-out-');

    const json = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json']);
    expect(json.status).toBe(0);
    expect(json.stdout).not.toMatch(HIDDEN);
    expect(json.stdout).not.toContain('\u001B');
    expect(json.stdout).toContain('evil\\u009b31m\\u202eDM\\u001b[2J.md');
    expect((JSON.parse(json.stdout) as Report).pages.map((page) => page.path)).toEqual([name]);

    const text = runCli(repo, ['HEAD', 'main', '--render-out', out]);
    expect(text.status).toBe(0);
    expect(text.stdout).not.toMatch(HIDDEN);
    expect(text.stdout).not.toContain('\u001B');
    expect(text.stdout).toContain('evil<U+009B>31m<U+202E>DM␛[2J.md');
  });

  it('shows a file far over the render limit as too large, with its first text, in the work tree and at a ref', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {'committed.md': `# Committed\n\n${'word '.repeat(700_000)}\n`});
    commitAll(repo, 'big file');
    // Past the 16 MiB read limit the review uses for other files.
    writeFiles(repo, {'huge.md': `# Huge\n\n${'word '.repeat(3_600_000)}\n`});

    const worktree = runCli(repo, ['HEAD', 'main', '--render-out', makeTempDir('branch-review-out-'), '--json']);
    expect(worktree.status).toBe(0);
    const pages = (JSON.parse(worktree.stdout) as Report).pages;
    expect(pages.map((page) => [page.path, page.state])).toEqual([['committed.md', 'tooLarge'], ['huge.md', 'tooLarge']]);
    const huge = fs.readFileSync(path.join((JSON.parse(worktree.stdout) as Report).dir, pages[1]!.file), 'utf8');
    expect(huge).toContain('too large to render (17.2 MB)');
    expect(huge).toContain('<pre class="br-raw"># Huge');

    const atRef = runCli(repo, ['feature', 'main', '--render-out', makeTempDir('branch-review-out-'), '--json']);
    expect(atRef.status).toBe(0);
    const report = JSON.parse(atRef.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.state])).toEqual([['committed.md', 'tooLarge']]);
    const committed = fs.readFileSync(path.join(report.dir, report.pages[0]!.file), 'utf8');
    expect(committed).toContain('too large to render (3.3 MB)');
    expect(committed).toContain('<pre class="br-raw"># Committed');
  });

  it('leaves the OS temp dir as it was', () => {
    const repo = featureRepo();
    const osTmp = makeTempDir('branch-review-os-tmp-');
    const result = runCli(repo, ['feature', 'main', '--render-out', makeTempDir('branch-review-out-')], {osTmp});
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    // tsx, which runs the CLI from source here, keeps its compile cache there.
    expect(fs.readdirSync(osTmp).filter((entry) => !/^tsx-\d+$/.test(entry))).toEqual([]);
  });

  it('leaves a link to a file the branch deleted inert, as not found', () => {
    const repo = featureRepo();
    writeFiles(repo, {'docs/guide.md': '# Guide\n\nStep one, edited.\n\nSee the [old notes](old.md).\n\nStep three.\n'});
    commitAll(repo, 'link to the deleted file');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const guide = fs.readFileSync(path.join(out, report.pages.find((page) => page.path === 'docs/guide.md')!.file), 'utf8');
    expect(guide).toContain('<a class="br-inert" title="file not found">old notes</a>');
  });

  it('gives a renamed file the same cards as any other file, read no further than the render limit', () => {
    const repo = initRepo({'latin.md': 'x\n', 'big.md': 'x\n'});
    fs.writeFileSync(path.join(repo, 'latin.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    fs.writeFileSync(path.join(repo, 'big.md'), `# Big\n\n${'word '.repeat(450_000)}\n`);
    commitAll(repo, 'base');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'mv', 'latin.md', 'moved.md');
    git(repo, 'mv', 'big.md', 'bigger.md');
    commitAll(repo, 'renames');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.status, page.state, page.reason])).toEqual([
      ['bigger.md', 'renamed', 'tooLarge', undefined],
      ['moved.md', 'renamed', 'notUtf8', undefined],
    ]);
    expect(fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8')).toContain('too large to render (2.1 MB)');
  });

  it('marks only the edited block of a doc moved with its images', () => {
    const repo = initRepo({'docs/guide.md': '# Guide\n\nIntro.\n\n![Logo](logo.png)\n'});
    fs.writeFileSync(path.join(repo, 'docs/logo.png'), pngFixture(3, 2));
    commitAll(repo, 'logo');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'mv', 'docs', 'guide');
    writeFiles(repo, {'guide/guide.md': '# Guide\n\nIntro, edited.\n\n![Logo](logo.png)\n'});
    commitAll(repo, 'move the guide');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.status, page.changes])).toEqual([['guide/guide.md', 'renamed', {changed: 1, removed: 0}]]);
    expect(fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8')).not.toContain('file not found');
  });

  it('renders a markdown file whose terminal diff failed, and lists it', () => {
    const repo = initRepo({'a.md': '# A\n\nBREAKDELTA here.\n', 'b.md': '# B\n\nFine.\n'});
    writeFiles(repo, {'a.md': '# A\n\nBREAKDELTA here, edited.\n', 'b.md': '# B\n\nFine, edited.\n'});
    const binDir = wrappedDelta('input=$(cat); case "$input" in *BREAKDELTA*) echo "delta broke" >&2; exit 1;; esac; printf \'%s\\n\' "$input" |');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json'], {binDir});
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.state, page.changes])).toEqual([
      ['a.md', 'rendered', {changed: 1, removed: 0}],
      ['b.md', 'rendered', {changed: 1, removed: 0}],
    ]);
    expect(fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8')).toMatch(/<p [^>]*data-mark="modified">BREAKDELTA here, edited\./);

    const summary = runCli(repo, ['HEAD', 'main', '--render-out', out], {binDir});
    expect(summary.stdout).toMatch(/^ {2}M a\.md /m);
  });

  it('reads a link named after an object key as a link outside the review', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    writeFiles(repo, {'README.md': '# Readme\n\n[a](constructor), [b](toString), [c](__proto__) and [d](missing.md).\n'});
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const readme = fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8');
    for (const text of ['a', 'b', 'c', 'd']) expect(readme).toContain(`<a class="br-inert" title="not part of this review">${text}</a>`);
    expect(report.pages[0]!.differences).toEqual([{kind: 'outsideLink', count: 4}]);
  });

  it('marks a work tree file only when its text is the text the diff was read from', () => {
    const repo = initRepo({'.gitattributes': '*.md text\n', 'a.md': '# A\n\nOne.\n\nTwo.\n', 'b.md': '# B\n\nOne.\n'});
    // Line endings git converts on the way in still line up with the diff.
    fs.writeFileSync(path.join(repo, 'b.md'), '# B\r\n\r\nOne, edited.\r\n');
    writeFiles(repo, {'a.md': '# A\n\nOne, edited.\n\nTwo.\n'});
    // This delta rewrites a.md after the review read its diff, the way an
    // editor or an agent can while branch-review runs.
    const binDir = wrappedDelta(`printf '# A\\n\\nNew first.\\n\\nOne, edited.\\n\\nTwo.\\n' > '${path.join(repo, 'a.md')}'`);
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--render-out', out, '--json'], {binDir});
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.state, page.changes, page.reason])).toEqual([
      ['a.md', 'failed', {changed: 0, removed: 0}, "doesn't match the diff: changed since the review read it, or changed by a git filter"],
      ['b.md', 'rendered', {changed: 1, removed: 0}, undefined],
    ]);
    const page = fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8');
    expect(page).not.toMatch(/<[a-z]+ [^>]*data-mark=/);
    expect(page).toContain('<pre class="br-raw"># A\n\nNew first.');
  });

  it('inlines the images git tracks on each side, and shows a card for one GitHub won\'t show', () => {
    const red = pngFixture(2, 2, [200, 40, 40, 255]);
    const blue = pngFixture(3, 3, [40, 40, 200, 255]);
    const repo = initRepo({'README.md': '# Readme\n\n![Logo](img/logo.png) Old caption.\n'});
    fs.mkdirSync(path.join(repo, 'img'));
    fs.writeFileSync(path.join(repo, 'img/logo.png'), red);
    commitAll(repo, 'logo');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'img/logo.png'), blue);
    writeFiles(repo, {'README.md': '# Readme\n\n![Logo](img/logo.png) New caption.\n\n![Draft](notes/draft.png)\n'});
    commitAll(repo, 'new logo');
    writeFiles(repo, {'notes/draft.png': 'not committed'});
    const out = makeTempDir('branch-review-out-');

    const result = runCli(repo, ['feature', 'main', '--render-out', out, '--json']);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as Report;
    const html = fs.readFileSync(path.join(out, report.pages[0]!.file), 'utf8');
    const inlined = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
    // The page shows the branch's logo; its before view, the base's.
    expect(html).toContain(inlined(blue));
    expect(html).toMatch(new RegExp(`class="br-before-body">[\\s\\S]*${inlined(red).replace(/[+/]/g, '\\$&')}`));
    expect(html).toContain("won't render on GitHub: file is untracked · notes/draft.png");
    expect(report.pages[0]!.differences).toEqual([]);
  });

  it('renders from the published bundle, render thread included', () => {
    // The bundle loads the render thread from its own chunk, a path no
    // source run takes, so this builds it fresh next to the repo's packages.
    const root = fileURLToPath(new URL('..', import.meta.url));
    const build = makeTempDir('branch-review-bundle-');
    fs.symlinkSync(path.join(root, 'node_modules'), path.join(build, 'node_modules'));
    fs.copyFileSync(path.join(root, 'package.json'), path.join(build, 'package.json'));
    const tsup = spawnSync(path.join(root, 'node_modules/.bin/tsup'), ['--out-dir', path.join(build, 'dist'), '--silent'], {cwd: root, encoding: 'utf8', timeout: 60_000});
    expect(tsup.status, tsup.stderr).toBe(0);

    const repo = initRepo({'README.md': '# Readme\n'});
    writeFiles(repo, {'a-slow.md': `${'*a'.repeat(100_000)}\n`, 'b-fine.md': '# Fine\n\nText.\n'});
    const out = makeTempDir('branch-review-out-');
    const result = spawnSync(process.execPath, [path.join(build, 'dist/cli.js'), 'HEAD', 'main', '--render-out', out, '--json'], {
      cwd: repo,
      env: {...process.env, BRANCH_REVIEW_TMPDIR: makeTempDir('branch-review-render-tmp-')},
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.pages.map((page) => [page.path, page.state, page.reason])).toEqual([
      ['a-slow.md', 'failed', 'took too long to render'],
      ['b-fine.md', 'rendered', undefined],
    ]);
    expect(fs.readFileSync(path.join(out, report.pages[1]!.file), 'utf8')).toMatch(/<p data-block="[^"]+" data-lines="3-3">Text\.<\/p>/);
  });
});
