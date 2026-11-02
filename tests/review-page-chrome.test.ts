import fs from 'node:fs';
import path from 'node:path';
import {spawn, type ChildProcess} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {REVIEW_SCRIPT} from '../src/rendered/assets.generated.js';
import {changeGroups} from '../src/rendered/changes.js';
import {renderMarkdown} from '../src/rendered/markdown.js';
import {drawHunk, escapeText, parseHunks} from '../src/rendered/review/diff.js';
import {assembleReviewPage, type ReviewPageCard} from '../src/rendered/review/page.js';
import {createRenderedService} from '../src/rendered/service.js';
import {createRenderedSite} from '../src/rendered/site.js';
import {prepareStartup} from '../src/startup.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';
import {inProcessBackend, mockBranchRepo} from './review-fixture.js';
import {diffFile} from './rendered-helpers.js';

// The Review in browser page's script in a real browser, on the page the
// worker's jobs make for a branch shaped like the approved mock: its policy
// holds with nothing blocked and no host reached, a trip's hash opens a
// card and glows it once, a later hash moves the same page without a
// reload, the keys, Viewed kept in this browser, Unified and Split, context
// to expand, Source and Rich, a link between files, the theme, the menu,
// the shortcuts, the image modes, and the page with scripting off.
// Opt-in: BRANCH_REVIEW_TEST_CHROME names a Chromium or chrome-headless-shell
// binary. It runs headless with no network (every host resolves to nothing)
// in a profile of its own, driven over --remote-debugging-pipe.

const CHROME = process.env.BRANCH_REVIEW_TEST_CHROME;
const VIEW = {width: 1440, height: 900};

type Message = {id?: number; method?: string; sessionId?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: {message: string}};

// Just enough of the DevTools protocol over the pipe: NUL-terminated JSON.
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
  return {send, listeners};
}

