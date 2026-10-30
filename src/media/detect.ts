import {escapeHiddenCharacters} from '../controlChars.js';
import {isColorDisabled} from '../git.js';
import {KITTY_QUERY, tmuxWrap} from './kitty.js';
import {NO_GRAPHICS, type GraphicsCaps, type GraphicsProtocol} from './types.js';

// Finds out what the terminal can draw, once, before Ink owns stdin. One
// write asks four questions and ends with DA1, which every terminal answers
// last, so its reply closes the window; a terminal that answers nothing is
// given up on after a short timeout. Replies arrive on stdin, which is in raw
// mode for the window, so Ctrl-C arrives as a byte here instead of SIGINT.
// tmux answers DA1 itself at once, long before the outer terminal's answer to
// the graphics query can make its way back, so under tmux a second DA1 rides
// in the same passthrough as that query and the window waits for both.
// Keys typed during the window go back on stdin for the app. A terminal that
// misses the timeout may still be answering, so stdin then stays raw and ours
// until the app takes it: a late reply never meets a cooked, echoing tty.

const ESC = '\x1B';
const XTVERSION_QUERY = `${ESC}[>0q`;
const CELL_SIZE_QUERY = `${ESC}[16t`;
const TEXT_AREA_QUERY = `${ESC}[14t`;
const DA1_QUERY = `${ESC}[c`;
const DEFAULT_TIMEOUT_MS = 300;
// Replies cross the network over SSH, and tmux answers some itself.
const SLOW_LINK_TIMEOUT_MS = 1000;
const DEFAULT_CELL_PX = {w: 10, h: 20};
// Anything outside this is a confused reply, not a font.
const MAX_CELL_PX = 512;
const MAX_TERMINAL_LABEL = 40;

// One complete reply of each kind we ask for. The graphics reply is matched
// whatever image id it names; only ours (i=31) counts.
const REPLY = new RegExp([
  `${ESC}_G([^;${ESC}]*);([^${ESC}]*)${ESC}\\\\`,
  `${ESC}P>\\|([^${ESC}]*)${ESC}\\\\`,
  `${ESC}\\[6;(\\d+);(\\d+)t`,
  `${ESC}\\[4;(\\d+);(\\d+)t`,
  `${ESC}\\[\\?[\\d;]*c`,
].join('|'), 'g');
// The start of a reply the window closed on before it finished.
const PARTIAL_REPLY = new RegExp(`${ESC}(?:_G[^${ESC}]*${ESC}?|P(?:>(?:\\|[^${ESC}]*${ESC}?)?)?|\\[(?:\\?[\\d;]*|>|[46](?:;\\d*){0,2})?)?$`);

export type ParsedReplies = {
  // The message of our graphics query's reply: 'OK' or an error code.
  graphics?: string;
  xtversion?: string;
  cellPx?: {w: number; h: number};
  textAreaPx?: {w: number; h: number};
  da1: boolean;
  // How many DA1 replies came: under tmux, tmux's own and the outer
  // terminal's.
  da1Count: number;
  // Everything that is not a reply: keys typed during the window.
  stray: string;
  // The start of a reply still arriving at the end of the buffer.
  partial: string;
};

export type TtyInput = {
  isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume?(): unknown;
  pause?(): unknown;
  unshift?(chunk: Buffer): void;
};

// What detection gives the app with stdin after a timeout.
export type HandOff = {
  // The keys typed during the window, pushed back on stdin. The app reads
  // them first, as one input.
  keys: string;
  // The start of a reply still arriving, such as `ESC[?62;22`, so the app
  // can drop the rest of it when it follows the keys; '' when there is none.
  replyHead: string;
};

const NOTHING_HANDED: HandOff = Object.freeze({keys: '', replyHead: ''});

