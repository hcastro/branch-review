import type {Opener} from '../media/openExternal.js';
import type {RunTool} from './run.js';

// Where a rendered page opens. Inside cmux it is a browser split to the
// right that never takes focus, so keys stay in the TUI, and later presses
// send that split to the next page. Elsewhere it is a new tab in the
// default browser. Over SSH, or with no program to open a page, nothing
// opens and the refusal names the headless option. Every program runs by
// absolute path with an argument array; the only things passed are our own
// page URL, the workspace cmux named in our env, and the split cmux named.
// Once disposed, at exit, a cmux call still running is killed and nothing
// more opens: the session dir with the page in it is about to go. A live
// refresh (watch mode) only ever sends an open split to a new page; it
// never opens one, nor a browser tab.

export type SurfaceKind = 'cmux' | 'browser' | 'none';

export type ShowResult =
  | {where: 'cmux-new' | 'cmux-reuse' | 'browser'; message: string}
  | {refused: string}
  // A newer page was asked for while this one waited its turn, or the app
  // is closing.
  | {superseded: true};

const CMUX_TIMEOUT_MS = 1500;
const HEADLESS = 'branch-review --render-out <dir> writes the pages';
const IN_SPLIT = 'in the split →';
const IN_BROWSER = 'opened in your browser';
// A split name cmux gives, such as `surface:17`; anything else is not used.
const SURFACE_REF = /^[A-Za-z0-9:._-]{1,64}$/;

/** The split cmux placed the page in, or that cmux opened it in the default browser itself. */
function readSplit(stdout: string): {ref: string} | {external: true} | null {
  let answer: unknown;
  try {
    answer = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!answer || typeof answer !== 'object') return null;
  const fields = answer as Record<string, unknown>;
  const ref = typeof fields.surface_ref === 'string' ? fields.surface_ref : typeof fields.surface_id === 'string' ? fields.surface_id : null;
  if (ref !== null && SURFACE_REF.test(ref)) return {ref};
  // With its browser off in its settings, cmux hands the URL to the default
  // browser and makes no split.
  return fields.opened_externally === true ? {external: true} : null;
}

export function createSurface({env, run, findTool, opener, platform}: {
  env: NodeJS.ProcessEnv;
  run: RunTool;
  /** An absolute path for a program on PATH, outside the repo, or null. */
  findTool: (name: string) => string | null;
  opener: Opener;
  platform: NodeJS.Platform;
}) {
  const ssh = Boolean(env.SSH_CONNECTION);
  const workspace = env.CMUX_WORKSPACE_ID;
  const cmux = !ssh && workspace ? findTool('cmux') : null;
  // On macOS the first `open` on PATH inside cmux is its own wrapper.
  const browser = ssh ? null : platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' || platform === 'freebsd' || platform === 'openbsd' ? findTool('xdg-open') : null;
  const refusal = ssh ? `open isn't available over SSH · ${HEADLESS}` : !cmux && !browser ? `no browser opener found · ${HEADLESS}` : null;
  const kind: SurfaceKind = refusal ? 'none' : cmux ? 'cmux' : 'browser';

  let split: string | null = null;
  const stopped = new AbortController();
  let inFlight: Promise<ShowResult> | null = null;
  let newest = 0;
  // Presses waiting or running. A live refresh never goes after one or in
  // place of one: the reader's own `r` decides what the split shows.
  let pressing = 0;

  const inBrowser = (url: string): boolean => {
    if (!browser) return false;
    try {
      opener(browser, [url]);
      return true;
    } catch {
      return false;
    }
  };

  // `reuseOnly`: a live refresh, which goes to the open split or nowhere.
  async function place(url: string, reuseOnly: boolean): Promise<ShowResult> {
    if (refusal) return {refused: refusal};
    if (stopped.signal.aborted || (reuseOnly && !split)) return {superseded: true};
    if (!cmux) return inBrowser(url) ? {where: 'browser', message: IN_BROWSER} : {refused: `no browser opener found · ${HEADLESS}`};
    if (split) {
      const went = await run(cmux, ['browser', '--surface', split, 'goto', url], {timeoutMs: CMUX_TIMEOUT_MS, env, signal: stopped.signal});
      if (stopped.signal.aborted) return {superseded: true};
      if (went.ok) return {where: 'cmux-reuse', message: IN_SPLIT};
      // A goto cmux was slow to answer may still land, and a split that
      // is gone says so at once: the split stays, and the next goto tells.
      if (went.timedOut) return {where: 'cmux-reuse', message: `${IN_SPLIT} · cmux was slow to answer`};
      // The split was closed: a new one opens, without comment.
      split = null;
      if (reuseOnly) return {superseded: true};
    }
    const opened = await run(cmux, ['--json', 'browser', 'open-split', url, '--workspace', workspace!, '--focus', 'false'], {timeoutMs: CMUX_TIMEOUT_MS, env, signal: stopped.signal});
    if (stopped.signal.aborted) return {superseded: true};
    const answer = opened.ok ? readSplit(opened.stdout) : null;
    if (answer && 'ref' in answer) {
      split = answer.ref;
      return {where: 'cmux-new', message: IN_SPLIT};
    }
    // There is no split to reuse, so the next press asks cmux again.
    if (answer) return {where: 'browser', message: `${IN_BROWSER} · cmux's browser is off`};
    return inBrowser(url) ? {where: 'browser', message: `cmux didn't answer · ${IN_BROWSER}`} : {refused: `cmux didn't answer · no browser opener found · ${HEADLESS}`};
  }

  // One call is in flight at a time; of the pages asked for while it runs,
  // only the newest is placed after it. A refresh asked for while a press
  // waits or runs is dropped.
  async function queued(url: string, reuseOnly: boolean): Promise<ShowResult> {
    if (reuseOnly && pressing > 0) return {superseded: true};
    const ticket = (newest += 1);
    if (!reuseOnly) pressing += 1;
    try {
      while (inFlight) {
        await inFlight;
        if (ticket !== newest) return {superseded: true};
      }
      const running = place(url, reuseOnly);
      inFlight = running;
      try {
        return await running;
      } finally {
        inFlight = null;
      }
    } finally {
      if (!reuseOnly) pressing -= 1;
    }
  }

  return {
    kind,
    /** Why nothing can open, or null. Known at once, so the TUI throws nothing toward a page that won't open. */
    refusal,
    /** Where a page opens, for the button's hint. */
    destination: kind === 'cmux' ? 'in a split to the right' : kind === 'browser' ? 'in your browser' : null,
    /** Opens `url`, waiting its turn behind a call in flight. */
    show: (url: string) => queued(url, false),
    /** Sends the split a trip opened to `url`: true when it went there, false when there is no split to send. */
    refresh: async (url: string) => 'where' in await queued(url, true),
    /** Kills a cmux call still running, and opens nothing from now on. */
    dispose() {
      stopped.abort();
    },
  };
}

export type Surface = ReturnType<typeof createSurface>;