describe.skipIf(!CHROME)('the Review in browser page in a real Chromium', () => {
  let child: ChildProcess;
  let session = '';
  let send: ReturnType<typeof cdp>['send'];
  let listeners: ReturnType<typeof cdp>['listeners'];
  let pageUrl = '';
  let cards: string[] = [];
  const requests: string[] = [];

  const page = (method: string, params: Record<string, unknown> = {}) => send(method, params, session);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const answer = await page('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true}) as {result: {value: T}; exceptionDetails?: unknown};
    if (answer.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(answer.exceptionDetails)}`);
    return answer.result.value;
  };
  const loaded = () => new Promise<void>((resolve) => {
    const listener = (message: Message) => {
      if (message.method !== 'Page.loadEventFired' || message.sessionId !== session) return;
      listeners.delete(listener);
      resolve();
    };
    listeners.add(listener);
  });
  // `settle`: wait two frames for the page script's arrival, which a page
  // with scripting off can't.
  const load = async (hash: string, url = pageUrl, settle = true) => {
    const blank = loaded();
    await page('Page.navigate', {url: 'about:blank'});
    await blank;
    const done = loaded();
    await page('Page.navigate', {url: `${url}#${hash}`});
    await done;
    if (settle) await frames();
  };
  let headOnlyUrl = '';
  let tableUrl = '';
  let longUrl = '';
  let longerUrl = '';
  const reload = async () => {
    const done = loaded();
    await page('Page.reload');
    await done;
    await frames();
  };
  const key = async (value: string) => {
    await page('Input.dispatchKeyEvent', {type: 'keyDown', key: value, ...(value.length === 1 ? {text: value} : {})});
    await page('Input.dispatchKeyEvent', {type: 'keyUp', key: value});
    await frames();
  };
  const frames = () => evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const click = async (selector: string) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await frames();
  };
  const index = (file: string) => cards.indexOf(file);
  // How far a card's top is below the sticky toolbar.
  const cardTop = (at: number) => evaluate<number>(`Math.round(document.getElementById('file-${at}').getBoundingClientRect().top - document.getElementById('toolbar').getBoundingClientRect().bottom)`);
  const current = () => evaluate<string | null>('document.querySelector(".rv-file.rv-on")?.closest("li").dataset.path ?? null');
  // How far a file's card is below the sticky toolbar, by its path.
  const topOf = (file: string) => evaluate<number>(`Math.round(document.querySelector('.rv-card[aria-label="${file}"]').getBoundingClientRect().top - document.getElementById('toolbar').getBoundingClientRect().bottom)`);
  const width = async (value: number) => {
    await page('Emulation.setDeviceMetricsOverride', {...VIEW, width: value, deviceScaleFactor: 1, mobile: false});
    await frames();
  };

  beforeAll(async () => {
    const cwd = mockBranchRepo();
    const {range, review} = await prepareStartup({cwd, options: {requestedBranch: 'feature/docs-refresh', requestedBase: 'main', watch: false, watchPoll: false, animations: false}, width: 100});
    cards = review.files.map((file) => file.path);
    const dir = makeTempDir('branch-review-review-chrome-');
    const shown: string[] = [];
    const service = createRenderedService({backend: inProcessBackend(), site: createRenderedSite({tempDir: () => dir}), surface: {kind: 'browser', refusal: null, destination: 'in your browser', show: async (url) => {
      shown.push(url);
      return {where: 'browser', message: 'opened in your browser'};
    }}});
    service.setReview(review, {cwd, range});
    await service.openOverview();
    // The page the next press gets, once nothing on it is still on its way.
    let written = fileURLToPath(shown[0]!.split('#')[0]!);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const outcome = await service.page();
      if (outcome.ok && !outcome.partial) {
        written = fileURLToPath(outcome.url);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    service.dispose();
    // A copy outside the session dir, which the service removes nothing from here.
    fs.copyFileSync(written, path.join(dir, 'page.html'));
    pageUrl = pathToFileURL(path.join(dir, 'page.html')).href;
    // The page as it is before its page script runs: the head script alone.
    fs.writeFileSync(path.join(dir, 'head-only.html'), fs.readFileSync(path.join(dir, 'page.html'), 'utf8').replace(`<script>${REVIEW_SCRIPT}</script>`, ''));
    headOnlyUrl = pathToFileURL(path.join(dir, 'head-only.html')).href;
    fs.writeFileSync(path.join(dir, 'table.html'), await tablePage());
    tableUrl = pathToFileURL(path.join(dir, 'table.html')).href;
    fs.writeFileSync(path.join(dir, 'long.html'), longPage());
    longUrl = pathToFileURL(path.join(dir, 'long.html')).href;
    fs.writeFileSync(path.join(dir, 'longer.html'), longPage(['CHANGELOG.md']));
    longerUrl = pathToFileURL(path.join(dir, 'longer.html')).href;

    child = spawn(CHROME!, [
      '--headless', '--remote-debugging-pipe', `--user-data-dir=${path.join(dir, 'profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--no-pings',
      '--disable-background-networking', '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND',
      '--hide-scrollbars', '--force-device-scale-factor=1', '--disable-gpu',
    ], {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
    ({send, listeners} = cdp(child));
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'}) as {targetId: string};
    ({sessionId: session} = await send('Target.attachToTarget', {targetId, flatten: true}) as {sessionId: string});
    listeners.add((message) => {
      if (message.method !== 'Network.requestWillBeSent' || message.sessionId !== session) return;
      const url = String((message.params?.request as {url?: string})?.url ?? '');
      if (!url.startsWith('file:') && !url.startsWith('data:') && url !== 'about:blank') requests.push(url);
    });
    await page('Page.enable');
    await page('Network.enable');
    await page('Page.bringToFront');
    await page('Emulation.setFocusEmulationEnabled', {enabled: true});
    await page('Emulation.setDeviceMetricsOverride', {...VIEW, deviceScaleFactor: 1, mobile: false});
    await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}, {name: 'prefers-color-scheme', value: 'light'}]});
    // Every policy violation the page meets, from before its own scripts run.
    await page('Page.addScriptToEvaluateOnNewDocument', {source: 'window.__violations = []; document.addEventListener("securitypolicyviolation", (event) => window.__violations.push(event.violatedDirective));'});
  }, 90_000);

  afterAll(() => {
    child?.kill('SIGKILL');
    cleanupTempDirs();
  });

  it('runs under its own policy with nothing blocked and no host reached, and opens at the card a trip names, glowing it once', async () => {
    const cli = index('src/cli.ts');
    await load(`file-${cli}&m=0&n=1`);
    expect(await evaluate('document.documentElement.classList.contains("rv-live")')).toBe(true);
    expect(await evaluate('window.__violations')).toEqual([]);
    expect(requests).toEqual([]);
    expect(Math.abs(await cardTop(cli))).toBeLessThanOrEqual(14);
    expect(await evaluate(`document.getElementById('file-${cli}').classList.contains('rv-flash')`)).toBe(true);
    expect(await current()).toBe('src/cli.ts');
    await evaluate('new Promise((resolve) => setTimeout(resolve, 1500))');
    expect(await evaluate(`document.getElementById('file-${cli}').classList.contains('rv-flash')`)).toBe(false);
  });

  it('moves to the card a later trip names without reloading, as a reused split hears it, and to the top for R', async () => {
    await load(`file-${index('src/cli.ts')}&m=0&n=1`);
    await evaluate('window.__stayed = true');
    const readme = index('README.md');
    await evaluate(`location.hash = 'file-${readme}&m=0&n=2'`);
    await frames();
    expect(Math.abs(await cardTop(readme))).toBeLessThanOrEqual(14);
    expect(await current()).toBe('README.md');
    await evaluate("location.hash = 'top&m=0&n=3'");
    await frames();
    expect(await evaluate('scrollY')).toBe(0);
    expect(await evaluate('window.__stayed')).toBe(true);
  });

  it('steps through the files with j and k, and v marks one viewed, folds it and moves on', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    await key('j');
    expect(await current()).toBe(cards[1]);
    await key('k');
    expect(await current()).toBe(cards[0]);
    await key('v');
    expect(await evaluate('document.getElementById("file-0").className')).toContain('rv-is-viewed');
    expect(await evaluate('document.getElementById("file-0").className')).toContain('rv-collapsed');
    expect(await evaluate('document.getElementById("viewed-n").textContent')).toBe('1');
    expect(await current()).toBe(cards[1]);
  });

  it('keeps a viewed mark in this browser across a reload, and drops one made on an earlier diff of the file', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    await click('#file-2 [data-act="viewed"]');
    await reload();
    expect(await evaluate('document.getElementById("file-2").className')).toContain('rv-is-viewed');
    expect(await evaluate('document.querySelector(\'.rv-file[data-i="2"]\').className')).toContain('rv-is-viewed');
    // The same file's mark, made when its diff was another.
    await evaluate('(() => { const key = Object.keys(localStorage).find((name) => name.startsWith("branch-review:viewed:")); const marks = JSON.parse(localStorage.getItem(key)); for (const name of Object.keys(marks)) marks[name] = "an-earlier-diff"; localStorage.setItem(key, JSON.stringify(marks)); })()');
    await reload();
    expect(await evaluate('document.querySelectorAll(".rv-card.rv-is-viewed").length')).toBe(0);
    expect(await evaluate('Object.values(JSON.parse(localStorage.getItem(Object.keys(localStorage).find((name) => name.startsWith("branch-review:viewed:"))))).length')).toBe(0);
  });

  it('draws every diff side by side in Split, back in Unified, and keeps the layout across a reload', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    const cli = index('src/cli.ts');
    await click('[data-act="mode"][data-m="split"]');
    expect(await evaluate(`document.querySelector('#file-${cli} table.diff').className`)).toBe('diff split');
    // A removed line and the line that replaced it share a row.
    expect(await evaluate(`[...document.querySelectorAll('#file-${cli} tr')].some((row) => row.querySelector('td.cd.del') && row.querySelector('td.cd.add'))`)).toBe(true);
    await reload();
    expect(await evaluate(`document.querySelector('#file-${cli} table.diff').className`)).toBe('diff split');
    await click('[data-act="mode"][data-m="unified"]');
    expect(await evaluate(`document.querySelector('#file-${cli} table.diff').className`)).toBe('diff uni');
  });

  it('reveals five lines of context a click, then the rest of a short gap, numbered on both sides', async () => {
    await load('top&m=0&n=1');
    const cli = index('src/cli.ts');
    const rows = () => evaluate<number>(`document.querySelectorAll('#file-${cli} tr:not(.hdr)').length`);
    const before = await rows();
    await click(`#file-${cli} [data-act="expand"][data-g="1"]`);
    expect(await rows()).toBe(before + 5);
    await click(`#file-${cli} [data-act="expand"][data-g="1"]`);
    expect(await rows()).toBe(before + 10);
    // Lines 16 to 27 hid between the hunks: twelve, so the third click shows the last two.
    await click(`#file-${cli} [data-act="expand"][data-g="1"]`);
    expect(await rows()).toBe(before + 12);
    expect(await evaluate(`document.querySelectorAll('#file-${cli} [data-act="expand"][data-g="1"]').length`)).toBe(0);
    expect(await evaluate(`[...document.querySelectorAll('#file-${cli} td.ln')].some((cell) => cell.dataset.n === '16')`)).toBe(true);
  });

  it('switches a markdown card to its rich view, where a link to another file in the review opens that file\'s card', async () => {
    await load('top&m=0&n=1');
    const readme = index('README.md');
    await click(`#file-${readme} [data-act="view"][data-v="rich"]`);
    expect(await evaluate(`document.querySelector('#file-${readme} .rv-v-rich').hidden`)).toBe(false);
    expect(await evaluate(`document.querySelector('#file-${readme} .rv-v-src').hidden`)).toBe(true);
    expect(await evaluate(`document.querySelectorAll('#file-${readme} .markdown-body [data-mark]').length`)).toBeGreaterThan(0);
    await click(`#file-${readme} .markdown-body a[href^="f-"]`);
    const guide = index('docs/guide.md');
    expect(await current()).toBe('docs/guide.md');
    expect(await evaluate(`document.querySelector('#file-${guide} .rv-v-rich').hidden`)).toBe(false);
    expect(await evaluate('location.href')).toContain(pageUrl);
  });

  it('forces a theme from the switch, and applies it from the first frame of the next load', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    await click('[data-theme-set="dark"]');
    expect(await evaluate('document.documentElement.dataset.theme')).toBe('dark');
    expect(await evaluate('getComputedStyle(document.body).backgroundColor')).toBe('rgb(13, 17, 23)');
    // Without the page script, the head script alone sets it, ahead of the stylesheet.
    await load('top&m=0&n=1', headOnlyUrl);
    expect(await evaluate('document.documentElement.dataset.theme')).toBe('dark');
    expect(await evaluate('getComputedStyle(document.body).backgroundColor')).toBe('rgb(13, 17, 23)');
    await load('top&m=0&n=1');
    await click('[data-theme-set="auto"]');
    expect(await evaluate('document.documentElement.hasAttribute("data-theme")')).toBe(false);
  });

  it('opens the shortcuts on ? and closes them on Esc, and the menu marks viewed and folds every file', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    await key('?');
    expect(await evaluate('document.getElementById("keys").hidden')).toBe(false);
    await key('Escape');
    expect(await evaluate('document.getElementById("keys").hidden')).toBe(true);
    await click('#file-3 [data-act="menu"]');
    expect(await evaluate('document.getElementById("menu").hidden')).toBe(false);
    await click('[data-menu="viewed"]');
    expect(await evaluate('document.getElementById("file-3").className')).toContain('rv-is-viewed');
    await click('#file-0 [data-act="menu"]');
    await click('[data-menu="collapse-all"]');
    expect(await evaluate('document.querySelectorAll(".rv-card:not(.rv-collapsed)").length')).toBe(0);
    await click('#file-0 [data-act="menu"]');
    await click('[data-menu="expand-all"]');
    expect(await evaluate('document.querySelectorAll(".rv-card.rv-collapsed").length')).toBe(0);
  });

  it('filters the tree by path, and says when nothing matches', async () => {
    await load('top&m=0&n=1');
    await evaluate('(() => { const input = document.getElementById("file-filter"); input.value = "cli"; input.dispatchEvent(new Event("input")); })()');
    expect(await evaluate('[...document.querySelectorAll("#tree li[data-path]")].filter((item) => !item.hidden).map((item) => item.dataset.path)')).toEqual(['src/cli.ts']);
    await evaluate('(() => { const input = document.getElementById("file-filter"); input.value = "nothing-like-it"; input.dispatchEvent(new Event("input")); })()');
    expect(await evaluate('document.getElementById("tree-empty").hidden')).toBe(false);
  });

  it('compares the image in swipe and onion skin, each moved by its control', async () => {
    await load('top&m=0&n=1');
    const hero = index('img/hero.png');
    await click(`#file-${hero} [data-im="swipe"]`);
    expect(await evaluate(`document.querySelector('#file-${hero} [data-im-panel="swipe"]').hidden`)).toBe(false);
    expect(await evaluate(`document.querySelector('#file-${hero} .rv-swipe').getBoundingClientRect().height`)).toBeGreaterThan(50);
    await evaluate(`document.querySelector('#file-${hero} .rv-handle').focus()`);
    await key('ArrowLeft');
    expect(await evaluate(`document.querySelector('#file-${hero} .rv-handle').getAttribute('aria-valuenow')`)).toBe('45');
    await click(`#file-${hero} [data-im="onion"]`);
    await evaluate(`(() => { const range = document.querySelector('#file-${hero} .rv-onion-ctl input'); range.value = '80'; range.dispatchEvent(new Event('input')); })()`);
    expect(await evaluate(`getComputedStyle(document.querySelector('#file-${hero} .rv-onion .rv-after')).opacity`)).toBe('0.8');
  });

  it('shows its unified diffs with scripting off, and hides the controls that need the script', async () => {
    await page('Emulation.setScriptExecutionDisabled', {value: true});
    try {
      await load('top&m=0&n=1', pageUrl, false);
      expect(await evaluate('document.documentElement.classList.contains("rv-live")')).toBe(false);
      expect(await evaluate('document.querySelectorAll("table.diff.uni").length')).toBeGreaterThan(3);
      expect(await evaluate('getComputedStyle(document.querySelector(".rv-viewed-btn")).display')).toBe('none');
      expect(await evaluate('getComputedStyle(document.querySelector(".rv-mode")).display')).toBe('none');
    } finally {
      await page('Emulation.setScriptExecutionDisabled', {value: false});
    }
  });
  it('remembers a dismissed note across a reload', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    expect(await evaluate('document.getElementById("note").hidden')).toBe(false);
    await click('[data-act="dismiss"]');
    await reload();
    expect(await evaluate('document.getElementById("note").hidden')).toBe(true);
  });

  it('closes the card menu on Esc and gives focus back to its button', async () => {
    await load('top&m=0&n=1');
    await click('#file-1 [data-act="menu"]');
    expect(await evaluate('document.getElementById("menu").hidden')).toBe(false);
    await key('Escape');
    expect(await evaluate('document.getElementById("menu").hidden')).toBe(true);
    expect(await evaluate('document.activeElement === document.querySelector("#file-1 [data-act=menu]")')).toBe(true);
  });

  it('hides the file tree from its toggle, and Show in file tree brings it back at the file', async () => {
    await load('top&m=0&n=1');
    const shown = () => evaluate<string>('getComputedStyle(document.getElementById("sidebar")).display');
    expect(await shown()).not.toBe('none');
    await click('[data-act="tree"]');
    expect(await shown()).toBe('none');
    expect(await evaluate('document.querySelector("[data-act=tree]").getAttribute("aria-expanded")')).toBe('false');
    await click('#file-2 [data-act="menu"]');
    await click('[data-menu="tree"]');
    expect(await shown()).not.toBe('none');
    expect(await current()).toBe(cards[2]);
  });

  it('shows the commits in their own tab, and the files again from theirs', async () => {
    await load('top&m=0&n=1');
    await click('[data-tab="commits"]');
    expect(await evaluate('document.getElementById("panel-commits").hidden')).toBe(false);
    expect(await evaluate('document.getElementById("panel-files").hidden')).toBe(true);
    expect(await evaluate('document.querySelectorAll("#panel-commits .rv-msg").length')).toBe(2);
    await click('[data-tab="files"]');
    expect(await evaluate('document.getElementById("panel-files").hidden')).toBe(false);
  });

  it('jumps without motion when the system asks for less, and glides when it doesn\'t', async () => {
    const target = index('src/cli.ts');
    await load('top&m=1&n=1');
    await key('j');
    for (let at = 1; at < target; at += 1) await key('j');
    expect(Math.abs(await cardTop(target))).toBeLessThanOrEqual(14);
    await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}, {name: 'prefers-color-scheme', value: 'light'}]});
    try {
      await load('top&m=1&n=1');
      await evaluate(`(() => { window.__tops = []; const card = document.getElementById('file-${target}'); const watch = () => { window.__tops.push(card.getBoundingClientRect().top); if (window.__tops.length < 40) requestAnimationFrame(watch); }; requestAnimationFrame(watch); })()`);
      await evaluate(`document.querySelector('.rv-file[data-i="${target}"]').click()`);
      await evaluate('new Promise((resolve) => setTimeout(resolve, 900))');
      const tops = await evaluate<number[]>('window.__tops');
      // On its way through more than one frame: no jump straight there.
      expect(new Set(tops.map((top) => Math.round(top))).size).toBeGreaterThan(3);
    } finally {
      await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}, {name: 'prefers-color-scheme', value: 'light'}]});
    }
  });

  it('says the path it copied, or when the browser keeps the clipboard, the path itself', async () => {
    await load('top&m=0&n=1');
    const pkg = index('package.json');
    await click(`#file-${pkg} [data-act="copy"]`);
    await evaluate('new Promise((resolve) => setTimeout(resolve, 100))');
    expect(await evaluate('document.getElementById("toast").textContent')).toMatch(/^(Copied|Path:) package\.json$/);
    expect(await evaluate('document.getElementById("toast").hidden')).toBe(false);
  });

  it('lands a live refresh where the reader was, with no glow', async () => {
    await load('top&m=0&n=1');
    const hero = index('img/hero.png');
    await evaluate(`(() => { const card = document.getElementById('file-${hero}'); scrollTo({top: card.getBoundingClientRect().top + scrollY + 40, behavior: 'auto'}); })()`);
    await frames();
    await frames();
    const before = await cardTop(hero);
    // The newest page, sent by a watch refresh at the card the press opened.
    await load(`file-0&m=1&n=2&l=1`);
    expect(Math.abs((await cardTop(hero)) - before)).toBeLessThanOrEqual(2);
    expect(await current()).toBe('img/hero.png');
    expect(await evaluate('document.querySelectorAll(".rv-flash").length')).toBe(0);
  });

  it('hugs a small picture with its frame in 2-up, and gives the dark state pill white text at 4.5:1', async () => {
    await evaluate('localStorage.clear()');
    await load('top&m=0&n=1');
    const hero = index('img/hero.png');
    const sizes = await evaluate<Array<{frame: number; picture: number}>>(`[...document.querySelectorAll('#file-${hero} .rv-two-up .rv-frame')].map((frame) => ({frame: frame.getBoundingClientRect().width, picture: frame.querySelector('img').getBoundingClientRect().width}))`);
    expect(sizes).toHaveLength(2);
    for (const {frame, picture} of sizes) expect(frame - picture).toBeLessThanOrEqual(2);
    await click('[data-theme-set="dark"]');
    expect(await evaluate('getComputedStyle(document.querySelector(".rv-state")).backgroundColor')).toBe('rgb(35, 134, 54)');
    await click('[data-theme-set="auto"]');
  });

  it('draws a changed table as one block: one bar, tinted rows, no chip in a cell, and one before chip that opens the old table in the flow', async () => {
    await load('file-0&m=0&n=1', tableUrl);
    await click('#file-0 [data-act="view"][data-v="rich"]');
    const table = '#file-0 .markdown-body > table';
    expect(await evaluate(`document.querySelector('${table}').className`)).toContain('rv-tchanged');
    expect(await evaluate(`document.querySelectorAll('#file-0 :is(td, th) > details.br-before').length`)).toBe(0);
    // One bar: the table's, none on its rows.
    expect(await evaluate(`getComputedStyle(document.querySelector('${table}'), '::before').width`)).toBe('3px');
    expect(await evaluate(`[...document.querySelectorAll('${table} tr[data-mark] > :first-child')].map((cell) => getComputedStyle(cell, '::before').content)`)).toEqual(['none', 'none', 'none', 'none']);
    // Every body row as tall as the next: no chip makes one taller.
    const heights = await evaluate<number[]>(`[...document.querySelectorAll('${table} tbody > tr')].map((row) => Math.round(row.getBoundingClientRect().height))`);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1);
    expect(await evaluate(`getComputedStyle(document.querySelector('${table} tr[data-mark="added"] > td')).backgroundColor`)).toBe('rgb(230, 255, 236)');
    const chip = `${table} + details.rv-tbefore`;
    expect(await evaluate(`document.querySelectorAll('#file-0 details.rv-tbefore').length`)).toBe(1);
    const next = () => evaluate<number>(`Math.round(document.querySelector('${chip}').nextElementSibling.getBoundingClientRect().top)`);
    const closed = await next();
    await click(`${chip} > summary`);
    // The old table, in the flow: what follows moves down past it.
    expect(await next()).toBeGreaterThan(closed + 60);
    expect(await evaluate(`getComputedStyle(document.querySelector('${chip} > .br-before-body')).position`)).toBe('static');
    expect(await evaluate(`[...document.querySelectorAll('${chip} .br-before-body thead th')].map((cell) => cell.textContent)`)).toEqual(['Key', 'Default']);
    expect(await evaluate(`[...document.querySelectorAll('${chip} .br-before-body tbody tr')].map((row) => row.firstElementChild.textContent)`)).toEqual(['theme', 'width']);
  });

  it('puts a changed paragraph\'s before chip at the end of its last line, in the attention colors, its old text opening under it', async () => {
    await load('file-0&m=0&n=1', tableUrl);
    await click('#file-0 [data-act="view"][data-v="rich"]');
    const paragraph = '#file-0 .markdown-body > p[data-mark="modified"]';
    expect(await evaluate(`document.querySelector('${paragraph} > .rv-chip-before').textContent`)).toBe('before');
    expect(await evaluate(`getComputedStyle(document.querySelector('${paragraph}')).paddingBottom`)).toBe('0px');
    expect(await evaluate(`getComputedStyle(document.querySelector('${paragraph} > .rv-chip-before')).backgroundColor`)).toBe('rgb(255, 248, 197)');
    const box = `${paragraph} + details.br-before`;
    expect(await evaluate(`getComputedStyle(document.querySelector('${box}')).display`)).toBe('none');
    await click(`${paragraph} > .rv-chip-before`);
    expect(await evaluate(`document.querySelector('${box}').open`)).toBe(true);
    expect(await evaluate(`document.querySelector('${paragraph} > .rv-chip-before').getAttribute('aria-expanded')`)).toBe('true');
    expect(await evaluate(`document.querySelector('${box} .br-before-body').textContent`)).toContain('A small widget.');
    expect(await evaluate(`getComputedStyle(document.querySelector('${box} .br-before-body'), '::before').content`)).toBe('"Before"');
    // A code block has no line of text to end: its chip sits in its corner.
    expect(await evaluate('document.querySelectorAll("#file-0 .markdown-body [data-mark=modified] > .rv-chip-before.rv-corner").length')).toBe(1);
  });

  it('works with storage blocked: the head script, v, the theme switch, Split and the note, with no exception', async () => {
    const {identifier} = await page('Page.addScriptToEvaluateOnNewDocument', {source: 'window.__errors = []; addEventListener("error", (event) => window.__errors.push(String(event.message))); for (const name of ["localStorage", "sessionStorage"]) Object.defineProperty(window, name, {configurable: true, get() { throw new DOMException("blocked", "SecurityError"); }});'}) as {identifier: string};
    try {
      await load('top&m=0&n=1', headOnlyUrl);
      expect(await evaluate('window.__errors')).toEqual([]);
      await load('top&m=0&n=1');
      expect(await evaluate('window.__errors')).toEqual([]);
      expect(await evaluate('document.documentElement.classList.contains("rv-live")')).toBe(true);
      await key('v');
      expect(await evaluate('document.getElementById("viewed-n").textContent')).toBe('1');
      await click('[data-theme-set="dark"]');
      expect(await evaluate('document.documentElement.dataset.theme')).toBe('dark');
      await click('[data-act="mode"][data-m="split"]');
      expect(await evaluate('document.querySelectorAll("table.diff.split").length')).toBeGreaterThan(2);
      await click('[data-act="dismiss"]');
      expect(await evaluate('document.getElementById("note").hidden')).toBe(true);
      await evaluate('window.scrollBy(0, 400)');
      await frames();
      expect(await evaluate('window.__errors')).toEqual([]);
    } finally {
      await page('Page.removeScriptToEvaluateOnNewDocument', {identifier});
    }
  });

  it('moves the after picture with the swipe handle', async () => {
    await load('top&m=0&n=1');
    const hero = index('img/hero.png');
    await click(`#file-${hero} [data-im="swipe"]`);
    await evaluate(`document.querySelector('#file-${hero} .rv-handle').focus()`);
    await key('ArrowLeft');
    expect(await evaluate(`getComputedStyle(document.querySelector('#file-${hero} .rv-swipe .rv-after')).clipPath`)).toBe('inset(0px 0px 0px 45%)');
    expect(await evaluate(`Math.round(document.querySelector('#file-${hero} .rv-handle').getBoundingClientRect().left - document.querySelector('#file-${hero} .rv-swipe').getBoundingClientRect().left)`)).toBe(await evaluate(`Math.round(document.querySelector('#file-${hero} .rv-swipe').getBoundingClientRect().width * 0.45) - 1`));
  });

  it('filters the tree whatever the case of the query', async () => {
    await load('top&m=0&n=1');
    await evaluate('(() => { const input = document.getElementById("file-filter"); input.value = "CLI.TS"; input.dispatchEvent(new Event("input")); })()');
    expect(await evaluate('[...document.querySelectorAll("#tree li[data-path]")].filter((item) => !item.hidden).map((item) => item.dataset.path)')).toEqual(['src/cli.ts']);
  });

  it('scrolls a long tree to the file Show in file tree names', async () => {
    await load('top&m=0&n=1', longUrl);
    const last = 'src/part-39/index.ts';
    const inTree = () => evaluate<boolean>(`(() => { const tree = document.getElementById('tree').getBoundingClientRect(); const row = document.querySelector('#tree li[data-path="${last}"] .rv-file').getBoundingClientRect(); return row.top >= tree.top && row.bottom <= tree.bottom; })()`);
    expect(await inTree()).toBe(false);
    await click('.rv-card[aria-label="src/part-39/index.ts"] [data-act="menu"]');
    await click('[data-menu="tree"]');
    expect(await inTree()).toBe(true);
    expect(await current()).toBe(last);
  });

  it('closes the narrow file list on Esc', async () => {
    await width(800);
    try {
      await load('top&m=0&n=1');
      await click('[data-act="tree"]');
      expect(await evaluate('document.getElementById("sidebar").classList.contains("rv-open")')).toBe(true);
      await key('Escape');
      expect(await evaluate('document.getElementById("sidebar").classList.contains("rv-open")')).toBe(false);
      expect(await evaluate('getComputedStyle(document.getElementById("sidebar")).display')).toBe('none');
    } finally {
      await width(VIEW.width);
    }
  });

  it('says the path it copied when the browser lets it write the clipboard', async () => {
    await send('Browser.grantPermissions', {permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']});
    try {
      await load('top&m=0&n=1');
      const pkg = index('package.json');
      await click(`#file-${pkg} [data-act="copy"]`);
      await evaluate('new Promise((resolve) => setTimeout(resolve, 200))');
      expect(await evaluate('document.getElementById("toast").textContent')).toBe('Copied package.json');
    } finally {
      await send('Browser.resetPermissions');
    }
  });

  it('grows a row of the link report with its text when it wraps', async () => {
    await width(400);
    try {
      await load('top&m=0&n=1', longUrl);
      const rows = await evaluate<Array<{scroll: number; client: number}>>('[...document.querySelectorAll("#report .rv-row")].map((row) => ({scroll: row.scrollHeight, client: row.clientHeight}))');
      expect(rows.length).toBe(1);
      expect(rows[0]!.client).toBeGreaterThan(30);
      for (const row of rows) expect(row.scroll).toBeLessThanOrEqual(row.client + 1);
      expect(await evaluate<number>('document.getElementById("report").scrollHeight - document.getElementById("report").clientHeight')).toBeLessThanOrEqual(1);
    } finally {
      await width(VIEW.width);
    }
  });

  it('draws the current file\'s bar inside its row, at the top of the tree as deep in it', async () => {
    await load('file-0&m=0&n=1', longUrl);
    expect(await current()).toBe('README.md');
    const bar = () => evaluate<number>('(() => { const row = document.querySelector(".rv-file.rv-on"); return Math.round(row.getBoundingClientRect().left + parseFloat(getComputedStyle(row, "::before").left) - document.getElementById("tree").getBoundingClientRect().left); })()');
    expect(await bar()).toBeGreaterThanOrEqual(0);
    await load('file-1&m=0&n=1', longUrl);
    expect(await bar()).toBeGreaterThanOrEqual(0);
  });

  it('marks the words a changed paragraph gained in its rich view', async () => {
    await load('file-0&m=0&n=1', tableUrl);
    await click('#file-0 [data-act="view"][data-v="rich"]');
    const paragraph = '#file-0 .markdown-body > p[data-mark="modified"]';
    expect(await evaluate(`[...document.querySelectorAll('${paragraph} ins.rv-word')].map((mark) => mark.textContent)`)).toEqual([', now with tables']);
    expect(await evaluate(`document.querySelector('${paragraph}').textContent`)).toBe('A small widget, now with tables.before');
    expect(await evaluate(`getComputedStyle(document.querySelector('${paragraph} ins.rv-word')).backgroundColor`)).toBe('rgb(171, 242, 188)');
  });

  it('lands at once on a fresh page\'s card, and glides only on a later trip', async () => {
    await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'no-preference'}, {name: 'prefers-color-scheme', value: 'light'}]});
    try {
      await load('file-20&m=1&n=1', longUrl);
      expect(Math.abs(await topOf('src/part-19/index.ts'))).toBeLessThanOrEqual(14);
      await evaluate("location.hash = 'file-1&m=1&n=2'");
      await frames();
      expect(Math.abs(await topOf('src/part-00/index.ts'))).toBeGreaterThan(14);
    } finally {
      await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-reduced-motion', value: 'reduce'}, {name: 'prefers-color-scheme', value: 'light'}]});
    }
  });

  it('lands a live refresh at the reader\'s file on a newer page with a file added above it', async () => {
    await load('top&m=0&n=1', longUrl);
    const file = 'src/part-05/index.ts';
    await evaluate(`(() => { const card = document.querySelector('.rv-card[aria-label="${file}"]'); scrollTo({top: card.getBoundingClientRect().top + scrollY + 40, behavior: 'auto'}); })()`);
    await frames();
    await frames();
    const before = await topOf(file);
    await load('file-0&m=1&n=2&l=1', longerUrl);
    expect(await current()).toBe(file);
    expect(Math.abs((await topOf(file)) - before)).toBeLessThanOrEqual(2);
  });
});

