import fs from 'node:fs';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import type {Readable, Writable} from 'node:stream';
import {afterEach, describe, expect, it} from 'vitest';
import {CdpError, createCdpPipe} from '../src/rendered/worker/cdp.js';
import sharp from 'sharp';
import {CHROME_FLAGS, createBrowser, type TileDocument} from '../src/rendered/worker/browser.js';
import {createRenderedHandler} from '../src/rendered/worker/handler.js';
import {BROWSER_JOB_DEADLINES_MS, type FragmentRequest, type LayoutResult, type TileResult, type TileSource} from '../src/rendered/backend.js';
import type {PageLayout} from '../src/rendered/plan.js';
import {tileGeometry} from '../src/rendered/tileGeometry.js';
import {cleanupTempDirs, makeTempDir, writeExecutable} from './core-helpers.js';

// The DevTools protocol over a pipe, against a fake peer on fds 3 and 4
// that answers the way Chromium does: framing, events, refusals and
// deadlines. Then the browser the in-pane view draws with, against a fake
// Chromium: how it starts, the one page it loads documents into with
// scripts and the network off, and what a crash or a hang costs.

const PEER = fileURLToPath(new URL('./fake-cdp-peer.mjs', import.meta.url));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  cleanupTempDirs();
});

function peer(mode: string, log?: string) {
  const child = spawn(process.execPath, [PEER], {stdio: ['ignore', 'ignore', 'inherit', 'pipe', 'pipe'], env: {...process.env, FAKE_CDP_MODE: mode, ...(log ? {FAKE_CDP_LOG: log} : {})}});
  children.push(child);
  return {child, pipe: createCdpPipe(child.stdio[4] as Readable, child.stdio[3] as Writable, {timeoutMs: 1_000})};
}

function logged(file: string) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {argv?: string[]; method?: string; params?: Record<string, unknown>; sessionId?: string});
}

describe('the DevTools pipe', () => {
  it('joins answers that arrive a few bytes at a time and matches each to its command', async () => {
    const {pipe} = peer('echo');
    const answers = await Promise.all([
      pipe.send('Test.one', {value: 1}),
      pipe.send('Test.two', {value: 'two with a \u0000-free string'}),
      pipe.send('Test.three'),
    ]);
    expect(answers).toEqual([
      {method: 'Test.one', params: {value: 1}},
      {method: 'Test.two', params: {value: 'two with a \u0000-free string'}},
      {method: 'Test.three', params: {}},
    ]);
    pipe.close();
  });

  it('hands events to their listeners with the session they came from', async () => {
    const {pipe} = peer('echo');
    const heard: Array<[unknown, string | undefined]> = [];
    const stop = pipe.on('Test.happened', (params, sessionId) => heard.push([params.value, sessionId]));
    await pipe.send('Test.event', {value: 7});
    expect(heard).toEqual([[7, 'S1']]);
    stop();
    await pipe.send('Test.event', {value: 8});
    expect(heard).toHaveLength(1);
    pipe.close();
  });

  it('rejects a refused command with the first line of its reason', async () => {
    const {pipe} = peer('echo');
    const refused = await pipe.send('Test.fail').catch((error: CdpError) => error);
    expect(refused).toBeInstanceOf(CdpError);
    expect(refused).toMatchObject({kind: 'protocol', message: 'No such thing'});
    pipe.close();
  });

  it('fails a command past its deadline and keeps the pipe for the next', async () => {
    const {pipe} = peer('hang:Test.slow');
    const started = Date.now();
    const late = await pipe.send('Test.slow', {}, {timeoutMs: 150}).catch((error: CdpError) => error);
    expect(late).toMatchObject({kind: 'timeout'});
    expect(Date.now() - started).toBeLessThan(1_000);
    pipe.close();
  });

  it('fails every waiting command, and says so, when the peer dies', async () => {
    const {pipe} = peer('crash:Test.boom');
    const waiting = pipe.send('Test.boom').catch((error: CdpError) => error);
    expect(await waiting).toMatchObject({kind: 'closed'});
    expect(await pipe.closed).toMatch(/closed/);
    expect(await pipe.send('Test.after').catch((error: CdpError) => error.kind)).toBe('closed');
  });
});

const DOC: TileDocument = {key: 'doc-1', html: '<!doctype html><title>t</title><p>page</p>', cssWidth: 973.142857, dpr: 1.75, scheme: 'dark'};

