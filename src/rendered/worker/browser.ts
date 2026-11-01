import {spawn as nodeSpawn, type ChildProcess, type SpawnOptions} from 'node:child_process';
import type {Readable, Writable} from 'node:stream';
import type {LayoutBlock, LayoutBox, LayoutLink, PageLayout} from '../plan.js';
import {createCdpPipe, type CdpPipe} from './cdp.js';
import type {ChromeBinary} from './chrome.js';

// The headless Chromium the in-pane view cuts page tiles with, a child of
// the rendered worker and in its process group, so the worker's deadline
// kill ends it too. It runs with no debugging port, in a profile of its own
// in the session dir, with every background service off and every host
// resolving to nothing. Its one page loads our documents by
// Page.setDocumentContent into about:blank, so it reads no file, with
// scripts off and every request failed as if a client blocked it. Our tile
// documents run no script, so the layout comes from a DOM snapshot, not
// from page code. A browser that crashes or stops answering is killed and
// the job fails; the next job starts a new one. A job can say when it must
// be done by, and every call it makes, a cold start included, ends by then.

/** A tile document: our HTML, the width it lays out at and the scale it is drawn at. */
export type TileDocument = {key: string; html: string; cssWidth: number; dpr: number; scheme: 'dark' | 'light'};

/** `deadline`: the time, as Date.now counts it, the job must be done by. */
export type BrowserBudget = {deadline?: number};

export type Browser = {
  layout(document: TileDocument, budget?: BrowserBudget): Promise<PageLayout>;
  /** The PNG of the document's rows from `cssY`, `cssHeight` tall, across its whole width. */
  capture(document: TileDocument, clip: {cssY: number; cssHeight: number}, budget?: BrowserBudget): Promise<Uint8Array>;
  close(): void;
};

type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

/** Everything Chromium does on its own that could reach a network, off. */
export const CHROME_FLAGS = [
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--no-pings',
  '--no-first-run',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-domain-reliability',
  '--disable-breakpad',
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
];

// The viewport's height; the rest of a document is captured beyond it.
const VIEWPORT_HEIGHT = 800;
const DEFAULT_TIMEOUTS = {launch: 10_000, call: 3_000};
const CLOSE_GRACE_MS = 1_000;

type Snapshot = {
  strings: string[];
  documents: Array<{nodes: {nodeName: number[]; parentIndex?: number[]; attributes: number[][]}; layout: {nodeIndex: number[]; bounds: number[][]}}>;
};

/**
 * The page's layout from Chromium's DOM snapshot: our marked blocks, the
 * removed markers, the links and every id an anchor can name, in CSS
 * pixels from the top of the page. The page is as tall as its root box:
 * the browser's own content size is never less than the viewport, which
 * would pad a short page with blank rows. `viewHeight` stands in when the
 * snapshot has no root box. A list item's box ends where its first nested
 * list starts, so its mark covers its own text and never the items under
 * it, which carry marks of their own.
 */
export function parseSnapshot(snapshot: Snapshot, viewHeight: number): PageLayout {
  const layout: PageLayout = {heightCss: viewHeight, blocks: [], removed: [], links: [], anchors: []};
  const document = snapshot.documents[0];
  if (!document) return layout;
  const text = (index: number | undefined) => (index === undefined || index < 0 ? '' : snapshot.strings[index] ?? '');
  // A node's first layout box; text and hidden nodes have none.
  const boxes = new Map<number, number[]>();
  for (const [at, node] of document.layout.nodeIndex.entries()) if (!boxes.has(node)) boxes.set(node, document.layout.bounds[at]!);
  // Our list items' blocks by node, for the lists nested in them, which come after them.
  const items = new Map<number, LayoutBlock>();
  for (const [node, nameIndex] of document.nodes.nodeName.entries()) {
    const bounds = boxes.get(node);
    if (!bounds) continue;
    const [x = 0, y = 0, width = 0, height = 0] = bounds;
    const attributes = new Map<string, string>();
    const list = document.nodes.attributes[node] ?? [];
    for (let at = 0; at + 1 < list.length; at += 2) attributes.set(text(list[at]), text(list[at + 1]));
    const box: LayoutBox = {top: y, bottom: y + height};
    const name = text(nameIndex).toUpperCase();
    if (name === 'HTML') layout.heightCss = y + height;
    const classes = (attributes.get('class') ?? '').split(/\s+/);
    const id = attributes.get('data-block');
    if (id) {
      const lines = /^(\d+)-(\d+)$/.exec(attributes.get('data-lines') ?? '');
      const mark = attributes.get('data-mark');
      const block: LayoutBlock = {id, ...box, ...(lines ? {lines: [Number(lines[1]), Number(lines[2])] as const} : {}), ...(mark === 'added' || mark === 'modified' ? {mark} : {})};
      layout.blocks.push(block);
      if (name === 'LI') items.set(node, block);
    }
    const item = items.get(document.nodes.parentIndex?.[node] ?? -1);
    if (item && (name === 'UL' || name === 'OL')) item.bottom = Math.max(item.top, Math.min(item.bottom, box.top));
    if (name === 'DETAILS' && classes.includes('br-removed')) layout.removed.push(box);
    const href = attributes.get('href');
    if (name === 'A' && href && !classes.includes('anchor')) {
      const link: LayoutLink = {href, left: x, right: x + width, ...box};
      layout.links.push(link);
    }
    const anchor = attributes.get('id');
    if (anchor) layout.anchors.push({id: anchor, top: y});
  }
  return layout;
}