type DetectionIo = {
  stdin?: TtyInput;
  stdout: {isTTY?: boolean; columns?: number; rows?: number; write(text: string): unknown};
  env: NodeJS.ProcessEnv;
  options: {images?: 'auto' | 'off'};
  timeoutMs?: number;
  // Ctrl-C during the window. The window is already closed when it runs.
  onInterrupt: () => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

/** Pure: the replies found in everything stdin delivered during the window. */
export function parseReplies(buffer: string): ParsedReplies {
  const parsed: ParsedReplies = {da1: false, da1Count: 0, stray: '', partial: ''};
  const stray = buffer.replace(REPLY, (whole, keys?: string, message?: string, version?: string, cellH?: string, cellW?: string, areaH?: string, areaW?: string) => {
    if (keys !== undefined) {
      if (keys.split(',').includes('i=31')) parsed.graphics = message;
    } else if (version !== undefined) {
      parsed.xtversion = version;
    } else if (cellH !== undefined) {
      parsed.cellPx = {w: Number(cellW), h: Number(cellH)};
    } else if (areaH !== undefined) {
      parsed.textAreaPx = {w: Number(areaW), h: Number(areaH)};
    } else if (whole.endsWith('c')) {
      parsed.da1 = true;
      parsed.da1Count += 1;
    }
    return '';
  });
  parsed.partial = PARTIAL_REPLY.exec(stray)?.[0] ?? '';
  parsed.stray = stray.slice(0, stray.length - parsed.partial.length);
  return parsed;
}

function imagesSetting(env: NodeJS.ProcessEnv) {
  return (env.BRANCH_REVIEW_IMAGES ?? '').trim().toLowerCase();
}

function isTurnedOff(env: NodeJS.ProcessEnv, options: DetectionIo['options']) {
  return options.images === 'off' || ['off', 'none', '0', 'false'].includes(imagesSetting(env));
}

// Terminals that may print an APC's payload as text instead of ignoring it.
function mayPrintApc(env: NodeJS.ProcessEnv) {
  const term = env.TERM ?? '';
  return term === 'linux' || term === 'dumb' || (term.startsWith('screen') && !env.TMUX);
}

type Identity = {name: 'kitty' | 'ghostty' | null; version?: string; denied: boolean; label: string};

// Who is answering: the environment first, then XTVERSION. Terminals on the
// deny list answer the graphics query but cannot draw Unicode placeholders.
function identify(env: NodeJS.ProcessEnv, xtversion: string | undefined): Identity {
  const program = env.TERM_PROGRAM ?? '';
  const denied = ['WarpTerminal', 'WezTerm', 'vscode'].includes(program)
    || Boolean(env.WEZTERM_EXECUTABLE)
    || Boolean(env.KONSOLE_VERSION)
    || /wezterm|konsole/i.test(xtversion ?? '');
  const xtGhostty = /^ghostty\s*v?([\d.]+\S*)?/i.exec(xtversion ?? '');

  let name: Identity['name'] = null;
  let version: string | undefined;
  if (env.TERM === 'xterm-kitty' || env.KITTY_WINDOW_ID) {
    name = 'kitty';
  } else if (program === 'ghostty' || env.GHOSTTY_RESOURCES_DIR) {
    name = 'ghostty';
    version = (program === 'ghostty' ? env.TERM_PROGRAM_VERSION : undefined) || xtGhostty?.[1];
  } else if (/^kitty\(/.test(xtversion ?? '')) {
    name = 'kitty';
  } else if (xtGhostty) {
    name = 'ghostty';
    version = xtGhostty[1];
  }

  const raw = name ? `${name}${version ? ` ${version}` : ''}` : program || xtversion || env.TERM || '';
  // From the environment or the terminal, and shown in messages.
  const label = escapeHiddenCharacters(raw).slice(0, MAX_TERMINAL_LABEL);
  return {name, version, denied, label};
}

function atLeast(version: string | undefined, major: number, minor: number) {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return false;
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

function validCell(px: {w: number; h: number} | undefined) {
  return px && Number.isFinite(px.w) && Number.isFinite(px.h) && px.w >= 1 && px.h >= 1 && px.w <= MAX_CELL_PX && px.h <= MAX_CELL_PX
    ? {w: px.w, h: px.h}
    : undefined;
}

/** Pure: what to draw with, from the replies, the environment and the grid size. */
export function decideCaps(replies: ParsedReplies, env: NodeJS.ProcessEnv, size: {columns?: number; rows?: number}): GraphicsCaps {
  const identity = identify(env, replies.xtversion);
  const truecolor = ['truecolor', '24bit'].includes((env.COLORTERM ?? '').toLowerCase());
  const colors256 = truecolor || (env.TERM ?? '').includes('256color') || env.TERM_PROGRAM === 'Apple_Terminal';
  const tmux = Boolean(env.TMUX);
  const forced = imagesSetting(env);

  let protocol: GraphicsProtocol;
  if (forced === 'kitty' || forced === 'blocks') {
    protocol = forced;
  } else if (replies.graphics === 'OK' && identity.name && !identity.denied) {
    // Under tmux the query went out wrapped for passthrough, so an OK means
    // tmux forwards graphics to a terminal that draws them. Only
    // `allow-passthrough all` forwards them while the pane is hidden too;
    // with `on`, an image sent then never arrives and its box stays blank.
    protocol = 'kitty';
  } else if (tmux) {
    // tmux draws color whatever the outer terminal answers, and a pane
    // that passes no graphics through still shows half blocks.
    protocol = 'blocks';
  } else if (replies.da1 && colors256) {
    protocol = 'blocks';
  } else {
    protocol = 'none';
  }

  const fromCell = validCell(replies.cellPx);
  const fromArea = replies.textAreaPx && size.columns && size.rows
    ? validCell({w: Math.floor(replies.textAreaPx.w / size.columns), h: Math.floor(replies.textAreaPx.h / size.rows)})
    : undefined;
  const cellPx = fromCell ?? fromArea ?? DEFAULT_CELL_PX;

  const detectionTimedOut = !replies.da1;
  if (protocol === 'none') return {...NO_GRAPHICS, terminal: identity.label, detectionTimedOut};

  return {
    protocol,
    cellPx: {...cellPx},
    cellPxSource: fromCell ? 'csi16' : fromArea ? 'csi14' : 'default',
    colorDepth: truecolor || identity.name ? 3 : 2,
    animation: protocol === 'kitty' && (identity.name === 'kitty' || (identity.name === 'ghostty' && atLeast(identity.version, 1, 4))),
    tmux,
    terminal: identity.label,
    detectionTimedOut,
  };
}

function latin1(chunk: Buffer | string) {
  return (typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk).toString('latin1');
}

/**
 * Starts detection and returns its result, which settles at the last DA1 reply,
 * at the timeout, on Ctrl-C or on cancel(). When the terminal answers, or on
 * Ctrl-C or cancel(), raw mode is off and the listener is gone by then. After
 * a timeout the terminal may still be answering, so stdin stays raw and ours,
 * swallowing late replies, until handOff() gives it to the app or cancel()
 * ends it. When images are off, stdin or stdout is not a terminal, colour is
 * off, or the terminal may print APC payloads, it settles at once with no
 * graphics and writes nothing.
 */
export function startGraphicsDetection(io: DetectionIo): {
  result: Promise<GraphicsCaps>;
  // Raw mode off and the listener gone, whatever state detection is in.
  cancel(): void;
  // For the app about to read stdin, after the result settled.
  handOff(): HandOff;
} {
  const {stdin, stdout, env} = io;
  if (
    isTurnedOff(env, io.options)
    || !stdin || !stdin.isTTY || !stdin.setRawMode || !stdout.isTTY
    || isColorDisabled(env)
    || mayPrintApc(env)
  ) {
    return {result: Promise.resolve(NO_GRAPHICS), cancel() {}, handOff: () => NOTHING_HANDED};
  }

  const setTimer = io.setTimer ?? setTimeout;
  const clearTimer = io.clearTimer ?? clearTimeout;
  const timeoutMs = io.timeoutMs ?? (env.SSH_CONNECTION || env.TMUX ? SLOW_LINK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

  let resolve!: (caps: GraphicsCaps) => void;
  const result = new Promise<GraphicsCaps>((done) => {
    resolve = done;
  });
  let buffer = '';
  // 'open' while the window runs; 'holding' after a timeout, still raw and
  // listening; 'handedOff' once the app has stdin, raw mode left on for it;
  // 'closed' once raw mode is off and the listener gone.
  let state: 'open' | 'holding' | 'handedOff' | 'closed' = 'open';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const da1Expected = env.TMUX ? 2 : 1;

  const rawModeOff = () => {
    try {
      stdin.setRawMode!(false);
    } catch {
      // The terminal went away; there is nothing left to restore.
    }
  };

  const finish = (how: 'answered' | 'cancel' | 'interrupt') => {
    if (state === 'closed') return;
    const handedOff = state === 'handedOff';
    state = 'closed';
    if (timer !== undefined) clearTimer(timer);
    rawModeOff();
    // The app owns the stream now; only raw mode was still ours to undo.
    if (handedOff) return;
    stdin.off('data', onData);
    stdin.pause?.();

    // Settled already when the window timed out.
    if (how === 'cancel' || how === 'interrupt') {
      resolve(NO_GRAPHICS);
      return;
    }

    const replies = parseReplies(buffer);
    // DA1 answers last, so no reply is still arriving and an unfinished one
    // at the end is keys, such as an arrow cut in half. Paused and without
    // our listener, so the app reads these bytes first.
    const keys = replies.stray + replies.partial;
    if (keys) stdin.unshift?.(Buffer.from(keys, 'latin1'));
    resolve(decideCaps(replies, env, {columns: stdout.columns, rows: stdout.rows}));
  };

  const timeOut = () => {
    if (state !== 'open') return;
    state = 'holding';
    resolve(decideCaps(parseReplies(buffer), env, {columns: stdout.columns, rows: stdout.rows}));
  };

  function onData(chunk: Buffer | string) {
    const text = latin1(chunk);
    // No reply contains ETX, so this is the user's Ctrl-C.
    if (text.includes('\x03')) {
      finish('interrupt');
      io.onInterrupt();
      return;
    }
    buffer += text;
    if (state === 'open' && parseReplies(buffer).da1Count >= da1Expected) finish('answered');
  }

  const handOff = (): HandOff => {
    if (state !== 'holding') return {keys: '', replyHead: ''};
    state = 'handedOff';
    stdin.off('data', onData);
    // Raw mode stays on: the app turns it on again as it mounts, and a reply
    // arriving in between must not be echoed.
    stdin.pause?.();
    const replies = parseReplies(buffer);
    // A lone ESC at the end is the Esc key as often as a reply's first byte.
    // As a key it reaches the app, whose guard holds a lone Esc for a moment
    // and drops it when the rest of a reply follows; as a reply head it
    // would be lost.
    const replyHead = replies.partial === ESC ? '' : replies.partial;
    const keys = replyHead ? replies.stray : replies.stray + replies.partial;
    if (keys) stdin.unshift?.(Buffer.from(keys, 'latin1'));
    return {keys, replyHead};
  };

  try {
    stdin.setRawMode(true);
  } catch {
    state = 'closed';
    return {result: Promise.resolve(NO_GRAPHICS), cancel() {}, handOff: () => NOTHING_HANDED};
  }

  stdin.on('data', onData);
  stdin.resume?.();
  // tmux would swallow or misroute an unwrapped APC; wrapped, it reaches
  // the outer terminal only when tmux allows passthrough. The DA1 wrapped
  // with it is answered by the outer terminal after its graphics reply, so
  // that second DA1 closes the window. With passthrough off it never comes,
  // and the window ends at the timeout with stdin still held.
  const graphicsQuery = env.TMUX ? tmuxWrap(`${KITTY_QUERY}${DA1_QUERY}`) : KITTY_QUERY;
  try {
    stdout.write(`${graphicsQuery}${XTVERSION_QUERY}${CELL_SIZE_QUERY}${TEXT_AREA_QUERY}${DA1_QUERY}`);
  } catch {
    finish('cancel');
    return {result, cancel() {}, handOff: () => NOTHING_HANDED};
  }
  // Synchronous work or a loaded machine can hold the event loop past the
  // timeout. The loop then runs timers
  // before it reads stdin, so a reply that is already waiting would lose to
  // the timer; one more turn of the loop reads it first.
  timer = setTimer(() => setImmediate(timeOut), timeoutMs);

  return {result, cancel: () => finish('cancel'), handOff};
}