// A README whose table gains a column and a row, beside a paragraph and a
// code block that changed, as the page draws it.
async function tablePage() {
  const before = '# Widget\n\nA small widget.\n\n| Key | Default |\n| --- | --- |\n| theme | light |\n| width | 640 |\n\n```sh\npnpm add widget\n```\n';
  const after = '# Widget\n\nA small widget, now with tables.\n\n| Key | Default | Notes |\n| --- | --- | --- |\n| theme | light | |\n| width | 800 | in pixels |\n| height | 480 | in pixels |\n\n```sh\npnpm add widget@2\n```\n';
  const file = diffFile(before, after, 'README.md');
  const fragment = await renderMarkdown({path: 'README.md', source: after, groups: changeGroups(file), asset: async () => ({kind: 'skipped'}), link: () => ({kind: 'outside'})});
  const lines = after.split('\n').slice(0, -1);
  return assembleReviewPage({
    title: {repo: 'widget', base: 'main', branch: 'feature', worktree: false},
    reviewId: 'table-page',
    builtAt: Date.now(),
    state: {kind: 'unpushed'},
    commits: [],
    cards: [{path: 'README.md', status: 'modified', additions: 6, deletions: 4, kind: 'markdown', viewKey: 'v', signature: 's', diff: {hunks: parseHunks(file.blocks).map((hunk) => drawHunk(hunk)), context: lines.map(escapeText), total: lines.length}, rich: {body: {kind: 'rendered', fragment}}}],
  });
}

