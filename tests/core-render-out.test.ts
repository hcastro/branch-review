import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {renderToDirectory} from '../src/rendered/renderOut.js';
import {OPEN_DEADLINE_MS} from '../src/rendered/service.js';
import {prepareStartup} from '../src/startup.js';
import {cleanupTempDirs, commitAll, git, initRepo, makeTempDir, snapshotTree, withEnvAsync, writeExecutable, writeFiles} from './core-helpers.js';
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

type ReportFile = {
  path: string;
  status: string;
  card: string;
  kind: string;
  additions: number;
  deletions: number;
  note?: string;
  state?: string;
  changes?: {changed: number; removed: number};
  differences?: Array<{kind: string; count: number}>;
  embeds?: string[];
  late?: true;
  reason?: string;
};

type Report = {
  version: number;
  base: string;
  branch: string;
  dir: string;
  page: string | null;
  files: ReportFile[];
  also: ReportFile[];
};

// The files with a rich view or sides: markdown, images and SVG.
const rendered = (report: Pick<Report, 'files'>) => report.files.filter((file) => file.state !== undefined);

// One file's card on the page the export wrote, as the page draws it.
function cardOf(dir: string, file: ReportFile) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const id = file.card.slice(file.card.indexOf('#') + 1);
  const start = new RegExp(`<section class="rv-card[^"]*" id="${id}"`).exec(html)!.index;
  return html.slice(start, html.indexOf('</section>', start));
}

// The stable name a card's file goes by, which a link from another file's rich view names.
const aliasOf = (dir: string, file: ReportFile) => /data-alias="(f-[0-9a-f]+)"/.exec(cardOf(dir, file))![1]!;

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
  it('loads the renderer only for --export-html, so the UI starts without it', () => {
    const startup = fs.readFileSync(fileURLToPath(new URL('../src/startup.ts', import.meta.url)), 'utf8');
    expect(startup).not.toMatch(/^import .* from '\.\/rendered\//m);
    expect(startup).toContain("await import('./rendered/renderOut.js')");
  });
});