export function createBrowser({binary, userDataDir, spawn = nodeSpawn as Spawn, timeoutsMs = {}, extraArgs = [], onBlocked}: {
  binary: ChromeBinary;
  userDataDir: string;
  spawn?: Spawn;
  timeoutsMs?: Partial<typeof DEFAULT_TIMEOUTS>;
  // More flags, for a test that logs the browser's network use.
  extraArgs?: readonly string[];
  // Told each request the page made and the browser failed, for a test.
  onBlocked?: (url: string) => void;
}): Browser {
  const timeouts = {...DEFAULT_TIMEOUTS, ...timeoutsMs};
  // `used`: a document was loaded into the page since it was made.
  type Running = {child: ChildProcess; pipe: CdpPipe; session: string; frame: string; loaded: string | null; used: boolean; viewport: string | null};
  let running: Promise<Running> | null = null;

  const stop = () => {
    const current = running;
    running = null;
    void current?.then((each) => {
      // Asked to close first, so it ends its own work; killed if it doesn't
      // within a second, or at once when it no longer answers.
      const kill = () => {
        each.pipe.close('the browser was closed');
        try {
          each.child.kill('SIGKILL');
        } catch {
          // Gone already.
        }
      };
      const timer = setTimeout(kill, CLOSE_GRACE_MS);
      timer.unref?.();
      each.child.once('exit', () => clearTimeout(timer));
      void each.pipe.send('Browser.close', {}, {timeoutMs: CLOSE_GRACE_MS}).catch(kill);
    }, () => undefined);
  };

  // How long a call may take: its own limit, cut to what is left of the
  // job's time. A job out of time fails before it asks anything more.
  const allowed = (limit: number, budget: BrowserBudget) => {
    if (budget.deadline === undefined) return limit;
    const left = budget.deadline - Date.now();
    if (left <= 0) throw new Error('the browser ran out of time');
    return Math.min(limit, left);
  };

  const launch = async (budget: BrowserBudget): Promise<Running> => {
    const args = [binary.headless, '--remote-debugging-pipe', `--user-data-dir=${userDataDir}`, ...CHROME_FLAGS, ...extraArgs, 'about:blank'];
    const child = spawn(binary.path, args, {stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe']});
    const pipe = createCdpPipe(child.stdio[4] as Readable, child.stdio[3] as Writable, {timeoutMs: timeouts.call});
    child.once('error', () => pipe.close("the browser didn't start"));
    child.once('exit', (code, signal) => pipe.close(`the browser exited (${signal ? `signal ${signal}` : `code ${code}`})`));
    try {
      const {targetId} = await pipe.send<{targetId: string}>('Target.createTarget', {url: 'about:blank'}, {timeoutMs: allowed(timeouts.launch, budget)});
      const {sessionId} = await pipe.send<{sessionId: string}>('Target.attachToTarget', {targetId, flatten: true}, {timeoutMs: allowed(timeouts.call, budget)});
      const page = (method: string, params: Record<string, unknown> = {}) => pipe.send(method, params, {sessionId, timeoutMs: allowed(timeouts.call, budget)});
      // Any request the document makes (it shouldn't: images are data:
      // URIs and the policy allows nothing else) fails before it leaves.
      pipe.on('Fetch.requestPaused', (params, from) => {
        if (from !== sessionId) return;
        const request = params.request as {url?: unknown} | undefined;
        onBlocked?.(typeof request?.url === 'string' ? request.url : '');
        void pipe.send('Fetch.failRequest', {requestId: params.requestId, errorReason: 'BlockedByClient'}, {sessionId}).catch(() => undefined);
      });
      await page('Page.enable');
      await page('Fetch.enable', {patterns: [{urlPattern: '*'}]});
      await page('Emulation.setScriptExecutionDisabled', {value: true});
      const {frameTree} = await page('Page.getFrameTree') as {frameTree: {frame: {id: string}}};
      return {child, pipe, session: sessionId, frame: frameTree.frame.id, loaded: null, used: false, viewport: null};
    } catch (error) {
      pipe.close();
      child.kill('SIGKILL');
      throw error;
    }
  };

  // Runs `action` and waits for the page's load event after it. The wait
  // ends with the action when it fails, and at once when the pipe closes,
  // so it never outlives the job that started it.
  const loading = async (current: Running, limit: number, action: () => Promise<unknown>) => {
    let stopListening = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("the browser didn't load the page in time")), limit);
      stopListening = current.pipe.on('Page.loadEventFired', (_params, from) => {
        if (from === current.session) resolve();
      });
      void current.pipe.closed.then((reason) => reject(new Error(reason)));
    });
    // Handled from the start: it can fail while the action is still out.
    loaded.catch(() => undefined);
    try {
      await action();
      await loaded;
    } finally {
      clearTimeout(timer);
      stopListening();
    }
  };

  // The browser with `document` loaded at its width, scale and scheme.
  const ready = async (document: TileDocument, budget: BrowserBudget) => {
    const starting = (running ??= launch(budget));
    const current = await starting;
    const page = (method: string, params: Record<string, unknown> = {}) => current.pipe.send(method, params, {sessionId: current.session, timeoutMs: allowed(timeouts.call, budget)});
    const viewport = `${document.cssWidth}@${document.dpr}:${document.scheme}`;
    if (current.viewport !== viewport) {
      current.loaded = null;
      await page('Emulation.setEmulatedMedia', {features: [{name: 'prefers-color-scheme', value: document.scheme}, {name: 'prefers-reduced-motion', value: 'reduce'}]});
      await page('Emulation.setDeviceMetricsOverride', {width: Math.ceil(document.cssWidth), height: VIEWPORT_HEIGHT, deviceScaleFactor: document.dpr, mobile: false});
      current.viewport = viewport;
    }
    if (current.loaded !== document.key) {
      current.loaded = null;
      // Writing a document into the page keeps the policy of the one
      // before, which would refuse the new one's styles by their hashes:
      // a used page goes back to a blank document of its own first.
      if (current.used) await loading(current, allowed(timeouts.call, budget), () => page('Page.navigate', {url: 'about:blank', frameId: current.frame}));
      current.used = true;
      await loading(current, allowed(timeouts.call, budget), () => page('Page.setDocumentContent', {frameId: current.frame, html: document.html}));
      current.loaded = document.key;
    }
    return page;
  };

  // A failed call leaves the browser in an unknown state: it is killed, and
  // the next job starts a new one. The job fails with a one-line reason.
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      stop();
      throw new Error(error instanceof Error ? error.message.split('\n')[0] : String(error));
    }
  };

  return {
    layout: (document, budget = {}) => guarded(async () => {
      const page = await ready(document, budget);
      const metrics = await page('Page.getLayoutMetrics') as {cssContentSize: {height: number}};
      const snapshot = await page('DOMSnapshot.captureSnapshot', {computedStyles: [], includeDOMRects: true}) as Snapshot;
      return parseSnapshot(snapshot, metrics.cssContentSize.height);
    }),
    capture: (document, clip, budget = {}) => guarded(async () => {
      const page = await ready(document, budget);
      const {data} = await page('Page.captureScreenshot', {
        format: 'png',
        clip: {x: 0, y: clip.cssY, width: document.cssWidth, height: clip.cssHeight, scale: 1},
        captureBeyondViewport: true,
        fromSurface: true,
      }) as {data: string};
      return new Uint8Array(Buffer.from(data, 'base64'));
    }),
    close: stop,
  };
}
