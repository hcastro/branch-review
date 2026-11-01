import fs from 'node:fs';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown, type AssetAnswer} from '../src/rendered/markdown.js';
import {PAGE_SCRIPT} from '../src/rendered/assets.generated.js';
import {assembleFilePage, assembleOverview, type PageInput, type RailEntry} from '../src/rendered/page.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';
import {diffFile} from './rendered-helpers.js';

// The page script in a real browser: the develop's frames stepped by hand
// on the animation clock and each beat checked at its time, its end state
// against the page that arrives with motion off, a develop the page held
// back, a page that loads out of sight, live pulses and the place they
// keep, the page with scripting off, reduced motion and the keys.
// Opt-in: BRANCH_REVIEW_TEST_CHROME names a Chromium or chrome-headless-shell
// binary. It runs headless with no network (every host resolves to nothing)
// in a profile of its own, driven over --remote-debugging-pipe.

const CHROME = process.env.BRANCH_REVIEW_TEST_CHROME;
const VIEW = {width: 1100, height: 760};

const BEFORE = [
  '# Rendered view', '', 'The rendered view shows a markdown file the way GitHub would.', '',
  '## How the trip works', '', 'Press `o` to open the page.', '', '![Diagram](diagram.png)', '',
  '| Surface | Opens |', '| --- | --- |', '| cmux | a browser split |', '| browser | a new tab |', '',
  '- Pages are written to the session folder.', '- Nothing leaves the machine.', '',
  '```js', 'const page = render(source);', '```', '',
  ...Array.from({length: 30}, (_, index) => `Filler paragraph ${index + 1}, long enough to wrap once it is rendered at the page's measure in a wide window.\n`),
].join('\n');
const AFTER = BEFORE
  .replace('Press `o` to open the page.', 'Press `r`. The diff you were reading becomes the page,\nand the lines you changed stay marked in the margin.')
  .replace('| browser | a new tab |', '| browser | a new tab |\n| SSH | a toast naming v |')
  .replace('- Nothing leaves the machine.', '- Nothing leaves the machine.\n- Each press reuses the split.');

// A second page in the rail: changed paragraphs one under the other, as a
// step's count must tell apart, and a picture with a dark source.
const OTHER_BEFORE = [
  '# Another page', '',
  'The first paragraph, before.', '', 'The second paragraph, before.', '', 'The third paragraph, before.', '',
  '<picture><source media="(prefers-color-scheme: dark)" srcset="dark.png"><img alt="Logo" src="light.png"></picture>', '',
  ...Array.from({length: 30}, (_, index) => `Filler paragraph ${index + 1}, long enough to wrap once it is rendered at the page's measure in a wide window.\n`),
].join('\n');
const OTHER_AFTER = OTHER_BEFORE.replace(/, before\./g, ', after.');

type Message = {id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: {message: string}};

// Just enough of the DevTools protocol over the pipe: NUL-terminated JSON,
// one page target in flat session mode.
function cdp(child: ChildProcess) {
  const input = child.stdio[3] as Writable;
  const output = child.stdio[4] as Readable;
  let buffer = '';
  let next = 0;
  const waiting = new Map<number, {resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void}>();
  const listeners = new Set<(message: Message) => void>();
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\0'); at >= 0; at = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, at)) as Message;
      buffer = buffer.slice(at + 1);
      if (message.id !== undefined) {
        const pending = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error.message));
        else pending?.resolve(message.result ?? {});
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  });
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = (next += 1);
    waiting.set(id, {resolve, reject});
    input.write(`${JSON.stringify({id, method, params, ...(sessionId ? {sessionId} : {})})}\0`);
  });
  const once = (method: string, sessionId: string) => new Promise<void>((resolve) => {
    const listener = (message: Message) => {
      if (message.method !== method || message.sessionId !== sessionId) return;
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });
  return {send, once};
}