function fakeChrome(mode = 'browser') {
  const dir = makeTempDir('branch-review-fake-chrome-');
  const log = path.join(dir, 'log.jsonl');
  // A program on its own, as Chromium is, that the browser starts by path.
  const binary = writeExecutable(path.join(dir, 'chrome-headless-shell'), `#!/bin/sh\nFAKE_CDP_MODE='${mode}' FAKE_CDP_LOG='${log}' exec '${process.execPath}' '${PEER}' "$@"\n`);
  const spawned: ChildProcess[] = [];
  const browser = createBrowser({
    binary: {path: binary, headless: '--headless'},
    userDataDir: path.join(dir, 'chrome'),
    timeoutsMs: {launch: 5_000, call: 1_500},
    spawn: (command, args, options) => {
      const child = spawn(command, args, options);
      children.push(child);
      spawned.push(child);
      return child;
    },
  });
  return {browser, log, dir, spawned};
}

describe('the browser', () => {
  it('starts headless on a pipe, in its own profile, with the network and every extra off', async () => {
    const {browser, log, dir} = fakeChrome();
    await browser.layout(DOC);
    const [{argv}] = logged(log);
    expect(argv).toEqual(expect.arrayContaining(['--headless', '--remote-debugging-pipe', `--user-data-dir=${path.join(dir, 'chrome')}`, ...CHROME_FLAGS]));
    expect(argv).toEqual(expect.arrayContaining(['--host-resolver-rules=MAP * ~NOTFOUND', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings', '--no-first-run', '--disable-extensions']));
    // Chromium's own sandbox stays on, and no debugging port is opened.
    expect(argv!.some((arg) => arg.startsWith('--no-sandbox') || arg.startsWith('--remote-debugging-port'))).toBe(false);
    browser.close();
  });

  it('loads a document into one blank page with scripts off, never reading a file, and lays it out', async () => {
    const {browser, log} = fakeChrome();
    const layout = await browser.layout(DOC);
    const methods = logged(log).flatMap((entry) => (entry.method ? [entry] : []));
    const named = (method: string) => methods.filter((entry) => entry.method === method);
    expect(named('Target.createTarget')).toEqual([expect.objectContaining({params: {url: 'about:blank'}})]);
    expect(named('Emulation.setScriptExecutionDisabled')[0]!.params).toEqual({value: true});
    expect(named('Emulation.setEmulatedMedia')[0]!.params).toEqual({features: [{name: 'prefers-color-scheme', value: 'dark'}, {name: 'prefers-reduced-motion', value: 'reduce'}]});
    expect(named('Emulation.setDeviceMetricsOverride')[0]!.params).toMatchObject({width: 974, deviceScaleFactor: 1.75, mobile: false});
    expect(named('Fetch.enable')[0]!.params).toEqual({patterns: [{urlPattern: '*'}]});
    expect(named('Page.setDocumentContent')[0]!.params).toEqual({frameId: 'F1', html: DOC.html});
    expect(named('Page.navigate')).toEqual([]);
    // The one remote request the page made is failed, as if a client blocked it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logged(log).filter((entry) => entry.method === 'Fetch.failRequest').map((entry) => entry.params)).toEqual([{requestId: 'R1', errorReason: 'BlockedByClient'}]);
    expect(named('DOMSnapshot.captureSnapshot')[0]!.params).toMatchObject({includeDOMRects: true});
    // As tall as the page's root box, not the browser's content size, which a short page pads to the viewport.
    expect(layout).toEqual({
      heightCss: 600,
      blocks: [{id: 'b-1', top: 80, bottom: 128, lines: [3, 4], mark: 'added'}],
      removed: [{top: 200, bottom: 222}],
      links: [{href: 'f-123.html#user-content-x', left: 40, right: 100, top: 80, bottom: 100}],
      anchors: [{id: 'user-content-intro', top: 20}],
    });
    browser.close();
  });

  it('loads a document once however often it is cut, and captures each tile by its clip', async () => {
    const {browser, log} = fakeChrome();
    await browser.layout(DOC);
    const png = await browser.capture(DOC, {cssY: 662.857, cssHeight: 662.857});
    expect(Buffer.from(png).subarray(1, 4).toString('latin1')).toBe('PNG');
    await browser.capture(DOC, {cssY: 0, cssHeight: 100});
    const entries = logged(log);
    expect(entries.filter((entry) => entry.method === 'Page.setDocumentContent')).toHaveLength(1);
    const shots = entries.filter((entry) => entry.method === 'Page.captureScreenshot');
    expect(shots[0]!.params).toEqual({format: 'png', clip: {x: 0, y: 662.857, width: DOC.cssWidth, height: 662.857, scale: 1}, captureBeyondViewport: true, fromSurface: true});
    // Another document replaces it in the same page, which goes back to a
    // blank document first, so the first one's policy doesn't hold the next.
    await browser.layout({...DOC, key: 'doc-2', html: '<p>two</p>'});
    const methods = logged(log).flatMap((entry) => (entry.method ? [entry] : []));
    expect(methods.filter((entry) => entry.method === 'Page.setDocumentContent')).toHaveLength(2);
    expect(methods.filter((entry) => entry.method === 'Page.navigate').map((entry) => entry.params)).toEqual([{url: 'about:blank', frameId: 'F1'}]);
    const order = methods.map((entry) => entry.method).filter((method) => method === 'Page.navigate' || method === 'Page.setDocumentContent');
    expect(order).toEqual(['Page.setDocumentContent', 'Page.navigate', 'Page.setDocumentContent']);
    expect(methods.filter((entry) => entry.method === 'Target.createTarget')).toHaveLength(1);
    browser.close();
  });

  it('fails the job, and leaves nothing waiting, when the browser crashes as a document loads', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const {browser} = fakeChrome('crash:Page.setDocumentContent');
      await expect(browser.layout(DOC)).rejects.toThrow(/browser/);
      // Past the time the load would have waited for.
      await new Promise((resolve) => setTimeout(resolve, 1_800));
      expect(unhandled).toEqual([]);
      browser.close();
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('ends a job by its deadline, even while the browser is still starting', async () => {
    const {browser} = fakeChrome('hang:Target.createTarget');
    const started = Date.now();
    await expect(browser.capture(DOC, {cssY: 0, cssHeight: 10}, {deadline: started + 400})).rejects.toThrow(/browser/);
    expect(Date.now() - started).toBeLessThan(1_000);
    browser.close();
  });

  it('fails the job when the browser crashes, and starts a new one for the next', async () => {
    const {browser, spawned} = fakeChrome('crash:DOMSnapshot.captureSnapshot');
    await expect(browser.layout(DOC)).rejects.toThrow(/browser/);
    expect(spawned).toHaveLength(1);
    await expect(browser.layout(DOC)).rejects.toThrow(/browser/);
    expect(spawned).toHaveLength(2);
    browser.close();
  });

  it('kills a browser that stops answering, so the next job starts clean', async () => {
    const {browser, spawned} = fakeChrome('hang:Page.captureScreenshot');
    await browser.layout(DOC);
    await expect(browser.capture(DOC, {cssY: 0, cssHeight: 10})).rejects.toThrow(/didn't answer/);
    const first = spawned[0]!;
    await new Promise((resolve) => (first.exitCode !== null || first.signalCode !== null ? resolve(null) : first.once('exit', resolve)));
    expect(first.signalCode ?? first.exitCode).not.toBeNull();
    browser.close();
  });

  it('ends the browser on close', async () => {
    const {browser, spawned} = fakeChrome();
    await browser.layout(DOC);
    browser.close();
    const [child] = spawned;
    await new Promise((resolve) => (child!.exitCode !== null || child!.signalCode !== null ? resolve(null) : child!.once('exit', resolve)));
    expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  });
});

// The worker's layout and tile jobs over a fake browser: the tile comes
// out exactly as many pixels as its cells hold whatever the browser
// rounded, with a mosaic of mean colors when asked, and three browser
// failures in a minute turn the in-pane view off, apart from the rest of
// the rendered view.
describe('the tile jobs', () => {
  const geometry = tileGeometry(220, {w: 13, h: 29})!;

  function source(dir: string, text = '# Title\n\nA paragraph.\n'): TileSource {
    fs.writeFileSync(path.join(dir, 'page.md'), text);
    const fragment: FragmentRequest = {
      cwd: dir, key: 'frag-1', path: 'page.md', status: 'added', source: {kind: 'worktree', path: 'page.md'}, groups: [], links: {},
      assets: {base: null, after: {tree: 'HEAD'}, epoch: 0},
    };
    return {fragment, scheme: 'dark', bg: '#101418', base: 'main', geometry, chrome: {path: '/fake/chrome', headless: '--headless'}};
  }

  // A browser that records what it was asked and answers from `capture`.
  function fakeBrowser(capture: (clip: {cssY: number; cssHeight: number}) => Promise<Uint8Array>, layout: () => Promise<PageLayout> = async () => ({heightCss: 600, blocks: [], removed: [], links: [], anchors: []})) {
    const documents: TileDocument[] = [];
    const clips: Array<{cssY: number; cssHeight: number}> = [];
    let made = 0;
    const factory = () => {
      made += 1;
      return {
        layout: async (document: TileDocument) => {
          documents.push(document);
          return layout();
        },
        capture: async (document: TileDocument, clip: {cssY: number; cssHeight: number}) => {
          documents.push(document);
          clips.push(clip);
          return capture(clip);
        },
        close: () => undefined,
      };
    };
    return {factory, documents, clips, made: () => made};
  }

  const solid = (width: number, height: number, color: {r: number; g: number; b: number}) => sharp({create: {width, height, channels: 4, background: {...color, alpha: 1}}}).png().toBuffer().then((buffer) => new Uint8Array(buffer));

  it('lays out the tile document of the fragment at the sheet width and scale, with the markdown it was drawn from', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    const fake = fakeBrowser(() => solid(10, 10, {r: 0, g: 0, b: 0}));
    const handler = createRenderedHandler({browser: fake.factory});
    const result = await handler.handle({type: 'layout', source: source(dir)}) as LayoutResult;
    const [document] = fake.documents;
    expect(result).toEqual({ok: true, layout: {heightCss: 600, blocks: [], removed: [], links: [], anchors: []}, document: document!.key, text: '# Title\n\nA paragraph.\n'});
    expect(document).toMatchObject({cssWidth: geometry.cssWidth, dpr: 1.75, scheme: 'dark'});
    expect(document!.html).toContain('A paragraph.');
    expect(document!.html).not.toMatch(/<script/i);
    handler.dispose();
  });

  it('answers a layout asked again for a document that didn\'t change without the browser, and a new one when it did', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    const fake = fakeBrowser(() => solid(10, 10, {r: 0, g: 0, b: 0}));
    const handler = createRenderedHandler({browser: fake.factory});
    const first = await handler.handle({type: 'layout', source: source(dir)}) as Extract<LayoutResult, {ok: true}>;
    // A refresh of the review: a new epoch, the same document.
    const again = await handler.handle({type: 'layout', source: {...source(dir), fragment: {...source(dir).fragment, assets: {base: null, after: {tree: 'HEAD'}, epoch: 1}}}}) as Extract<LayoutResult, {ok: true}>;
    expect(again.document).toBe(first.document);
    expect(fake.documents).toHaveLength(1);
    const edited = source(dir, '# Title\n\nAnother paragraph.\n');
    const changed = await handler.handle({type: 'layout', source: {...edited, fragment: {...edited.fragment, key: 'frag-2'}}}) as Extract<LayoutResult, {ok: true}>;
    expect(changed.document).not.toBe(first.document);
    expect(fake.documents).toHaveLength(2);
    handler.dispose();
  });

  it('gives the browser what is left of the job\'s deadline less a margin, so a hang fails as a browser failure', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    const budgets: Array<number | undefined> = [];
    const handler = createRenderedHandler({browser: () => ({
      layout: async (_document, budget) => {
        budgets.push(budget?.deadline);
        return {heightCss: 600, blocks: [], removed: [], links: [], anchors: []};
      },
      capture: async (_document, _clip, budget) => {
        budgets.push(budget?.deadline);
        return solid(1703, 1160, {r: 0, g: 0, b: 0});
      },
      close: () => undefined,
    })});
    // Each deadline counts from when its job arrived: between these two moments.
    const sent = async (job: Parameters<typeof handler.handle>[0]) => {
      const before = Date.now();
      await handler.handle(job);
      return {before, after: Date.now()};
    };
    const layout = await sent({type: 'layout', source: source(dir)});
    const tile = await sent({type: 'tile', source: source(dir), index: 0, rows: 100, mosaic: false});
    expect(budgets[0]).toBeGreaterThanOrEqual(layout.before + BROWSER_JOB_DEADLINES_MS.layout - 1_000);
    expect(budgets[0]).toBeLessThanOrEqual(layout.after + BROWSER_JOB_DEADLINES_MS.layout - 1_000);
    expect(budgets[1]).toBeGreaterThanOrEqual(tile.before + BROWSER_JOB_DEADLINES_MS.tile - 1_000);
    expect(budgets[1]).toBeLessThanOrEqual(tile.after + BROWSER_JOB_DEADLINES_MS.tile - 1_000);
    handler.dispose();
  });

  it('answers a tile job whose browser hangs as it starts with a browser failure, inside the tile deadline, at the default timeouts', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    const {log} = fakeChrome('hang:Target.createTarget');
    const binary = path.join(path.dirname(log), 'chrome-headless-shell');
    const handler = createRenderedHandler({browser: (chrome) => createBrowser({
      binary: chrome,
      userDataDir: path.join(dir, 'chrome'),
      spawn: (command, args, options) => {
        const child = spawn(command, args, options);
        children.push(child);
        return child;
      },
    })});
    const started = Date.now();
    const result = await handler.handle({type: 'tile', source: {...source(dir), chrome: {path: binary, headless: '--headless'}}, index: 0, rows: 100, mosaic: false}) as TileResult;
    expect(result).toMatchObject({ok: false, state: 'error'});
    expect(Date.now() - started).toBeLessThan(BROWSER_JOB_DEADLINES_MS.tile);
    handler.dispose();
  }, 20_000);

  it('cuts a tile exactly as many pixels as its cells hold, when the browser rounds a pixel short', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    const fake = fakeBrowser(() => solid(1703, 1159, {r: 20, g: 30, b: 40}));
    const handler = createRenderedHandler({browser: fake.factory});
    const result = await handler.handle({type: 'tile', source: source(dir), index: 1, rows: 100, mosaic: false}) as TileResult;
    expect(result.ok).toBe(true);
    const meta = await sharp(Buffer.from((result as {png: Uint8Array}).png)).metadata();
    expect([meta.width, meta.height]).toEqual([1703, 1160]);
    // The browser was asked for the tile's rows from where they start, with a pixel to spare.
    expect(fake.clips[0]!.cssY).toBeCloseTo((40 * 29) / 1.75, 6);
    expect(fake.clips[0]!.cssHeight).toBeGreaterThan((40 * 29) / 1.75);
    handler.dispose();
  });

  it('answers a mosaic of each cell\'s mean color when asked', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    // Red on the left half, blue on the right.
    const raw = Buffer.alloc(1703 * 1160 * 4);
    for (let y = 0; y < 1160; y += 1) {
      for (let x = 0; x < 1703; x += 1) raw.set(x < 851 ? [200, 0, 0, 255] : [0, 0, 200, 255], (y * 1703 + x) * 4);
    }
    const png = new Uint8Array(await sharp(raw, {raw: {width: 1703, height: 1160, channels: 4}}).png().toBuffer());
    const fake = fakeBrowser(async () => png);
    const handler = createRenderedHandler({browser: fake.factory});
    const result = await handler.handle({type: 'tile', source: source(dir), index: 0, rows: 100, mosaic: true}) as {ok: true; mosaic: Uint8Array};
    expect(result.mosaic).toHaveLength(131 * 40 * 3);
    expect([...result.mosaic.subarray(0, 3)]).toEqual([200, 0, 0]);
    const last = (131 * 40 - 1) * 3;
    expect([...result.mosaic.subarray(last, last + 3)]).toEqual([0, 0, 200]);
    handler.dispose();
  });

  it('says a tile PNG past 3.5 MB is too large, for the pane to cut 20 rows', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    const noise = Buffer.from(Array.from({length: 1703 * 1160 * 3}, () => Math.floor(Math.random() * 256)));
    const png = new Uint8Array(await sharp(noise, {raw: {width: 1703, height: 1160, channels: 3}}).png({compressionLevel: 0}).toBuffer());
    const handler = createRenderedHandler({browser: fakeBrowser(async () => png).factory});
    const result = await handler.handle({type: 'tile', source: source(dir), index: 0, rows: 100, mosaic: false}) as TileResult;
    expect(result).toMatchObject({ok: false, tooLarge: true});
    handler.dispose();
  });

  it('turns the in-pane view off after three browser failures in a minute, and asks the browser nothing more', async () => {
    const dir = makeTempDir('branch-review-tiles-');
    let now = 0;
    let calls = 0;
    const fake = fakeBrowser(async () => {
      calls += 1;
      throw new Error('the browser exited (code 3)');
    });
    const handler = createRenderedHandler({browser: fake.factory, now: () => now});
    const tile = () => handler.handle({type: 'tile', source: source(dir), index: 0, rows: 100, mosaic: false}) as Promise<TileResult>;
    expect(await tile()).toMatchObject({ok: false, reason: 'the browser exited (code 3)'});
    now += 61_000;
    // A failure a minute later starts the count again.
    expect(await tile()).toMatchObject({ok: false});
    now += 1_000;
    expect((await tile() as {tilesOff?: true}).tilesOff).toBeUndefined();
    // The third failure in the minute is the one that turns tiles off, and says so.
    expect(await tile()).toMatchObject({ok: false, tilesOff: true, reason: 'in-pane view turned off: the browser exited (code 3)'});
    now += 1_000;
    const off = await tile();
    expect(off).toMatchObject({ok: false, tilesOff: true, reason: 'in-pane view turned off: the browser exited (code 3)'});
    expect(calls).toBe(4);
    // Still the rendered view: a page job works.
    expect(await handler.handle({type: 'layout', source: source(dir)})).toMatchObject({ok: false, tilesOff: true});
    expect(calls).toBe(4);
    handler.dispose();
  });
});