describe('--export-html', () => {
  it('writes the review page for the whole branch and prints a JSON report of its files', () => {
    const repo = featureRepo();
    const out = path.join(makeTempDir('branch-review-out-'), 'pages');
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report).toMatchObject({version: 2, base: 'main', branch: 'feature', dir: out, page: 'index.html'});
    // Every changed file, code too, each at its card, in the review's order.
    expect(report.files.map((file) => [file.path, file.status, file.kind, file.state ?? null, file.card])).toEqual([
      ['docs/guide.md', 'modified', 'markdown', 'markdown', 'index.html#file-0'],
      ['docs/new.md', 'added', 'markdown', 'markdown', 'index.html#file-1'],
      ['docs/old.md', 'deleted', 'markdown', 'markdown', 'index.html#file-2'],
      ['docs/renamed.md', 'renamed', 'markdown', 'markdown', 'index.html#file-3'],
      ['src/app.ts', 'modified', 'text', null, 'index.html#file-4'],
    ]);
    const guide = report.files[0]!;
    expect(guide.changes).toEqual({changed: 1, removed: 1});
    expect(report.files[1]!.differences).toEqual([{kind: 'remoteImage', count: 1}]);
    expect(report.files[4]).toMatchObject({additions: 1, deletions: 1});

    // One page and the link report, named by us, never by repo text.
    expect(fs.readdirSync(out).sort()).toEqual(['index.html', 'links.json']);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).toMatch(/^<!doctype html>\n<html lang="en" class="rv">\n<head>\n<meta http-equiv="Content-Security-Policy"/);
    const guideCard = cardOf(out, guide);
    expect(guideCard).toContain('data-mark="modified"');
    expect(guideCard).toContain('− 1 paragraph removed · show');
    expect(cardOf(out, report.files[2]!)).toContain('<b>Deleted file.</b> Shown as it was on the base branch.');
    // The rename's content is the same: its card says so, and where it was.
    expect(cardOf(out, report.files[3]!)).toContain('<span class="rv-from">docs/moved.md → </span>docs/<b>renamed.md</b>');
    expect(cardOf(out, report.files[4]!)).toContain('<table class="diff uni">');
  });

  it('links rich views to each other\'s cards and leaves links to files outside the review inert', () => {
    const repo = initRepo({'README.md': '# Readme\n', 'docs/a.md': '# A\n', 'src/app.ts': 'x\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {
      'README.md': '# Readme\n\nRead [A](docs/a.md#a), [the app](src/app.ts) and [gone](docs/missing.md).\n',
      'docs/a.md': '# A\n\nBack to the [readme](../README.md).\n',
    });
    commitAll(repo, 'links');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const file = (repoPath: string) => report.files.find((each) => each.path === repoPath)!;
    const readme = cardOf(out, file('README.md'));
    // A link names the other file's card on this page, its rich view and the heading.
    const cardId = (repoPath: string) => file(repoPath).card.slice('index.html#'.length);
    expect(readme).toContain(`<a href="#${cardId('docs/a.md')}&amp;v=rich&amp;h=user-content-a">A</a>`);
    expect(readme).toContain('<a class="br-inert" title="not part of this review">the app</a>');
    expect(readme).toContain('<a class="br-inert br-broken" title="file not found">gone</a>');
    expect(cardOf(out, file('docs/a.md'))).toContain(`<a href="#${cardId('README.md')}&amp;v=rich">readme</a>`);
    // The card keeps its stable name for the page script, and no link names a page the export didn't write.
    expect(aliasOf(out, file('docs/a.md'))).toMatch(/^f-[0-9a-f]{20}$/);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const hrefs = [...html.matchAll(/<a [^>]*?href="([^"]*)"/g)].map((match) => match[1]!.replace(/&amp;/g, '&'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, href).toMatch(/^#/);
      expect(html, href).toContain(`id="${href.slice(1).split('&')[0]}"`);
    }
  });

  it('renders the work tree for HEAD, untracked markdown included, and writes nothing outside the out dir', () => {
    const repo = initRepo({'README.md': '# Readme\n\nOld line.\n'});
    writeFiles(repo, {'README.md': '# Readme\n\nNew line.\n', 'notes/draft.md': '# Draft\n\nNot added yet.\n'});
    // git status refreshes the index's stat cache, so it runs before the
    // snapshot, and the comparison after it reads the snapshot first.
    const status = git(repo, 'status', '--porcelain=v1', '--untracked-files=all');
    const before = snapshotTree(repo);
    const out = makeTempDir('branch-review-out-');

    const result = runCli(path.join(repo, 'notes'), ['HEAD', 'main', '--export-html', out, '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.branch).toBe('HEAD + worktree');
    // In the review's own order, which sorts by locale.
    expect(report.files.map((file) => [file.path, file.status])).toEqual([['notes/draft.md', 'untracked'], ['README.md', 'modified']]);
    expect(cardOf(out, report.files[0]!)).toContain('<b>Untracked file.</b> Everything below is new, and not part of a push yet.');

    // The repo, its index and the child's temp dir are as they were.
    expect(snapshotTree(repo)).toEqual(before);
    expect(git(repo, 'status', '--porcelain=v1', '--untracked-files=all')).toBe(status);
    expect(fs.readdirSync(result.tmp)).toEqual([]);
  });

  it('resolves a relative out dir from where it was started, and can write over its own last run', () => {
    const repo = initRepo({'docs/a.md': '# A\n'});
    writeFiles(repo, {'docs/a.md': '# A\n\nMore.\n'});
    const work = makeTempDir('branch-review-work-');
    const first = runCli(work, ['--export-html', 'rendered']);
    expect(first.status).toBe(1);
    expect(first.stderr).toMatch(/^branch-review: not a git repository/);

    const inRepo = runCli(path.join(repo, 'docs'), ['--export-html', 'rendered', '--json']);
    expect(inRepo.status).toBe(0);
    const report = JSON.parse(inRepo.stdout) as Report;
    expect(report.dir).toBe(path.join(repo, 'docs', 'rendered'));
    const again = runCli(path.join(repo, 'docs'), ['--export-html', 'rendered', '--json']);
    expect(again.status).toBe(0);
    expect(fs.readdirSync(path.join(repo, 'docs', 'rendered')).sort()).toEqual(['index.html', 'links.json']);
  });

  it('prints a short summary without --json, with paths as given', () => {
    const repo = featureRepo();
    const result = runCli(repo, ['feature', 'main', '--export-html', 'out']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const lines = result.stdout.trimEnd().split('\n');
    expect(lines[0]).toBe('Wrote out/index.html and out/links.json for 5 files · nothing left this machine');
    expect(lines.slice(1)).toEqual([
      '  M docs/guide.md     #file-0  1 changed · 1 removed',
      '  A docs/new.md       #file-1  new file · 1 difference',
      '  D docs/old.md       #file-2  deleted',
      '  R docs/renamed.md   #file-3  renamed',
      '  M src/app.ts        #file-4  +1 −1',
    ]);
    // No terminal codes: the output is for logs and agents.
    expect(result.stdout).not.toContain('\u001B');
  });

  it('writes the page for a branch with nothing but code, and says there is nothing to export when nothing changed', () => {
    const repo = initRepo({'a.ts': 'x\n'});
    writeFiles(repo, {'a.ts': 'y\n'});
    const out = makeTempDir('branch-review-out-');
    const code = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(code.status).toBe(0);
    expect((JSON.parse(code.stdout) as Report).files.map((file) => [file.path, file.kind])).toEqual([['a.ts', 'text']]);
    expect(fs.readdirSync(out).sort()).toEqual(['index.html', 'links.json']);

    const clean = initRepo({'a.ts': 'x\n'});
    const none = makeTempDir('branch-review-out-');
    const text = runCli(clean, ['HEAD', 'main', '--export-html', none]);
    expect(text.status).toBe(0);
    expect(text.stdout).toBe('nothing to export · no files changed on this branch\n');
    const json = runCli(clean, ['HEAD', 'main', '--export-html', none, '--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout) as Report).toMatchObject({page: null, files: []});
    expect(fs.readdirSync(none)).toEqual([]);
  });

  it('says in its report and summary that a diff the page has no room for is too large, as its card does', () => {
    const repo = initRepo({'a.ts': 'x\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    // About 2.4 MB of diff: past what the page carries of file text.
    writeFiles(repo, {'huge.txt': `${Array.from({length: 40_000}, (_, line) => `row ${line} ${'x'.repeat(50)}`).join('\n')}\n`});
    commitAll(repo, 'add a huge file');
    const out = makeTempDir('branch-review-out-');
    const json = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(json.status).toBe(0);
    const [huge] = (JSON.parse(json.stdout) as Report).files;
    expect(huge).toMatchObject({path: 'huge.txt', note: 'This diff is too large to show here. Open the file to see it.'});
    expect(cardOf(out, huge!)).toContain('rv-special-tooLarge');
    const text = runCli(repo, ['feature', 'main', '--export-html', out]);
    expect(text.stdout).toMatch(/A huge\.txt +#file-0 +new file · This diff is too large to show here\. Open the file to see it\.\n/);
  });

  it('shows a card, not a failure, for an empty, oversized or non-UTF-8 file', () => {
    const repo = initRepo({'empty.md': 'x\n', 'big.md': 'x\n', 'latin.md': 'x\n'});
    fs.writeFileSync(path.join(repo, 'empty.md'), '');
    fs.writeFileSync(path.join(repo, 'big.md'), `# Big\n\n${'word '.repeat(450_000)}\n`);
    fs.writeFileSync(path.join(repo, 'latin.md'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.state])).toEqual([['big.md', 'tooLarge'], ['empty.md', 'empty'], ['latin.md', 'notUtf8']]);
    const big = cardOf(out, report.files[0]!);
    expect(big).toContain('too large to show (2.1 MB)');
    expect(big).toContain('<pre class="br-raw"># Big');
    for (const page of report.files) {
      expect(cardOf(out, page)).not.toMatch(/\/Users\/|\/home\/|\n {4}at /);
    }
  });

  it('fails with one line when the out dir can\'t be written', () => {
    const repo = initRepo({'a.md': '# A\n'});
    writeFiles(repo, {'a.md': '# A\n\nB.\n'});
    const parent = makeTempDir('branch-review-out-');
    fs.writeFileSync(path.join(parent, 'taken'), 'a file, not a dir');
    const result = runCli(repo, ['HEAD', 'main', '--export-html', path.join(parent, 'taken')]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^branch-review: can't write the pages to .*taken: not a directory\n$/);
  });

  it('never writes over an index.html or links.json it didn\'t write, and replaces its own', () => {
    const repo = initRepo({'a.md': '# A\n', 'site/index.html': '<!doctype html><title>The site</title>\n'});
    writeFiles(repo, {'a.md': '# A\n\nB.\n'});
    const site = path.join(repo, 'site');
    const refused = runCli(repo, ['HEAD', 'main', '--export-html', 'site']);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe('');
    expect(refused.stderr).toBe("branch-review: can't write the page to site: index.html is already there and isn't a branch-review page\n");
    expect(fs.readFileSync(path.join(site, 'index.html'), 'utf8')).toBe('<!doctype html><title>The site</title>\n');
    expect(fs.readdirSync(site)).toEqual(['index.html']);
    expect(git(repo, 'status', '--porcelain', '--', 'site')).toBe('');

    // Its own last run, it replaces.
    const out = makeTempDir('branch-review-out-');
    expect(runCli(repo, ['HEAD', 'main', '--export-html', out]).status).toBe(0);
    const again = runCli(repo, ['HEAD', 'main', '--export-html', out]);
    expect(again.stderr).toBe('');
    expect(again.status).toBe(0);
    expect(fs.readdirSync(out).sort()).toEqual(['index.html', 'links.json']);

    // A links.json of someone else's stops it before the page is written.
    const other = makeTempDir('branch-review-out-');
    fs.writeFileSync(path.join(other, 'links.json'), '{"links": []}\n');
    const links = runCli(repo, ['HEAD', 'main', '--export-html', other]);
    expect(links.status).toBe(1);
    expect(links.stderr).toContain("links.json is already there and isn't a branch-review link report");
    expect(fs.readdirSync(other)).toEqual(['links.json']);

    // Nor through a symlink, even to a page of its own.
    const linked = makeTempDir('branch-review-out-');
    fs.symlinkSync(path.join(out, 'index.html'), path.join(linked, 'index.html'));
    const symlink = runCli(repo, ['HEAD', 'main', '--export-html', linked]);
    expect(symlink.status).toBe(1);
    expect(symlink.stderr).toContain("index.html is already there and isn't a branch-review page");
    expect(fs.lstatSync(path.join(linked, 'index.html')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(linked)).toEqual(['index.html']);
  });

  it('refuses a missing directory and a lone --json with a usage line', () => {
    const repo = initRepo({'a.md': '# A\n'});
    const missing = runCli(repo, ['--export-html']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe('branch-review: --export-html needs a directory, for example --export-html ./pages\n');
    const lone = runCli(repo, ['--json']);
    expect(lone.status).toBe(1);
    expect(lone.stderr).toBe('branch-review: --json works only with --export-html\n');
  });

  it('writes the whole report into a pipe that is read late, past the pipe\'s 64 KiB buffer', async () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    // Long paths keep the file count, and the run, small.
    const dir = Array.from({length: 5}, (_, level) => `folder-${level}-${'x'.repeat(160)}`).join('/');
    const files: Record<string, string> = {};
    for (let index = 0; index < 75; index += 1) files[`${dir}/page-${String(index).padStart(3, '0')}.md`] = `# Page ${index}\n`;
    writeFiles(repo, files);
    const out = makeTempDir('branch-review-out-');

    const json = await runCliIntoSlowPipe(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(json.stderr).toBe('');
    expect(json.status).toBe(0);
    expect(Buffer.byteLength(json.stdout)).toBeGreaterThan(64 * 1024);
    expect((JSON.parse(json.stdout) as Report).files).toHaveLength(75);

    const text = await runCliIntoSlowPipe(repo, ['HEAD', 'main', '--export-html', out]);
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
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(30_000);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.state, page.reason])).toEqual([
      ['a-slow.md', 'failed', 'took too long to prepare'],
      ['b-fine.md', 'markdown', undefined],
    ]);
    const slow = cardOf(out, report.files[0]!);
    expect(slow).toContain("couldn't show this file · took too long to prepare");
    expect(slow).toContain('<pre class="br-raw">*a*a*a');
  });

  it('keeps hidden characters in repo paths off the terminal, in the JSON report and the summary', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    const name = 'evil\u009B31m‮DM\u001B[2J.md';
    writeFiles(repo, {[name]: '# Evil\n'});
    const out = makeTempDir('branch-review-out-');

    const json = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(json.status).toBe(0);
    expect(json.stdout).not.toMatch(HIDDEN);
    expect(json.stdout).not.toContain('\u001B');
    expect(json.stdout).toContain('evil\\u009b31m\\u202eDM\\u001b[2J.md');
    expect((JSON.parse(json.stdout) as Report).files.map((page) => page.path)).toEqual([name]);

    const text = runCli(repo, ['HEAD', 'main', '--export-html', out]);
    expect(text.status).toBe(0);
    expect(text.stdout).not.toMatch(HIDDEN);
    expect(text.stdout).not.toContain('\u001B');
    expect(text.stdout).toContain('evil<U+009B>31m<U+202E>DM␛[2J.md');
  });

  it('draws bidi and zero-width characters on the page as markers, outside the rich views, with the bidi warning (Trojan Source)', () => {
    const repo = initRepo({'src/auth.ts': 'let isAdmin = false;\n\tconsole.log(1);\n'});
    writeFiles(repo, {
      'src/auth.ts': 'let isAdmin = false;\n/*\u202E } \u2066if (isAdmin)\u2069 \u2066 begin admins only */\n\tconsole.log(1);\n',
      'zw\u200B.ts': 'export {};\n',
    });
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const outside = html.replace(/<article class="markdown-body">[\s\S]*?<\/article>/g, '');
    expect(outside).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200B]/);
    expect(html).toContain('&lt;U+202E&gt;');
    expect(html).toContain('This file contains bidirectional Unicode text that may read differently than it appears.');
    expect(html).toContain('<span class="mk"> </span>\t');
    const tree = html.slice(html.indexOf('<ul class="rv-tree" id="tree"'), html.indexOf('</aside>'));
    expect(tree.replace(/<[^>]+>/g, '')).toContain('zw&lt;U+200B&gt;.ts');
    expect(html).toContain('data-path="zw&#x200B;.ts"');
  });

  it('exports a README whose link holds a long hostile attribute value well inside the time r waits for a page', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    writeFiles(repo, {'README.md': `# Readme\n\n<a title="${'<img b'.repeat(40_000)}">t</a>\n`});
    const out = makeTempDir('branch-review-out-');
    const started = Date.now();
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    const took = Date.now() - started;
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(took).toBeLessThan(OPEN_DEADLINE_MS);
    expect(fs.readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('<img b<img b');
  });

  it('shows a file far over the render limit as too large, with its first text, in the work tree and at a ref', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {'committed.md': `# Committed\n\n${'word '.repeat(700_000)}\n`});
    commitAll(repo, 'big file');
    // Past the 16 MiB read limit the review uses for other files.
    writeFiles(repo, {'huge.md': `# Huge\n\n${'word '.repeat(3_600_000)}\n`});

    const worktree = runCli(repo, ['HEAD', 'main', '--export-html', makeTempDir('branch-review-out-'), '--json']);
    expect(worktree.status).toBe(0);
    const pages = (JSON.parse(worktree.stdout) as Report).files;
    expect(pages.map((page) => [page.path, page.state])).toEqual([['committed.md', 'tooLarge'], ['huge.md', 'tooLarge']]);
    const huge = cardOf((JSON.parse(worktree.stdout) as Report).dir, pages[1]!);
    expect(huge).toContain('too large to show (17.2 MB)');
    expect(huge).toContain('<pre class="br-raw"># Huge');

    const atRef = runCli(repo, ['feature', 'main', '--export-html', makeTempDir('branch-review-out-'), '--json']);
    expect(atRef.status).toBe(0);
    const report = JSON.parse(atRef.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.state])).toEqual([['committed.md', 'tooLarge']]);
    const committed = cardOf(report.dir, report.files[0]!);
    expect(committed).toContain('too large to show (3.3 MB)');
    expect(committed).toContain('<pre class="br-raw"># Committed');
  });

  it('leaves the OS temp dir as it was', () => {
    const repo = featureRepo();
    const osTmp = makeTempDir('branch-review-os-tmp-');
    const result = runCli(repo, ['feature', 'main', '--export-html', makeTempDir('branch-review-out-')], {osTmp});
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
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const guide = cardOf(out, report.files.find((page) => page.path === 'docs/guide.md')!);
    expect(guide).toContain('<a class="br-inert br-broken" title="file not found">old notes</a>');
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
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.status, page.state, page.reason])).toEqual([
      ['bigger.md', 'renamed', 'tooLarge', undefined],
      ['moved.md', 'renamed', 'notUtf8', undefined],
    ]);
    expect(cardOf(out, report.files[0]!)).toContain('too large to show (2.1 MB)');
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
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    // Every changed file has a card: the logo moved with no change, and says so.
    expect(report.files.map((page) => [page.path, page.status, page.changes])).toEqual([['guide/guide.md', 'renamed', {changed: 1, removed: 0}], ['guide/logo.png', 'renamed', undefined]]);
    expect(report.files[1]!.note).toBe('File renamed without changes.');
    expect(cardOf(out, report.files[0]!)).not.toContain('file not found');
  });

  it('renders a markdown file whose terminal diff failed, and lists it', () => {
    const repo = initRepo({'a.md': '# A\n\nBREAKDELTA here.\n', 'b.md': '# B\n\nFine.\n'});
    writeFiles(repo, {'a.md': '# A\n\nBREAKDELTA here, edited.\n', 'b.md': '# B\n\nFine, edited.\n'});
    const binDir = wrappedDelta('input=$(cat); case "$input" in *BREAKDELTA*) echo "delta broke" >&2; exit 1;; esac; printf \'%s\\n\' "$input" |');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json'], {binDir});
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.state, page.changes])).toEqual([
      ['a.md', 'markdown', {changed: 1, removed: 0}],
      ['b.md', 'markdown', {changed: 1, removed: 0}],
    ]);
    expect(cardOf(out, report.files[0]!)).toMatch(/<p [^>]*data-mark="modified">BREAKDELTA here, edited\./);

    const summary = runCli(repo, ['HEAD', 'main', '--export-html', out], {binDir});
    expect(summary.stdout).toMatch(/^ {2}M a\.md /m);
  });

  it('reads a link named after an object key as a link outside the review', () => {
    const repo = initRepo({'README.md': '# Readme\n'});
    writeFiles(repo, {'README.md': '# Readme\n\n[a](constructor), [b](toString), [c](__proto__) and [d](missing.md).\n'});
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    const readme = cardOf(out, report.files[0]!);
    // None names a file git holds, so each is drawn broken.
    for (const text of ['a', 'b', 'c', 'd']) expect(readme).toContain(`<a class="br-inert br-broken" title="file not found">${text}</a>`);
    expect(report.files[0]!.differences).toEqual([]);
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
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json'], {binDir});
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.state, page.changes, page.reason])).toEqual([
      ['a.md', 'failed', {changed: 0, removed: 0}, "doesn't match the diff: changed since the review read it, or changed by a git filter"],
      ['b.md', 'markdown', {changed: 1, removed: 0}, undefined],
    ]);
    const page = cardOf(out, report.files[0]!);
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

    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout) as Report;
    const readme = report.files.find((page) => page.path === 'README.md')!;
    const html = cardOf(out, readme);
    const inlined = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
    // The page shows the branch's logo; its before view, the base's.
    expect(html).toContain(inlined(blue));
    expect(html).toMatch(new RegExp(`class="br-before-body">[\\s\\S]*${inlined(red).replace(/[+/]/g, '\\$&')}`));
    expect(html).toContain("won't render on GitHub: file is untracked · notes/draft.png");
    expect(readme.differences).toEqual([]);
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
    const result = spawnSync(process.execPath, [path.join(build, 'dist/cli.js'), 'HEAD', 'main', '--export-html', out, '--json'], {
      cwd: repo,
      env: {...process.env, BRANCH_REVIEW_TMPDIR: makeTempDir('branch-review-render-tmp-')},
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Report;
    expect(report.files.map((page) => [page.path, page.state, page.reason])).toEqual([
      ['a-slow.md', 'failed', 'took too long to prepare'],
      ['b-fine.md', 'markdown', undefined],
    ]);
    expect(cardOf(out, report.files[1]!)).toMatch(/<p data-block="[^"]+" data-lines="3-3">Text\.<\/p>/);
  });
});