describe.skipIf(!CHROME)('the develop in a real Chromium', () => {
  let child: ChildProcess;
  let session = '';
  let send: ReturnType<typeof cdp>['send'];
  let once: ReturnType<typeof cdp>['once'];
  let pageUrl = '';

  const page = (method: string, params: Record<string, unknown> = {}) => send(method, params, session);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const answer = await page('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}) as {result: {value: T}; exceptionDetails?: unknown};
    if (answer.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
    return answer.result.value;
  };
  let pageDir = '';
  const urlOf = (name: string) => pathToFileURL(path.join(pageDir, name)).href;
  const load = async (hash: string, url = pageUrl) => {
    const blank = once('Page.loadEventFired', session);
    await page('Page.navigate', {url: 'about:blank'});
    await blank;
    const loaded = once('Page.loadEventFired', session);
    await page('Page.navigate', {url: `${url}#${hash}`});
    await loaded;
  };
  const key = async (value: string) => {
    await page('Input.dispatchKeyEvent', {type: 'keyDown', key: value, ...(value.length === 1 ? {text: value} : {})});
    await page('Input.dispatchKeyEvent', {type: 'keyUp', key: value});
  };
  const sleep = (ms: number) => evaluate(`new Promise((resolve) => setTimeout(resolve, ${ms}))`);
  const frames = () => evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  // Runs `body` with a script on every new page ahead of the page's own.
  const withPageScript = async <T>(source: string, body: () => Promise<T>): Promise<T> => {
    const {identifier} = await page('Page.addScriptToEvaluateOnNewDocument', {source}) as {identifier: string};
    try {
      return await body();
    } finally {
      await page('Page.removeScriptToEvaluateOnNewDocument', {identifier});
    }
  };
  // Holds back the page script's long timers, which is only the develop's
  // deadline, so a test that steps the clock by hand is never overtaken by it.
  const HOLD_DEADLINE = 'window.__deadlines = []; { const later = window.setTimeout.bind(window); window.setTimeout = (run, ms, ...rest) => (ms >= 1000 ? window.__deadlines.push(run) : later(run, ms, ...rest)); }';
  // A page that is out of sight until the test shows it.
  const HIDDEN = 'window.__visibility = "hidden"; Object.defineProperty(Document.prototype, "visibilityState", {configurable: true, get: () => window.__visibility}); Object.defineProperty(Document.prototype, "hidden", {configurable: true, get: () => window.__visibility === "hidden"}); window.__show = () => { window.__visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); };';
  const settledState = '({veil: !!document.querySelector(".br-veil"), tints: document.querySelectorAll(".br-tint").length, animations: document.getAnimations().length, styled: document.querySelectorAll("[style]").length})';
  const blockTop = (selector: string) => `(() => Math.round(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top - document.querySelector(".br-strip").getBoundingClientRect().bottom))()`;
  const shot = async (clip?: {x: number; y: number; width: number; height: number}) => {
    const {data} = await page('Page.captureScreenshot', {format: 'png', ...(clip ? {clip: {...clip, scale: 1}} : {})}) as {data: string};
    return sharp(Buffer.from(data, 'base64')).ensureAlpha().raw().toBuffer();
  };
  const differing = (left: Buffer, right: Buffer) => {
    let count = 0;
    for (let at = 0; at < Math.min(left.length, right.length); at += 4) {
      if (left[at] !== right[at] || left[at + 1] !== right[at + 1] || left[at + 2] !== right[at + 2]) count += 1;
    }
    return count + Math.abs(left.length - right.length) / 4;
  };
  const media = (reduced: boolean) => page('Emulation.setEmulatedMedia', {features: [
    {name: 'prefers-color-scheme', value: 'dark'},
    {name: 'prefers-reduced-motion', value: reduced ? 'reduce' : 'no-preference'},
  ]});

  beforeAll(async () => {
    const dir = makeTempDir('branch-review-chrome-');
    pageDir = dir;
    // Three pictures of one size and three colors: the page's diagram, and a
    // logo's light and dark sources.
    const picture = async (red: number, green: number, blue: number): Promise<AssetAnswer> => {
      const png = await sharp({create: {width: 320, height: 120, channels: 3, background: {r: red, g: green, b: blue}}}).png().toBuffer();
      return {kind: 'embed', mime: 'image/png', dataUrl: `data:image/png;base64,${png.toString('base64')}`, oid: `oid-${red}`, width: 320, height: 120};
    };
    const pictures: Record<string, AssetAnswer> = {'docs/diagram.png': await picture(40, 120, 200), 'docs/light.png': await picture(250, 250, 250), 'docs/dark.png': await picture(10, 10, 10)};
    const asset = async (repoPath: string): Promise<AssetAnswer> => pictures[repoPath] ?? {kind: 'skipped'};
    const title: PageInput['title'] = {repo: 'branch-review-cli', base: 'main', branch: 'feature/rich-view', worktree: false, renderedAt: Date.UTC(2026, 9, 31, 17)};
    const render = async (repoPath: string, before: string, after: string) => {
      const fragment = await renderMarkdown({path: repoPath, source: after, groups: changeGroups(diffFile(before, after, repoPath)), asset, link: () => ({kind: 'outside'})});
      return {repoPath, fragment};
    };
    const files = [await render('docs/rendered-view.md', BEFORE, AFTER), await render('docs/other.md', OTHER_BEFORE, OTHER_AFTER)];
    // A deleted file's page, which is its base text.
    const gone = await renderMarkdown({path: 'docs/gone.md', status: 'deleted', source: OTHER_BEFORE, groups: [], asset, link: () => ({kind: 'outside'})});
    fs.writeFileSync(path.join(dir, 'gone.html'), assembleFilePage({title, file: {path: 'docs/gone.md', status: 'deleted', body: {kind: 'rendered', fragment: gone}}, rail: []}));
    const names = ['page.html', 'other.html'];
    const rail = (current: number): RailEntry[] => files.map(({repoPath, fragment}, index) => ({path: repoPath, status: 'modified', href: names[index]!, label: String(fragment.changes.changed), current: index === current}));
    for (const [index, {repoPath, fragment}] of files.entries()) {
      fs.writeFileSync(path.join(dir, names[index]!), assembleFilePage({title, file: {path: repoPath, status: 'modified', body: {kind: 'rendered', fragment}}, rail: rail(index)}));
    }
    // The same file's page again, as a live refresh writes it under a new name.
    fs.copyFileSync(path.join(dir, 'page.html'), path.join(dir, 'page-next.html'));
    fs.writeFileSync(path.join(dir, 'overview.html'), assembleOverview({
      title,
      entries: files.map(({repoPath, fragment}, index) => ({path: repoPath, status: 'modified', href: names[index]!, state: 'rendered', changes: fragment.changes})),
      differences: [],
    }));
    pageUrl = urlOf('page.html');
    // An image's page, both sides the same size in two colors, and a page
    // with a link to a heading that isn't there.
    const side = async (red: number, green: number, blue: number) => {
      const png = await sharp({create: {width: 320, height: 120, channels: 3, background: {r: red, g: green, b: blue}}}).png().toBuffer();
      return {kind: 'shown' as const, dataUrl: `data:image/png;base64,${png.toString('base64')}`, mime: 'image/png', bytes: png.length, width: 320, height: 120};
    };
    fs.writeFileSync(path.join(dir, 'image.html'), assembleFilePage({
      title,
      file: {path: 'docs/hero.png', status: 'modified', body: {kind: 'image', image: {format: 'raster', before: await side(200, 40, 40), after: await side(40, 40, 200)}}},
      rail: [],
      appears: [{path: 'docs/rendered-view.md', line: 9, href: 'page.html'}],
    }));
    const broken = await renderMarkdown({path: 'docs/broken.md', source: '# Broken\n\nSee [nowhere](#nowhere) and [gone](gone.md).\n', groups: [], asset, link: () => ({kind: 'missing'})});
    fs.writeFileSync(path.join(dir, 'broken.html'), assembleFilePage({
      title,
      file: {path: 'docs/broken.md', status: 'modified', body: {kind: 'rendered', fragment: broken}},
      rail: [],
      report: {own: [{path: 'docs/broken.md', line: 3, target: '#nowhere', what: 'link', kind: 'badAnchor', reason: 'anchor not found'}, {path: 'docs/broken.md', line: 3, target: 'gone.md', what: 'link', kind: 'missing', reason: 'file not found'}], notes: ['2 links won\'t resolve']},
    }));
    // The page as it is before its page script runs: the head script alone.
    fs.writeFileSync(path.join(dir, 'first.html'), fs.readFileSync(path.join(dir, 'page.html'), 'utf8').replace(`<script>${PAGE_SCRIPT}</script>`, ''));

    child = spawn(CHROME!, [
      '--headless', '--remote-debugging-pipe', `--user-data-dir=${path.join(dir, 'profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--no-pings',
      '--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND',
      '--hide-scrollbars', '--force-color-profile=srgb', '--force-device-scale-factor=1',
      // Raster each tile whole, in software: a tile redrawn in part after an
      // animation can differ from a fresh one by a level of antialiasing,
      // which says nothing about the page.
      '--disable-gpu', '--disable-partial-raster',
    ], {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
    ({send, once} = cdp(child));
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'}) as {targetId: string};
    ({sessionId: session} = await send('Target.attachToTarget', {targetId, flatten: true}) as {sessionId: string});
    await page('Page.enable');
    // A target made over the pipe starts in the background, where frames
    // and timers wait: in front, it draws as a tab someone is reading.
    await page('Page.bringToFront');
    await page('Emulation.setFocusEmulationEnabled', {enabled: true});
    await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    await media(false);
  }, 60_000);

  afterAll(() => {
    child?.kill('SIGKILL');
    cleanupTempDirs();
  });

  it('steps through the develop and ends on exactly the page that arrives with motion off', async () => {
    await withPageScript(HOLD_DEADLINE, () => load('at=L7&f=0.3&d=full&m=1&bg=111318&fg=e6e6e6&n=1'));
    // The clock stops at once, and the test moves it.
    const started = await evaluate<number>('document.getAnimations().map((a) => (a.pause(), a.currentTime = 0)).length');
    expect(started).toBeGreaterThan(5);
    expect(await evaluate<boolean>('!!document.querySelector(".br-veil")')).toBe(true);
    const frames: Buffer[] = [];
    for (const t of [0, 120, 300, 520, 760, 1500]) {
      await evaluate(`document.getAnimations().forEach((a) => { a.currentTime = ${t}; })`);
      frames.push(await shot());
    }
    // The first frame is the raw source, and each step moves on from the last.
    expect(differing(frames[0]!, frames[2]!)).toBeGreaterThan(5_000);
    expect(differing(frames[2]!, frames[4]!)).toBeGreaterThan(5_000);
    // A key the page doesn't use, the way a reader interrupts: every
    // animation finishes, and the page settles.
    await page('Input.dispatchKeyEvent', {type: 'keyDown', key: 'Shift', code: 'ShiftLeft'});
    await page('Input.dispatchKeyEvent', {type: 'keyUp', key: 'Shift', code: 'ShiftLeft'});
    await evaluate('new Promise((resolve) => setTimeout(resolve, 100))');
    expect(await evaluate('({veil: !!document.querySelector(".br-veil"), tints: document.querySelectorAll(".br-tint").length, animations: document.getAnimations().length, styled: document.querySelectorAll("[style]").length})'))
      .toEqual({veil: false, tints: 0, animations: 0, styled: 0});
    const developed = await shot();

    await load('at=L7&f=0.3&d=full&m=0&n=2');
    expect(await evaluate<number>('document.getAnimations().length')).toBe(0);
    const still = await shot();
    expect(differing(developed, still)).toBe(0);
    // At 760 ms the layout is final, and the glow still shows on the changes.
    expect(differing(frames[4]!, still)).toBeGreaterThan(0);

    // Left to run on its own clock, it ends there too, and cleans up after itself.
    await load('at=L7&f=0.3&d=full&m=1&bg=111318&fg=e6e6e6&n=3');
    await evaluate('new Promise((resolve) => setTimeout(resolve, 2_200))');
    expect(await evaluate('({veil: !!document.querySelector(".br-veil"), tints: document.querySelectorAll(".br-tint").length, styled: document.querySelectorAll("[style]").length})'))
      .toEqual({veil: false, tints: 0, styled: 0});
    expect(differing(await shot(), still)).toBe(0);
  }, 60_000);

  it('paints its first frame in the terminal\'s background before the page script runs, and hands it back after', async () => {
    const corner = {x: VIEW.width - 8, y: VIEW.height - 8, width: 1, height: 1};
    const pixel = async () => [...(await shot(corner)).subarray(0, 3)];
    await load('at=L7&d=full&m=1&bg=0a0b0c&n=90', urlOf('first.html'));
    expect(await pixel()).toEqual([0x0a, 0x0b, 0x0c]);
    // Motion off, or a revisit: the page's own background from the start.
    await load('at=L7&d=full&m=0&bg=0a0b0c&n=91', urlOf('first.html'));
    expect(await pixel()).toEqual([0x0e, 0x14, 0x16]);
    await load('at=L7&d=short&m=1&bg=0a0b0c&n=92', urlOf('first.html'));
    expect(await pixel()).toEqual([0x0e, 0x14, 0x16]);
    // The page script takes the first frame over at once, under its raw frame.
    await load('at=L7&d=full&m=1&bg=0a0b0c&n=93');
    expect(await evaluate('({first: document.documentElement.hasAttribute("data-br-first"), style: document.documentElement.hasAttribute("style"), veil: !!document.querySelector(".br-veil")})')).toEqual({first: false, style: false, veil: true});
    await evaluate('new Promise((resolve) => setTimeout(resolve, 2_000))');
    expect(await pixel()).toEqual([0x0e, 0x14, 0x16]);
  }, 30_000);

  it('paints the terminal\'s background first with reduced motion too, where the raw frame fades out', async () => {
    const corner = {x: VIEW.width - 8, y: VIEW.height - 8, width: 1, height: 1};
    await media(true);
    try {
      await load('at=L7&d=full&m=1&bg=0a0b0c&n=94', urlOf('first.html'));
      expect([...(await shot(corner)).subarray(0, 3)]).toEqual([0x0a, 0x0b, 0x0c]);
    } finally {
      await media(false);
    }
  }, 30_000);

  it('compares an image side by side, by flipping and as a difference, on the TUI\'s digits', async () => {
    await load('m=0&n=170', urlOf('image.html'));
    const visible = '[...document.querySelectorAll(".br-figure")].filter((figure) => getComputedStyle(figure).visibility === "visible").map((figure) => figure.className.split(" ")[1])';
    const boxes = '[...document.querySelectorAll(".br-frame img")].map((image) => Math.round(image.getBoundingClientRect().left))';
    expect(await evaluate<string>('document.querySelector(".br-image-page").dataset.mode')).toBe('side');
    expect(await evaluate<boolean>('!document.querySelector(".br-modes").hidden')).toBe(true);
    const [left, right] = await evaluate<number[]>(boxes);
    expect(right! - left!).toBeGreaterThan(300);

    await key('2');
    expect(await evaluate<string[]>(visible)).toEqual(['br-after']);
    await key('f');
    expect(await evaluate<string[]>(visible)).toEqual(['br-before']);
    await key('2');
    expect(await evaluate<string[]>(visible)).toEqual(['br-after']);
    expect(await evaluate<string>('document.querySelector(\'.br-mode[aria-pressed="true"]\').dataset.mode')).toBe('flip');

    // Difference: the after side over the before side, each channel apart.
    await key('3');
    const center = await evaluate<{x: number; y: number}>('(() => { const rect = document.querySelector(".br-after img").getBoundingClientRect(); return {x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2)}; })()');
    const pixel = await shot({x: center.x, y: center.y, width: 1, height: 1});
    expect([...pixel.subarray(0, 3)]).toEqual([160, 0, 160]);

    await key('1');
    expect(await evaluate<number[]>(boxes)).toEqual([left, right]);
    // The choice stays for the next image page this browser opens.
    await key('3');
    await load('m=0&n=171', urlOf('image.html'));
    expect(await evaluate<string>('document.querySelector(".br-image-page").dataset.mode')).toBe('difference');
    await key('1');
  }, 30_000);

  it('brings an image page\'s pictures in from a blur on a first visit, and shows them sharp without motion', async () => {
    await withPageScript(HOLD_DEADLINE, () => load('d=full&m=1&n=172', urlOf('image.html')));
    expect(await evaluate<number>('document.getAnimations().length')).toBe(2);
    await evaluate('document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })');
    expect(await evaluate<string>('getComputedStyle(document.querySelector(".br-frame img")).filter')).toBe('blur(6px)');
    await key('Shift');
    expect(await evaluate<number>('document.getAnimations().length')).toBe(0);
    await load('d=full&m=0&n=173', urlOf('image.html'));
    expect(await evaluate<number>('document.getAnimations().length')).toBe(0);
  }, 30_000);

  it('draws a link that won\'t resolve with a red wavy line, and its strip chip steps to each', async () => {
    await load('m=0&n=180', urlOf('broken.html'));
    const lines = await evaluate<string[]>('[...document.querySelectorAll(".markdown-body a.br-broken")].map((link) => getComputedStyle(link).textDecorationStyle)');
    expect(lines).toEqual(['wavy', 'wavy']);
    expect(await evaluate<string>('document.querySelector(".br-findings").textContent')).toBe('2 broken links');
    expect(await evaluate<string>('document.querySelector(".br-findings").getAttribute("role")')).toBe('button');
    expect(await evaluate<string[]>('[...document.querySelectorAll(".br-rail .br-rail-findings li")].map((item) => item.textContent)')).toEqual(['2 links won\'t resolve']);
    await evaluate('document.querySelector(".br-findings").click()');
    await sleep(50);
    expect(await evaluate<string>('document.getAnimations()[0]?.effect.target.textContent ?? ""')).toBe('nowhere');
  }, 30_000);

  it('opens on the block under the reader\'s eyes, at the same height', async () => {
    await load('at=L7&f=0.3&d=full&m=0&n=30');
    const top = await evaluate<number>('Math.round(document.querySelector("[data-lines^=\\"7-\\"]").getBoundingClientRect().top - document.querySelector(".br-strip").getBoundingClientRect().bottom)');
    expect(top).toBe(Math.round(0.3 * (VIEW.height - 44)));
  }, 30_000);

  it('hears a later trip to the open page as a new hash: a revisit scrolls to its block, a live refresh pulses the new ones', async () => {
    await load('at=L7&f=0.3&d=full&m=0&n=40');
    const target = await evaluate<{id: string; line: number}>('(() => { const el = [...document.querySelectorAll("[data-block]")].find((each) => each.textContent.includes("Filler paragraph 12,")); return {id: el.dataset.block, line: Number(el.dataset.lines.split("-")[0])}; })()');
    const offset = `(() => Math.round(document.querySelector('[data-block="${target.id}"]').getBoundingClientRect().top - document.querySelector('.br-strip').getBoundingClientRect().bottom))()`;
    await evaluate(`location.hash = 'at=L${target.line}&f=0&d=short&m=1&n=41'`);
    // A short scroll, not a jump: partway there after a frame or two.
    await evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    expect(await evaluate<number>(offset)).toBeGreaterThan(0);
    await evaluate('new Promise((resolve) => setTimeout(resolve, 400))');
    expect(await evaluate<number>(offset)).toBe(0);
    // Then a glow on that block alone.
    expect(await evaluate<string[]>('document.getAnimations().map((a) => a.effect.target.dataset.block ?? "")')).toEqual([target.id]);
    await evaluate('new Promise((resolve) => setTimeout(resolve, 700))');

    await evaluate(`location.hash = 'at=L${target.line}&f=0&d=none&m=1&g=${target.id},b-ffffffff-9&n=42'`);
    await evaluate('new Promise((resolve) => setTimeout(resolve, 50))');
    expect(await evaluate<number>(offset)).toBe(0);
    expect(await evaluate<string[]>('document.getAnimations().map((a) => a.effect.target.dataset.block ?? "")')).toEqual([target.id]);
    expect(await evaluate<boolean>('!!document.querySelector(".br-veil")')).toBe(false);
  }, 30_000);

  it('shows the finished page with scripting off, never a blank one', async () => {
    await load('m=0&n=4');
    const scripted = await shot({x: 280, y: 160, width: 780, height: 560});
    await page('Emulation.setScriptExecutionDisabled', {value: true});
    try {
      await load('at=L7&f=0.3&d=full&m=1&n=5');
      const plain = await shot({x: 280, y: 160, width: 780, height: 560});
      expect(differing(plain, scripted)).toBe(0);
    } finally {
      await page('Emulation.setScriptExecutionDisabled', {value: false});
    }
  }, 30_000);

  it('with reduced motion, fades the raw frame once and moves nothing', async () => {
    await media(true);
    try {
      await load('at=L7&f=0.3&d=full&m=1&n=6');
      const kinds = await evaluate<string[]>('document.getAnimations().map((a) => a.effect.target.className)');
      expect(kinds).toEqual(['br-veil']);
      await evaluate('new Promise((resolve) => setTimeout(resolve, 400))');
      expect(await evaluate<boolean>('!!document.querySelector(".br-veil")')).toBe(false);
    } finally {
      await media(false);
    }
  }, 30_000);

  it('answers its keys: the next change, the theme and the marks', async () => {
    await load('m=0&n=7');
    const key = async (value: string) => {
      await page('Input.dispatchKeyEvent', {type: 'keyDown', key: value, ...(value.length === 1 ? {text: value} : {})});
      await page('Input.dispatchKeyEvent', {type: 'keyUp', key: value});
    };
    expect(await evaluate<string>('document.querySelector(".br-changes-at").textContent')).toBe('change 1 of 3');
    await key(']');
    await key(']');
    await evaluate('new Promise((resolve) => setTimeout(resolve, 800))');
    expect(await evaluate<string>('document.querySelector(".br-changes-at").textContent')).toBe('change 2 of 3');
    // And back to the first, which lands just under the strip.
    await key('[');
    await evaluate('new Promise((resolve) => setTimeout(resolve, 800))');
    expect(await evaluate<string>('document.querySelector(".br-changes-at").textContent')).toBe('change 1 of 3');
    expect(Math.abs(await evaluate<number>(blockTop('.markdown-body [data-mark]')) - 24)).toBeLessThanOrEqual(2);

    const background = 'getComputedStyle(document.body).backgroundColor';
    expect(await evaluate<string>(background)).toBe('rgb(14, 20, 22)');
    await key('t');
    expect(await evaluate<string>('document.documentElement.dataset.theme')).toBe('light');
    expect(await evaluate<string>(background)).toBe('rgb(255, 255, 255)');
    await key('t');
    await key('t');
    expect(await evaluate<string | undefined>('document.documentElement.dataset.theme')).toBeUndefined();

    const bar = 'getComputedStyle(document.querySelector(".markdown-body [data-mark]"), "::before").content';
    expect(await evaluate<string>(bar)).toBe('""');
    await key('m');
    expect(await evaluate<string>(bar)).toBe('none');
    await key('m');
    await key('?');
    expect(await evaluate<boolean>('document.getElementById("br-help").hidden')).toBe(false);
    await key('Escape');
    expect(await evaluate<boolean>('document.getElementById("br-help").hidden')).toBe(true);
  }, 30_000);

  it('plays each beat at its time: the raw frame in the terminal\'s colors, the scaled move, the tints into bars, the picture and the chips', async () => {
    await withPageScript(HOLD_DEADLINE, () => load('at=L7&f=0.3&d=full&m=1&bg=1e2026&fg=d0d4dc&n=60'));
    await evaluate('document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })');
    const at = (t: number) => evaluate(`document.getAnimations().forEach((a) => { a.currentTime = ${t}; })`);

    // The raw frame: the hash's colors, and the removed line as its own `- ` row.
    expect(await evaluate('(() => { const veil = getComputedStyle(document.querySelector(".br-veil")); return [veil.backgroundColor, veil.color]; })()')).toEqual(['rgb(30, 32, 38)', 'rgb(208, 212, 220)']);
    const removed = await evaluate<string[]>('[...document.querySelectorAll(".br-veil-removed")].map((row) => row.textContent)');
    expect(removed[0]).toBe('- Press `o` to open the page.');
    for (const row of removed) expect(row.startsWith('- ')).toBe(true);

    // The anchor block starts on its two raw lines, one scale on both axes.
    const anchor = '[data-lines="7-8"]';
    const flip = await evaluate<{a: number; d: number; height: number}>(`(() => { const el = document.querySelector('${anchor}'); const m = new DOMMatrix(getComputedStyle(el).transform); return {a: m.a, d: m.d, height: el.offsetHeight}; })()`);
    const scale = Math.min(4, Math.max(0.25, (2 * 20) / flip.height));
    expect(flip.a).toBeCloseTo(scale, 3);
    expect(flip.d).toBeCloseTo(scale, 3);

    // Each changed block's tint shrinks into its bar from 220 ms to 620 ms,
    // the chips wait for their blocks until 480 ms, and the picture comes
    // in from blurred to clear from 360 ms. The clock only moves forward:
    // an animation it passes the end of is done.
    const tint = 'document.querySelector(".br-tint") && new DOMMatrix(getComputedStyle(document.querySelector(".br-tint")).transform).a';
    const image = '(() => { const style = getComputedStyle(document.querySelector(".markdown-body img")); return [style.opacity, style.filter]; })()';
    const chip = 'getComputedStyle(document.querySelector("details.br-before")).opacity';
    // The markup marks fade first, from 120 ms to 220 ms.
    const markOpacity = 'getComputedStyle(document.querySelector(".br-veil-mark")).opacity';
    // The picture's box, in the picture's final shape, from 240 ms.
    const box = '(() => { const el = document.querySelector(".br-image-box"); const rect = el.getBoundingClientRect(); return {opacity: Number(getComputedStyle(el).opacity), width: Math.round(rect.width), height: Math.round(rect.height)}; })()';
    // Table rules draw in from 300 ms; code colors come in last, from 480 ms.
    const rule = 'getComputedStyle(document.querySelector(".markdown-body td")).borderTopColor';
    const token = '(() => { const pre = document.querySelector(".markdown-body pre"); return {plain: getComputedStyle(pre).color, token: getComputedStyle(pre.querySelector("span[class]")).color}; })()';
    await at(120);
    expect(await evaluate<string>(markOpacity)).toBe('1');
    await at(220);
    expect(await evaluate<string>(markOpacity)).toBe('0');
    expect(await evaluate<number>(tint)).toBeGreaterThan(0.95);
    expect((await evaluate<{opacity: number}>(box)).opacity).toBe(0);
    await at(300);
    expect(await evaluate<string>(chip)).toBe('0');
    expect(await evaluate<string>(rule)).toBe('rgba(0, 0, 0, 0)');
    expect((await evaluate<{opacity: number}>(box)).opacity).toBeGreaterThan(0.3);
    await at(360);
    expect(await evaluate(image)).toEqual(['0', 'blur(6px)']);
    const shape = await evaluate<{opacity: number; width: number; height: number}>(box);
    expect(shape.opacity).toBe(1);
    expect(shape.width / shape.height).toBeCloseTo(320 / 120, 1);
    await at(420);
    const halfway = await evaluate<number>(tint);
    expect(halfway).toBeGreaterThan(0.01);
    expect(halfway).toBeLessThan(0.6);
    await at(480);
    const early = await evaluate<{plain: string; token: string}>(token);
    expect(early.token).toBe(early.plain);
    await at(600);
    expect(await evaluate<number>(tint)).toBeLessThan(0.15);
    await at(1500);
    expect(await evaluate(image)).toEqual(['1', 'none']);
    expect(await evaluate<string>(chip)).toBe('1');
    const ended = {rule: await evaluate<string>(rule), token: await evaluate<{plain: string; token: string}>(token)};
    await key('Shift');
    await sleep(100);
    expect(await evaluate(settledState)).toEqual({veil: false, tints: 0, animations: 0, styled: 0});
    expect(await evaluate<number>('document.querySelectorAll(".br-image-box").length')).toBe(0);
    // Each ends on the final page's own color.
    expect(ended.rule).not.toBe('rgba(0, 0, 0, 0)');
    expect(ended.rule).toBe(await evaluate<string>(rule));
    expect(ended.token.token).not.toBe(ended.token.plain);
    expect(ended.token).toEqual(await evaluate(token));
  }, 60_000);

  it('finishes a develop the page held back once its time is up, and shows the final page', async () => {
    const hidden = '[...document.querySelectorAll(".markdown-body *")].filter((el) => getComputedStyle(el).opacity === "0").map((el) => el.outerHTML.slice(0, 60))';
    await load('at=L7&f=0.3&d=full&m=0&n=70');
    const still = await shot();
    // Only what the final page hides itself, such as a heading's link icon.
    const hiddenStill = await evaluate<string[]>(hidden);
    await load('at=L7&f=0.3&d=full&m=1&bg=111318&fg=e6e6e6&n=71');
    // As a page out of sight holds them: nothing moves.
    await evaluate('document.getAnimations().forEach((a) => a.pause())');
    expect(await evaluate<boolean>('!!document.querySelector(".br-veil")')).toBe(true);
    // The plan ends at 1500 ms; its deadline is 500 ms after.
    await sleep(2_300);
    expect(await evaluate(settledState)).toEqual({veil: false, tints: 0, animations: 0, styled: 0});
    expect(await evaluate<string[]>(hidden)).toEqual(hiddenStill);
    expect(differing(await shot(), still)).toBe(0);
  }, 30_000);

  it('plays a trip that reached a hidden page once it shows, and never after the reader acted', async () => {
    await withPageScript(HIDDEN, async () => {
      await load('at=L7&f=0.3&d=full&m=1&n=80');
      // Hidden: the final page, at the reader's place, with nothing playing.
      expect(await evaluate(settledState)).toEqual({veil: false, tints: 0, animations: 0, styled: 0});
      expect(await evaluate<number>(blockTop('[data-lines="7-8"]'))).toBe(Math.round(0.3 * (VIEW.height - 44)));
      await evaluate('window.__show()');
      expect(await evaluate<boolean>('!!document.querySelector(".br-veil")')).toBe(true);
      expect(await evaluate<number>('document.getAnimations().length')).toBeGreaterThan(5);
      await key('Shift');
      await sleep(100);
      expect(await evaluate(settledState)).toEqual({veil: false, tints: 0, animations: 0, styled: 0});

      await load('at=L7&f=0.3&d=full&m=1&n=81');
      await key('Shift');
      await evaluate('window.__show()');
      expect(await evaluate(settledState)).toEqual({veil: false, tints: 0, animations: 0, styled: 0});
    });
  }, 30_000);

  it('pulses a new table row, list item or code block on its own, and rings a new picture', async () => {
    await load('at=L7&f=0.3&d=full&m=0&n=90');
    const ids = await evaluate<{row: string; table: string; code: string; image: string; item: string}>(`(() => {
      const row = [...document.querySelectorAll('tr[data-block]')].find((each) => each.textContent.includes('SSH'));
      const code = document.querySelector('.highlight[data-block], pre[data-block]');
      const image = document.querySelector('.markdown-body img').closest('[data-block]');
      const item = [...document.querySelectorAll('li[data-block]')].find((each) => each.textContent.includes('Each press'));
      return {row: row.dataset.block, table: row.closest('table').dataset.block, code: code.dataset.block, image: image.dataset.block, item: item.dataset.block};
    })()`);
    const pulsed = '(() => document.getAnimations().map((a) => ({tag: a.effect.target.tagName, text: a.effect.target.textContent.trim().slice(0, 12), shadow: a.effect.getKeyframes()[1].boxShadow})))()';
    // The table's id is new too, as it is whenever one of its rows is.
    await evaluate(`location.hash = 'at=L7&f=0.3&d=none&m=1&g=${ids.table},${ids.row}&n=91'`);
    await sleep(50);
    const row = await evaluate<Array<{tag: string; text: string; shadow: string}>>(pulsed);
    expect(row.map((each) => `${each.tag} ${each.text}`)).toEqual(['TD SSH', 'TD a toast nami']);
    await sleep(700);
    // A new row or list item named alone, as the service sends it when the
    // table's or list's own id is unchanged.
    await evaluate(`location.hash = 'at=L7&f=0.3&d=none&m=1&g=${ids.row},${ids.item}&n=93'`);
    await sleep(50);
    expect((await evaluate<Array<{tag: string; text: string; shadow: string}>>(pulsed)).map((each) => `${each.tag} ${each.text}`).sort())
      .toEqual(['LI Each press r', 'TD SSH', 'TD a toast nami']);
    await sleep(700);

    await evaluate(`location.hash = 'at=L7&f=0.3&d=none&m=1&g=${ids.code},${ids.image}&n=92'`);
    await sleep(50);
    const others = await evaluate<Array<{tag: string; text: string; shadow: string}>>(pulsed);
    expect(others.map((each) => each.tag).sort()).toEqual(['IMG', 'PRE']);
    expect(others.find((each) => each.tag === 'IMG')!.shadow).not.toContain('inset');
    expect(others.find((each) => each.tag === 'PRE')!.shadow).toContain('inset');
  }, 30_000);

  it('opens a live refresh where the reader has scrolled to since the trip', async () => {
    await load('at=L7&f=0.3&d=full&m=0&n=100');
    await evaluate('scrollBy(0, 900)');
    await frames();
    const before = await evaluate<{id: string; top: number}>('(() => { const line = document.querySelector(".br-strip").getBoundingClientRect().bottom; const el = [...document.querySelectorAll("[data-block][data-lines]")].find((each) => each.getBoundingClientRect().bottom > line + 1); return {id: el.dataset.block, top: Math.round(el.getBoundingClientRect().top - line)}; })()');
    // The refresh still names the trip's line, as the service sends it.
    await load('at=L7&f=0.3&d=none&m=1&n=101', urlOf('page-next.html'));
    expect(await evaluate<number>(blockTop(`[data-block="${before.id}"]`))).toBe(before.top);
  }, 30_000);

  it('opens the next and previous file with } and {, and moves between the overview\'s rows', async () => {
    await load('m=0&n=110');
    let loaded = once('Page.loadEventFired', session);
    await key('}');
    await loaded;
    expect(await evaluate<string>('location.pathname.split("/").pop()')).toBe('other.html');
    loaded = once('Page.loadEventFired', session);
    await key('{');
    await loaded;
    expect(await evaluate<string>('location.pathname.split("/").pop()')).toBe('page.html');

    await load('m=0&n=111', urlOf('overview.html'));
    await key('}');
    expect(await evaluate<string>('document.activeElement.getAttribute("href")')).toBe('page.html');
    await key('}');
    expect(await evaluate<string>('document.activeElement.getAttribute("href")')).toBe('other.html');
    await key('{');
    expect(await evaluate<string>('document.activeElement.getAttribute("href")')).toBe('page.html');
  }, 30_000);

  it('sends a dark <picture> source along with the theme key', async () => {
    await load('m=0&n=120', urlOf('other.html'));
    const media = 'document.querySelector(".markdown-body picture source").media';
    expect(await evaluate<string>(media)).toBe('(prefers-color-scheme: dark)');
    await key('t');
    expect(await evaluate<string>(media)).toBe('not all');
    await key('t');
    expect(await evaluate<string>(media)).toBe('all');
    await key('t');
    expect(await evaluate<string>(media)).toBe('(prefers-color-scheme: dark)');
  }, 30_000);

  it('fades a before chip\'s old text in as it opens', async () => {
    await load('m=0&n=130');
    await evaluate('document.querySelector("details.br-before").open = true');
    await sleep(30);
    expect(await evaluate<number>('document.querySelector("details.br-before .br-before-body").getAnimations().length')).toBe(1);
  }, 30_000);

  it('counts the change a step landed on as current, a pixel either side of the step line', async () => {
    await load('m=0&n=140', urlOf('other.html'));
    const counter = 'document.querySelector(".br-changes-at").textContent';
    expect(await evaluate<string>(counter)).toBe('change 1 of 3');
    await key(']');
    await sleep(900);
    await key(']');
    await sleep(900);
    expect(await evaluate<string>(counter)).toBe('change 2 of 3');
    for (const nudge of [-1, 2]) {
      await evaluate(`scrollBy(0, ${nudge})`);
      await frames();
      expect(await evaluate<string>(counter), `nudged ${nudge}`).toBe('change 2 of 3');
    }
  }, 30_000);

  it('opens a deleted file on its lines in red, each still moving into its block', async () => {
    await withPageScript(HOLD_DEADLINE, () => load('at=L3&f=0.3&d=full&m=1&n=150', urlOf('gone.html')));
    await evaluate('document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })');
    const rows = await evaluate<Array<{className: string; text: string}>>('[...document.querySelectorAll(".br-veil-line")].map((row) => ({className: row.className, text: row.textContent}))');
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row.className).toBe('br-veil-line br-veil-deleted');
    expect(rows.some((row) => row.text.startsWith('- '))).toBe(false);
    // The anchor block starts on its raw line, so the frame counted it.
    const scale = await evaluate<number>('new DOMMatrix(getComputedStyle(document.querySelector(\'[data-lines="3-3"]\')).transform).d');
    expect(scale).not.toBeCloseTo(1, 2);
    await key('Shift');
  }, 30_000);

  it('steps its strip chip through the page\'s own findings, never through old text', async () => {
    // Old text in a before view, with a link and a card a build could still draw broken.
    const old = '<details class="br-before"><summary>before</summary><div class="br-before-body"><p><a class="br-inert br-broken">old</a> <span class="br-card br-refused">old card</span></p></div></details>';
    const html = fs.readFileSync(path.join(pageDir, 'broken.html'), 'utf8').replace('<article class="markdown-body">', `<article class="markdown-body">\n${old}`);
    fs.writeFileSync(path.join(pageDir, 'old-text.html'), html);
    await load('m=0&n=183', urlOf('old-text.html'));
    await evaluate('window.__seen = []; Element.prototype.scrollIntoView = function () { window.__seen.push(this.textContent); }');
    for (let step = 0; step < 3; step += 1) await evaluate('document.querySelector(".br-findings").click()');
    expect(await evaluate<string[]>('window.__seen')).toEqual(['nowhere', 'gone', 'nowhere']);
  }, 30_000);

  it('lines the rail\'s findings up with its titles', async () => {
    await load('m=0&n=181', urlOf('broken.html'));
    const left = (selector: string) => `Math.round(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().left)`;
    expect(await evaluate<number>(left('.br-rail-findings li'))).toBe(await evaluate<number>(left('.br-rail-title')));
  }, 30_000);

  it('draws every bar in the margin with the rest: a nested list item\'s and a footnote\'s too', async () => {
    const before = '# Bars\n\nA paragraph.\n\n- Top item\n  - Nested item\n    - Deeper item\n\nText with a note.[^1]\n\n[^1]: The note.\n';
    const after = before.replace('A paragraph.', 'A paragraph, edited.').replace('Deeper item', 'Deeper item, edited').replace('The note.', 'The note, edited.');
    const fragment = await renderMarkdown({path: 'docs/bars.md', source: after, groups: changeGroups(diffFile(before, after, 'docs/bars.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const title: PageInput['title'] = {repo: 'branch-review-cli', base: 'main', branch: 'feature/rich-view', worktree: false, renderedAt: 0};
    fs.writeFileSync(path.join(pageDir, 'bars.html'), assembleFilePage({title, file: {path: 'docs/bars.md', status: 'modified', body: {kind: 'rendered', fragment}}, rail: []}));
    for (const width of [VIEW.width, 400]) {
      await page('Emulation.setDeviceMetricsOverride', {width, height: VIEW.height, deviceScaleFactor: 1, mobile: false});
      try {
        await load('m=0&n=901', urlOf('bars.html'));
        const bars = await evaluate<Array<{tag: string; text: string; x: number}>>(`[...document.querySelectorAll('.markdown-body [data-mark]')]
          .filter((block) => block.tagName !== 'TR' && getComputedStyle(block, '::before').content !== 'none')
          .map((block) => ({tag: block.tagName, text: block.textContent.trim().slice(0, 24), x: Math.round(block.getBoundingClientRect().left + parseFloat(getComputedStyle(block, '::before').left))}))`);
        // The edited paragraph, the item two lists deep, and the footnote.
        expect(bars.map((bar) => bar.text.split(',')[0]), `${width}`).toEqual(['A paragraph', 'Deeper item', 'The note']);
        expect([...new Set(bars.map((bar) => bar.x))], JSON.stringify(bars)).toHaveLength(1);
      } finally {
        await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
      }
    }
  }, 30_000);

  it('ends a changed item\'s bar and tint where its nested list starts, in both themes', async () => {
    const before = '# Roadmap\n\n- [ ] Tables\n  - [ ] Alignment\n  - [ ] Wide tables\n- [ ] Other\n\nEnd.\n';
    const after = '# Roadmap\n\n- [x] Tables\n  - [x] Alignment\n  - [ ] Wide tables\n    - [ ] Horizontal scroll\n- [ ] Other\n\nEnd.\n';
    const fragment = await renderMarkdown({path: 'docs/roadmap.md', source: after, groups: changeGroups(diffFile(before, after, 'docs/roadmap.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const title: PageInput['title'] = {repo: 'branch-review-cli', base: 'main', branch: 'feature/rich-view', worktree: false, renderedAt: 0};
    fs.writeFileSync(path.join(pageDir, 'roadmap.html'), assembleFilePage({title, file: {path: 'docs/roadmap.md', status: 'modified', body: {kind: 'rendered', fragment}}, rail: []}));
    // An item of the page, never one in a before view.
    const item = `(text) => [...document.querySelectorAll('.markdown-body li')].find((li) => !li.closest('.br-before-body') && li.querySelector('input').nextSibling.textContent.trim().startsWith(text))`;
    const at = async (x: number, y: number) => [...(await shot({x, y, width: 1, height: 1})).subarray(0, 3)];
    const near = (left: number[], right: number[]) => left.every((value, index) => Math.abs(value - right[index]!) <= 2);
    const rgb = (css: string) => css.match(/\d+/g)!.slice(0, 3).map(Number);
    for (const theme of ['light', 'dark']) {
      await load('m=0&n=902', urlOf('roadmap.html'));
      await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}; scrollTo(0, 0)`);
      await frames();
      // The bar's column, the item's right edge, and the middle of each item's own first line.
      const look = await evaluate<{x: number; right: number; rows: Record<string, number>; modified: string; added: string}>(`(() => {
        const item = ${item};
        const parent = item('Tables');
        const box = parent.getBoundingClientRect();
        const line = (li) => { const r = li.querySelector('input').getBoundingClientRect(); return Math.round(r.top + r.height / 2); };
        return {
          x: Math.round(box.left + parseFloat(getComputedStyle(parent, '::before').left)) + 1,
          right: Math.round(box.right) - 4,
          rows: Object.fromEntries(['Tables', 'Alignment', 'Wide tables', 'Horizontal scroll', 'Other'].map((text) => [text, line(item(text))])),
          modified: getComputedStyle(parent, '::before').backgroundColor,
          added: getComputedStyle(item('Horizontal scroll'), '::before').backgroundColor,
        };
      })()`);
      const [modified, added] = [rgb(look.modified), rgb(look.added)];
      // An unchanged item's row shows the page itself in the bar's column.
      const page = await at(look.x, look.rows['Other']!);
      expect(near(page, modified) || near(page, added), theme).toBe(false);
      const column = async (text: string) => at(look.x, look.rows[text]!);
      expect(near(await column('Tables'), modified), `${theme} Tables`).toBe(true);
      expect(near(await column('Alignment'), modified), `${theme} Alignment`).toBe(true);
      expect(near(await column('Wide tables'), page), `${theme} Wide tables`).toBe(true);
      expect(near(await column('Horizontal scroll'), added), `${theme} Horizontal scroll`).toBe(true);
      // The develop's tint over the item, at full width, stops there too.
      await evaluate(`(() => { const tint = document.createElement('span'); tint.className = 'br-tint br-tint-modified'; tint.style.transform = 'none'; (${item})('Tables').prepend(tint); })()`);
      await frames();
      expect(near(await at(look.right, look.rows['Tables']!), page), `${theme} tint on the item`).toBe(false);
      expect(near(await at(look.right, look.rows['Wide tables']!), page), `${theme} tint under the item`).toBe(true);
    }
  }, 30_000);

  it('keeps a strip with every chip on a 400 px screen, in both themes', async () => {
    const narrow = {width: 400, height: 760};
    // The longest chips a page has: a difference, and links and images that won't resolve.
    const html = fs.readFileSync(path.join(pageDir, 'broken.html'), 'utf8')
      .replace('<summary>≈ GitHub</summary>', '<summary>≈ GitHub · 1 difference</summary>')
      .replace(/<span class="br-findings"([^>]*)>[^<]*<\/span>/, '<span class="br-findings"$1>1 broken link · 2 images won\'t render</span>');
    expect(html).toContain('1 broken link · 2 images won\'t render');
    fs.writeFileSync(path.join(pageDir, 'chips.html'), html);
    await page('Emulation.setDeviceMetricsOverride', {...narrow, deviceScaleFactor: 1, mobile: false});
    try {
      for (const theme of ['light', 'dark']) {
        await load('m=0&n=182', urlOf('chips.html'));
        await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
        const fit = await evaluate<{scroll: number; client: number; right: number}>('({scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, right: Math.max(...[...document.querySelectorAll(".br-strip > *, .br-strip-end > *")].map((each) => each.getBoundingClientRect().right))})');
        expect(fit.scroll, theme).toBeLessThanOrEqual(fit.client);
        expect(fit.right, theme).toBeLessThanOrEqual(narrow.width - 12);
        // Each control still shows whole: no narrower than it is tall.
        const controls = await evaluate<Array<{scroll: number; width: number; height: number}>>('[...document.querySelectorAll(".br-strip-end > button")].map((each) => ({scroll: each.scrollWidth, width: each.offsetWidth, height: each.offsetHeight}))');
        expect(controls).toHaveLength(3);
        for (const control of controls) {
          expect(control.scroll).toBeLessThanOrEqual(control.width);
          expect(control.width).toBeGreaterThanOrEqual(control.height);
        }
      }
    } finally {
      await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    }
  }, 30_000);

  it('shortens the strip\'s chips on a 400 px screen to whole signs and counts, never half a word', async () => {
    const narrow = {width: 400, height: 760};
    await page('Emulation.setDeviceMetricsOverride', {...narrow, deviceScaleFactor: 1, mobile: false});
    try {
      await load('m=0&n=183', urlOf('chips.html'));
      const chips = await evaluate<Array<{scroll: number; client: number; text: string}>>('[".br-fidelity > summary", ".br-findings"].map((selector) => { const chip = document.querySelector(selector); return {scroll: chip.scrollWidth, client: chip.clientWidth, text: chip.textContent}; })');
      for (const chip of chips) expect(chip.scroll, chip.text).toBeLessThanOrEqual(chip.client);
      // The words stay in the page for a screen reader.
      expect(chips.map((chip) => chip.text)).toEqual(['≈ GitHub · 1 difference', '1 broken link · 2 images won\'t render']);
      expect(await evaluate<string>('getComputedStyle(document.querySelector(".br-findings"), "::before").content')).toMatch(/✗ 2/);
    } finally {
      await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    }
  }, 30_000);

  it('keeps a table row\'s before chip out of its cells\' flow, so its column stays aligned and opening it reflows nothing', async () => {
    const before = '# Features\n\n| Feature | Status | Notes |\n| --- | :---: | ---: |\n| Offline mode | done | 12 |\n| Sync | planned | 3 |\n\n- [x] First release\n- [ ] Plugin system\n- [ ] Remote widgets\n';
    const after = before.replace('| Sync | planned | 3 |', '| Sync | in progress | 5 |\n| Themes | planned | 1 |').replace('- [ ] Plugin system', '- [x] Plugin system');
    const fragment = await renderMarkdown({path: 'README.md', source: after, groups: changeGroups(diffFile(before, after, 'README.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const title: PageInput['title'] = {repo: 'project', base: 'main', branch: 'feature', worktree: false, renderedAt: 0};
    fs.writeFileSync(path.join(pageDir, 'rows.html'), assembleFilePage({title, file: {path: 'README.md', status: 'modified', body: {kind: 'rendered', fragment}}, rail: []}));
    // The right edge of each row's last number, the table's box, and the
    // list item's chip, as a reader sees them.
    const measure = `(() => {
      const table = document.querySelector('.markdown-body > table');
      const ends = [...table.querySelectorAll(':scope > tbody > tr')].map((row) => { const range = document.createRange(); range.selectNodeContents(row.lastElementChild.firstChild); return Math.round(range.getBoundingClientRect().right); });
      const box = table.getBoundingClientRect();
      const chip = document.querySelector('.markdown-body li details.br-before > summary').getBoundingClientRect();
      return {ends, table: [Math.round(box.width), Math.round(box.height)], chip: [Math.round(chip.left), Math.round(chip.top)]};
    })()`;
    await load('m=0&n=184', urlOf('rows.html'));
    const closed = await evaluate<{ends: number[]; table: number[]; chip: number[]}>(measure);
    expect(new Set(closed.ends).size, JSON.stringify(closed.ends)).toBe(1);
    await evaluate('for (const chip of document.querySelectorAll(".markdown-body details.br-before")) chip.open = true');
    await frames();
    const open = await evaluate<{ends: number[]; table: number[]; chip: number[]}>(measure);
    expect(open.ends).toEqual(closed.ends);
    expect(open.table).toEqual(closed.table);
    // The list item's chip stays after the item's words, on their line.
    expect(open.chip[0]).toBe(closed.chip[0]);
    expect(Math.abs(open.chip[1]! - closed.chip[1]!)).toBeLessThanOrEqual(3);
    // The old row lies over the rows after it, not under them.
    const onTop = await evaluate<boolean>('(() => { const view = document.querySelector("table .br-before-body").getBoundingClientRect(); return document.elementFromPoint(view.left + view.width / 2, view.top + view.height / 2).closest(".br-before-body") !== null; })()');
    expect(onTop).toBe(true);
  }, 30_000);

  it('puts each table row\'s before chip at the foot of the row\'s last cell, at one place on every row, crossing no border, and leaves the cells their widths', async () => {
    const before = '# Options\n\n| Option | Default | Meaning |\n| --- | --- | --- |\n| `size` | `12` | Size in pixels |\n| `color` | `blue` | Fill color |\n| `label` | none | Accessible name |\n';
    const after = before.replace('Size in pixels', 'Widget size in pixels').replace('`blue`', '`teal`');
    const fragment = await renderMarkdown({path: 'README.md', source: after, groups: changeGroups(diffFile(before, after, 'README.md')), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
    const title: PageInput['title'] = {repo: 'project', base: 'main', branch: 'feature', worktree: false, renderedAt: 0};
    fs.writeFileSync(path.join(pageDir, 'widths.html'), assembleFilePage({title, file: {path: 'README.md', status: 'modified', body: {kind: 'rendered', fragment}}, rail: []}));
    type Shown = {widths: number[][]; chips: Array<{chip: number[]; cell: number[]}>};
    // Each row's cell widths, and each chip's box with its row's last cell's.
    const measure = `(() => {
      const rows = [...document.querySelectorAll('.markdown-body > table > tbody > tr')];
      const box = (element) => { const rect = element.getBoundingClientRect(); return [rect.left, rect.top, rect.right, rect.bottom].map(Math.round); };
      return {
        widths: rows.map((row) => [...row.children].map((cell) => Math.round(cell.getBoundingClientRect().width))),
        chips: rows.flatMap((row) => { const chip = row.querySelector(':scope > :last-child > details.br-before > summary'); return chip ? [{chip: box(chip), cell: box(row.lastElementChild)}] : []; }),
      };
    })()`;
    try {
      for (const width of [VIEW.width, 400]) {
        await page('Emulation.setDeviceMetricsOverride', {width, height: VIEW.height, deviceScaleFactor: 1, mobile: false});
        await load('m=0&n=185', urlOf('widths.html'));
        const shown = await evaluate<Shown>(measure);
        expect(shown.chips, `${width}`).toHaveLength(2);
        for (const {chip, cell} of shown.chips) {
          const [left, top, right, bottom] = cell as [number, number, number, number];
          expect(chip[0]!, `${width} left`).toBeGreaterThanOrEqual(left);
          expect(chip[1]!, `${width} top`).toBeGreaterThanOrEqual(top);
          expect(chip[2]!, `${width} right`).toBeLessThanOrEqual(right);
          expect(chip[3]!, `${width} bottom`).toBeLessThanOrEqual(bottom);
        }
        expect(new Set(shown.chips.map(({chip}) => chip[2])).size, `${width}`).toBe(1);
        // GitHub's widths are the cells' with the marks off, which shows no chip.
        await evaluate('document.documentElement.classList.add("br-marks-off")');
        expect(shown.widths, `${width}`).toEqual((await evaluate<Shown>(measure)).widths);
      }
    } finally {
      await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    }
  }, 30_000);

  it('keeps the words on the GitHub chip and the Changes button on a 400 px screen', async () => {
    await page('Emulation.setDeviceMetricsOverride', {width: 400, height: VIEW.height, deviceScaleFactor: 1, mobile: false});
    try {
      await load('m=0&n=187');
      expect(await evaluate<string>('getComputedStyle(document.querySelector(".br-fidelity > summary"), "::before").content')).toMatch(/^"≈ GitHub"/);
      const word = await evaluate<{width: number; text: string}>('(() => { const word = document.querySelector(".br-marks .br-control-word"); return {width: word.getBoundingClientRect().width, text: word.textContent}; })()');
      expect(word.text).toBe('Changes');
      expect(word.width).toBeGreaterThan(0);
    } finally {
      await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    }
  }, 30_000);

  it('scrolls to a heading from the link GitHub writes for it, #slug, on load and on a later hash', async () => {
    const heading = 'document.getElementById("user-content-how-the-trip-works")';
    const top = `Math.round(${heading}.getBoundingClientRect().top)`;
    await load('how-the-trip-works');
    expect(await evaluate<number>('scrollY')).toBeGreaterThan(0);
    // Under the strip, at the page's scroll padding.
    expect(await evaluate<number>(top)).toBe(52);
    await load('m=0&n=186');
    expect(await evaluate<number>('scrollY')).toBe(0);
    await evaluate('location.hash = "how-the-trip-works"');
    await frames();
    expect(await evaluate<number>(top)).toBe(52);
    // A slug that names no heading leaves the page where it is.
    await evaluate('scrollTo(0, 0); location.hash = "no-such-heading"');
    await frames();
    expect(await evaluate<number>('scrollY')).toBe(0);
  }, 30_000);

  it('fits a narrow screen: a forced theme keeps its lengths, the popover stays on screen, and the raw lines wrap', async () => {
    const narrow = {width: 400, height: 760};
    await page('Emulation.setDeviceMetricsOverride', {...narrow, deviceScaleFactor: 1, mobile: false});
    try {
      await load('m=0&n=160');
      const padding = 'getComputedStyle(document.querySelector(".br-main > article.markdown-body")).paddingLeft';
      expect(await evaluate<string>(padding)).toBe('15px');
      for (const theme of ['light', 'dark']) {
        await key('t');
        expect(await evaluate<string>('document.documentElement.dataset.theme')).toBe(theme);
        expect(await evaluate<string>(padding), theme).toBe('15px');
      }
      await key('t');

      for (const name of ['page.html', 'overview.html']) {
        await load('m=0&n=161', urlOf(name));
        await evaluate('document.querySelector("details.br-fidelity").open = true');
        const box = await evaluate<{left: number; right: number}>('(() => { const rect = document.querySelector(".br-popover").getBoundingClientRect(); return {left: rect.left, right: rect.right}; })()');
        expect(box.left, name).toBeGreaterThanOrEqual(0);
        expect(box.right, name).toBeLessThanOrEqual(narrow.width);
      }

      await withPageScript(HOLD_DEADLINE, () => load('at=L7&f=0.3&d=full&m=1&n=162'));
      await evaluate('document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; })');
      const rows = await evaluate<Array<{text: string; top: number; bottom: number; cut: boolean}>>('[...document.querySelectorAll(".br-veil-line:not(.br-veil-removed)")].map((row) => { const rect = row.getBoundingClientRect(); return {text: row.textContent, top: rect.top, bottom: rect.bottom, cut: row.scrollWidth > row.clientWidth + 1 || row.querySelector(".br-veil-text").getBoundingClientRect().right > rect.right + 1}; })');
      expect(rows.filter((row) => row.cut).map((row) => row.text)).toEqual([]);
      // A long line takes more than one row's height, and the next starts under it.
      expect(rows.some((row) => row.bottom - row.top > 30)).toBe(true);
      for (const [index, row] of rows.slice(1).entries()) expect(row.top).toBeGreaterThanOrEqual(rows[index]!.bottom - 0.5);
      await key('Shift');
    } finally {
      await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    }
  }, 30_000);
});