// A branch of forty-odd files in folders, with a file at the root and a
// link report row whose text wraps on a narrow window: `extra` files come
// first, so a newer page can name the same files in other places.
function longPage(extra: string[] = []) {
  const before = `${Array.from({length: 30}, (_, line) => `line ${line}`).join('\n')}\n`;
  const after = before.replace('line 10\n', 'line ten\n');
  const file = diffFile(before, after, 'x.txt');
  const lines = after.split('\n').slice(0, -1);
  const card = (filePath: string): ReviewPageCard => ({
    path: filePath, status: 'modified', additions: 1, deletions: 1, kind: 'text', viewKey: `vk-${filePath.replace(/[^a-z0-9]/gi, '-')}`, signature: 's',
    diff: {hunks: parseHunks(file.blocks).map((hunk) => drawHunk(hunk)), context: lines.map(escapeText), total: lines.length},
  });
  const paths = [...extra, 'README.md', ...Array.from({length: 40}, (_, part) => `src/part-${String(part).padStart(2, '0')}/index.ts`)];
  return assembleReviewPage({
    title: {repo: 'widget', base: 'main', branch: 'feature', worktree: false},
    reviewId: 'long-page',
    builtAt: Date.now(),
    state: {kind: 'unpushed'},
    commits: [],
    cards: paths.map(card),
    findings: [{path: 'README.md', line: 4, target: '#configuration-options-for-every-plugin', what: 'link', kind: 'missing', reason: 'anchor not found'}],
  });
}