describe('--export-html over the whole branch', () => {
  type Whole = Report & {also: Report['files']; findings: Array<{path: string; line: number; target: string; what: string; kind: string; reason: string}>};
  type Links = {version: number; findings: Whole['findings']; links: Array<{path: string; line: number; href: string; status: string}>};

  // main has a README that shows the hero image and a guide; the branch
  // changes the image alone, and `extra` on top of that.
  function heroRepo(extra: Record<string, string> = {}) {
    const repo = initRepo({
      'README.md': '# Project\n\nThe hero:\n\n![Hero](docs/hero.png)\n',
      'docs/guide.md': '# Guide\n\n## Install\n\nRun it.\n',
      'docs/other.md': '# Other\n\nNo pictures, though it names hero.png in its text.\n',
    });
    fs.writeFileSync(path.join(repo, 'docs/hero.png'), pngFixture(3, 2, [200, 40, 40, 255]));
    commitAll(repo, 'hero');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'docs/hero.png'), pngFixture(4, 5, [40, 40, 200, 255]));
    writeFiles(repo, extra);
    commitAll(repo, 'a new hero');
    return repo;
  }

  it('shows the README that embeds a changed image under "also looks different", after the image\'s card', () => {
    const repo = heroRepo();
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Whole;
    expect(report.files.map((page) => [page.path, page.state])).toEqual([['docs/hero.png', 'image']]);
    // Its text didn't change; the image it shows did. A file that only
    // names the image in its text shows nothing that changed.
    expect(report.also.map((page) => [page.path, page.status, page.state, page.changes])).toEqual([['README.md', 'modified', 'markdown', {changed: 1, removed: 0}]]);

    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(html).toContain('<h2 class="rv-also-h">Also looks different</h2>');
    expect(report.also[0]!.card).toBe('index.html#file-1');
    const readme = cardOf(out, report.also[0]!);
    expect(readme).toMatch(/<p [^>]*data-mark="modified"><img src="data:image\/png;base64,/);
    expect(readme).toContain('<b>Not changed on this branch.</b> It shows <code>docs/hero.png</code>, which this branch changed.');
    const hero = cardOf(out, report.files[0]!);
    expect(hero).toMatch(/<span class="rv-fh-size">\d+ B → \d+ B<\/span>/);
    expect(hero).toMatch(/<p class="rv-img-meta">3 × 2 · \d+ B → 4 × 5 · \d+ B/);
  });

  it('renders a page whose lookups ran out of time once more, so a cold git leaves out no page and claims nothing', async () => {
    const repo = heroRepo({'docs/guide.md': '# Guide\n\nSee [the notes](notes.md).\n'});
    const {cwd, range, review} = await prepareStartup({cwd: repo, options: {requestedBranch: 'feature', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    const out = makeTempDir('branch-review-out-');
    // No time at all for a lookup: every first render, before git has read
    // a tree or an image, runs out of it.
    // The search for "also looks different" is not what this test times: it has all the time it needs.
    const report = await renderToDirectory({cwd, range, review, outDir: out, outLabel: out, now: () => 0, lookupBudgetMs: 0, embeddersMs: 60_000});
    expect(report.also.map((page) => [page.path, page.embeds])).toEqual([['README.md', ['docs/hero.png']]]);
    expect(report.findings).toEqual([{path: 'docs/guide.md', line: 3, target: 'notes.md', what: 'link', kind: 'missing', reason: 'file not found'}]);
    const links = JSON.parse(fs.readFileSync(path.join(out, 'links.json'), 'utf8')) as Links;
    expect(links.links).toEqual([{path: 'docs/guide.md', line: 3, href: 'notes.md', status: 'missing'}]);
  });

  it('waits for a late render\'s lookups before rendering it again, however slowly git answers', async () => {
    const repo = heroRepo({'docs/guide.md': '# Guide\n\nSee [the notes](notes.md).\n'});
    const {cwd, range, review} = await prepareStartup({cwd: repo, options: {requestedBranch: 'feature', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    const out = makeTempDir('branch-review-out-');
    // A git that takes a second to say whether a file is untracked: past
    // the first render's budget, and still at work when it ends.
    const bin = makeTempDir('branch-review-slow-git-');
    const realGit = spawnSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).stdout.trim();
    writeExecutable(path.join(bin, 'git'), ['#!/bin/sh', 'case "$*" in *ls-files*--others*) sleep 1 ;; esac', `exec '${realGit}' "$@"`, ''].join('\n'));
    const report = await withEnvAsync({PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}, () => renderToDirectory({cwd, range, review, outDir: out, outLabel: out, now: () => 0, lookupBudgetMs: 0, embeddersMs: 60_000}));
    expect(report.findings).toEqual([{path: 'docs/guide.md', line: 3, target: 'notes.md', what: 'link', kind: 'missing', reason: 'file not found'}]);
    expect(report.files.find((page) => page.path === 'docs/guide.md')).not.toHaveProperty('late');
  });

  it('waits no longer than a render\'s deadline for lookups that never answer, and keeps the page late', async () => {
    const repo = heroRepo({'docs/guide.md': '# Guide\n\nSee [the notes](notes.md).\n'});
    const {cwd, range, review} = await prepareStartup({cwd: repo, options: {requestedBranch: 'feature', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    const out = makeTempDir('branch-review-out-');
    const bin = makeTempDir('branch-review-stuck-git-');
    const realGit = spawnSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).stdout.trim();
    writeExecutable(path.join(bin, 'git'), ['#!/bin/sh', 'case "$*" in *ls-files*--others*) sleep 15 ;; esac', `exec '${realGit}' "$@"`, ''].join('\n'));
    const started = Date.now();
    const report = await withEnvAsync({PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}, () => renderToDirectory({cwd, range, review, outDir: out, outLabel: out, now: () => 0, lookupBudgetMs: 0, embeddersMs: 60_000}));
    // One render's deadline of waiting, 5 seconds, not the 15 git takes.
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(report.files.find((page) => page.path === 'docs/guide.md')).toMatchObject({late: true});
  });

  it('finds markdown that still shows a moved image by its old name', () => {
    const repo = initRepo({'README.md': '# Project\n\n![Logo](docs/old.svg)\n'});
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs/old.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>\n');
    commitAll(repo, 'logo');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'mv', 'docs/old.svg', 'docs/new.svg');
    fs.writeFileSync(path.join(repo, 'docs/new.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="blue"/></svg>\n');
    commitAll(repo, 'move the logo');
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Whole;
    expect(report.files.map((page) => [page.path, page.status])).toEqual([['docs/new.svg', 'renamed']]);
    // On GitHub the README now shows a broken image, where it showed the logo.
    expect(report.also.map((page) => [page.path, page.changes, page.embeds])).toEqual([['README.md', {changed: 1, removed: 0}, ['docs/old.svg']]]);
  });

  it('lists neither name of a file the work tree moved under "also looks different", next to a changed image', () => {
    const repo = initRepo({'docs/old.md': '# Old\n\n![Hero](hero.png)\n', 'CHANGES.md': '# Changes\n\n![Hero](docs/hero.png)\n'});
    fs.writeFileSync(path.join(repo, 'docs/hero.png'), pngFixture(3, 2, [200, 40, 40, 255]));
    commitAll(repo, 'hero');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'mv', 'docs/old.md', 'docs/new.md');
    fs.writeFileSync(path.join(repo, 'docs/hero.png'), pngFixture(4, 5, [40, 40, 200, 255]));
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['HEAD', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Whole;
    expect(report.files.map((page) => [page.path, page.status])).toEqual([['docs/hero.png', 'modified'], ['docs/new.md', 'renamed']]);
    // The file left alone that shows the hero is the one page outside the review.
    expect(report.also.map((page) => page.path)).toEqual(['CHANGES.md']);
  });

  it('keeps hidden characters in an embedded image\'s name off the terminal, in the summary of a page that also looks different', () => {
    const name = 'docs/x\u202Egnp.\u009B31mexe.png';
    const repo = initRepo({'README.md': `# Project\n\n![x](<${name}>)\n`});
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, name), pngFixture(3, 2, [200, 40, 40, 255]));
    commitAll(repo, 'hero');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, name), pngFixture(4, 5, [40, 40, 200, 255]));
    commitAll(repo, 'a new hero');
    const text = runCli(repo, ['feature', 'main', '--export-html', makeTempDir('branch-review-out-')]);
    expect(text.status).toBe(0);
    expect(text.stdout).not.toMatch(HIDDEN);
    expect(text.stdout).toContain('text unchanged · embeds docs/x<U+202E>gnp.<U+009B>31mexe.png');
  });

  it('finds a planted bad anchor and a link to a file that isn\'t there, in links.json and on the page', () => {
    const repo = heroRepo({'docs/guide.md': '# Guide\n\n## Install\n\nRun it. Then [read the readme](../README.md#nope), the [install step](#install) and [the notes](notes.md).\n'});
    const out = makeTempDir('branch-review-out-');
    const result = runCli(repo, ['feature', 'main', '--export-html', out, '--json']);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as Whole;
    // The README isn't in the review: its anchors come from the file git holds.
    const findings = [
      {path: 'docs/guide.md', line: 5, target: '../README.md#nope', what: 'link', kind: 'badAnchor', reason: 'anchor not found'},
      {path: 'docs/guide.md', line: 5, target: 'notes.md', what: 'link', kind: 'missing', reason: 'file not found'},
    ];
    expect(report.findings).toEqual(findings);
    const links = JSON.parse(fs.readFileSync(path.join(out, 'links.json'), 'utf8')) as Links;
    expect(links.version).toBe(1);
    expect(links.findings).toEqual(findings);
    expect(links.links).toEqual([
      {path: 'docs/guide.md', line: 5, href: '../README.md#nope', status: 'badAnchor'},
      {path: 'docs/guide.md', line: 5, href: '#install', status: 'ok'},
      {path: 'docs/guide.md', line: 5, href: 'notes.md', status: 'missing'},
    ]);

    // With the README in the review, its anchors are known: #nope isn't one.
    const both = heroRepo({'docs/guide.md': '# Guide\n\nRead the [readme](../README.md#nope) or [its top](../README.md#project).\n', 'README.md': '# Project\n\nThe hero, now:\n\n![Hero](docs/hero.png)\n'});
    const again = makeTempDir('branch-review-out-');
    const second = JSON.parse(runCli(both, ['feature', 'main', '--export-html', again, '--json']).stdout) as Whole;
    expect(second.findings).toEqual([{path: 'docs/guide.md', line: 3, target: '../README.md#nope', what: 'link', kind: 'badAnchor', reason: 'anchor not found'}]);
    const guide = cardOf(again, second.files.find((page) => page.path === 'docs/guide.md')!);
    const readme = second.files.find((page) => page.path === 'README.md')!.card.split('#')[1];
    expect(guide).toContain(`<a href="#${readme}&amp;v=rich&amp;h=user-content-nope" class="br-broken" title="anchor not found">readme</a>`);
    expect(guide).toContain(`<a href="#${readme}&amp;v=rich&amp;h=user-content-project">its top</a>`);
    // The page lists it above the files, its row jumping to the guide's card.
    const page = fs.readFileSync(path.join(again, 'index.html'), 'utf8');
    expect(page).toContain("Won't render on GitHub · 1 broken link");
    expect(page).toMatch(new RegExp(`<a class="rv-row" href="#${second.files.find((each) => each.path === 'docs/guide.md')!.card.split('#')[1]}"[^>]*><code>docs/guide\\.md:3</code><span>\\.\\./README\\.md#nope · anchor not found</span></a>`));
    expect((JSON.parse(fs.readFileSync(path.join(again, 'links.json'), 'utf8')) as Links).links.map((link) => link.status)).toEqual(['badAnchor', 'ok']);
  });
});
