import {blockForSourceLine} from '../anchor.js';
import {DEVELOP, flipFrom, planDevelop, type DevelopPlan, type DevelopStep, type DevelopUnit, type Rect} from '../develop.js';
import {readPageHash, type PageHash} from '../hash.js';

// The rendered page's script, inlined and allowed by its hash. It plays
// the arrival a trip asks for in the URL hash (the develop from the raw
// terminal frame on a first visit, a short scroll and glow on a revisit, a
// pulse on a live refresh), keeps the page on the block the reader had on
// screen in the diff, and gives the page its keys: changes, files, theme,
// marks and help. On an image's page it switches the compare modes the TUI
// keys `1` `2` `3`: side by side, flip and difference. Everything it changes it sets from script, so a page
// whose script doesn't run is the finished page, and nothing it does reads
// repo text into markup: raw lines go in as text nodes.

type Theme = 'auto' | 'light' | 'dark';

const FALLBACK_COLORS = {bg: '111318', fg: 'e6e6e6'};
// The raw frame's line box: 13 px type on 20 px lines, like a terminal row.
const VEIL_LINE_PX = 20;
// Where a change lands below the strip when stepped to with `[` or `]`,
// and how far off that line a change still counts as on it: browsers round
// a smooth scroll's end differently.
const CHANGE_INSET_PX = 24;
const CHANGE_SLOP_PX = 2;
// About as long as a browser's smooth scroll takes.
const STEP_SCROLL_MS = 700;
const MAX_ANIMATED_CELLS = 400;
const MAX_ANIMATED_TOKENS = 1500;
const THEME_KEY = 'branch-review-theme';
const COMPARE_KEY = 'branch-review-compare';
const MARKS_KEY = 'branch-review-marks';
const PLACE_KEY = 'branch-review-place';
const THEMES: readonly Theme[] = ['auto', 'light', 'dark'];
const THEME_NAMES: Record<Theme, string> = {auto: 'Auto', light: 'Light', dark: 'Dark'};
// Markdown's own marks in a raw line, which fade first: heading hashes,
// quote and list markers, task boxes and ordered numbers at the start, and
// fences, table pipes and strong emphasis anywhere.
const LEADING_MARKS = /^(\s*)((?:>\s?|#{1,6}\s|[-*+]\s(?:\[[ xX]\]\s)?|\d{1,9}[.)]\s)+)/;
const INLINE_MARKS = /(`{3,}|~{3,}|\||\*\*|__)/;

const root = document.documentElement;
const article = document.querySelector<HTMLElement>('.br-main > article.markdown-body');
const imagePage = document.querySelector<HTMLElement>('.br-image-page');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Every animation of the arrival playing now, so any input can finish them all at once. */
const playing: Array<{finish(): void}> = [];
let settleArrival: (() => void) | null = null;

const top = () => document.querySelector('.br-strip')?.getBoundingClientRect().bottom ?? 0;
const viewHeight = () => Math.max(1, innerHeight - top());

const kept = () => localStorage;
const tab = () => sessionStorage;

function store(key: string, value?: string, area = kept): string | null {
  try {
    if (value === undefined) return area().getItem(key);
    area().setItem(key, value);
  } catch {
    // Storage can be off for file pages; the choice then lasts the visit.
  }
  return null;
}

function relative(rect: DOMRect): Rect {
  return {x: rect.left, y: rect.top - top(), w: rect.width, h: rect.height};
}

function union(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.w));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.h));
  return {x, y, w: right - x, h: bottom - y};
}

// ---------------------------------------------------------------------------
// The blocks of the page, as the develop moves them.

type Unit = DevelopUnit & {el: HTMLElement; lines: [number, number]; marked: HTMLElement[]};

function stampedLines(el: Element): [number, number] | null {
  const match = /^(\d+)-(\d+)$/.exec(el.getAttribute('data-lines') ?? '');
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function stampedBlocks() {
  if (!article) return [];
  return [...article.querySelectorAll<HTMLElement>('[data-block][data-lines]')].flatMap((el) => {
    const lines = stampedLines(el);
    return lines ? [{el, lines}] : [];
  });
}

// The outermost stamped blocks, each one unit; a table's rows move as
// their table, since a row can't be moved on its own.
function collectUnits(): Unit[] {
  const units = new Map<HTMLElement, Unit>();
  for (const {el: stamped, lines} of stampedBlocks()) {
    if (stamped.parentElement?.closest('[data-block]')) continue;
    const el = stamped.tagName === 'TR' ? stamped.closest('table') : stamped;
    if (!el) continue;
    const known = units.get(el);
    if (known) {
      known.lines = [Math.min(known.lines[0], lines[0]), Math.max(known.lines[1], lines[1])];
      continue;
    }
    const marked = [el, ...el.querySelectorAll<HTMLElement>('[data-mark]')].filter((each) => each.hasAttribute('data-mark'));
    const mark = marked[0]?.getAttribute('data-mark');
    const kind: DevelopUnit['kind'] = el.tagName === 'TABLE' ? 'table'
      : el.matches('pre, .highlight') || el.querySelector('pre') ? 'code'
        : el.querySelector('img, picture') || el.tagName === 'IMG' ? 'image' : 'text';
    units.set(el, {
      id: stamped.getAttribute('data-block') ?? '',
      el,
      lines,
      marked,
      mark: mark === 'added' || mark === 'modified' ? mark : null,
      kind,
      rich: relative(el.getBoundingClientRect()),
      raw: null,
    });
  }
  return [...units.values()];
}

// The block that holds source line `line`, or null on a page with none.
function blockAt(line: number) {
  const blocks = stampedBlocks();
  const index = blockForSourceLine(blocks, line);
  return index < 0 ? null : blocks[index]!.el;
}

// What a live refresh pulses: the element of each new block id, rows and
// list items included, less a table or list whose id is new only because
// one of its rows or items is.
function freshUnits(ids: readonly string[]): Unit[] {
  const fresh = new Set(ids);
  const found = stampedBlocks().filter(({el}) => fresh.has(el.getAttribute('data-block') ?? ''));
  return found
    .filter(({el}) => !found.some((other) => other.el !== el && el.contains(other.el)))
    .map(({el, lines}) => ({id: el.getAttribute('data-block')!, el, lines, marked: [], mark: null, kind: 'text', rich: relative(el.getBoundingClientRect()), raw: null}));
}

// The reader's place on this file's page, kept for the tab as they scroll:
// the first block not above the strip, and how far down the view it is.
const filePath = () => document.querySelector('.br-path')?.textContent ?? '';

function savePlace() {
  const line = top();
  const found = stampedBlocks().find(({el}) => el.getBoundingClientRect().bottom > line + 1);
  if (!found) return;
  const f = (found.el.getBoundingClientRect().top - line) / viewHeight();
  store(PLACE_KEY, JSON.stringify({file: filePath(), id: found.el.getAttribute('data-block'), line: found.lines[0], f}), tab);
}

function placeKept(): {el: HTMLElement; f: number} | null {
  let place: unknown;
  try {
    place = JSON.parse(store(PLACE_KEY, undefined, tab) ?? 'null');
  } catch {
    return null;
  }
  if (!place || typeof place !== 'object') return null;
  const {file, id, line, f} = place as Record<string, unknown>;
  if (file !== filePath() || typeof f !== 'number' || !Number.isFinite(f)) return null;
  // The same block if the edit left it, else the block at its line.
  const el = stampedBlocks().find((each) => each.el.getAttribute('data-block') === id)?.el ?? (typeof line === 'number' ? blockAt(line) : null);
  return el ? {el, f} : null;
}

// ---------------------------------------------------------------------------
// The raw frame: the source the diff showed, in the terminal's colors.

function readRaw(): {lines: string[]; tints: string} | null {
  const pre = document.querySelector<HTMLTemplateElement>('template.br-raw-source')?.content.querySelector('pre');
  if (!pre) return null;
  const tints = pre.getAttribute('data-tints') ?? '';
  const lines = (pre.textContent ?? '').split('\n');
  return lines.length === tints.length ? {lines, tints} : null;
}

// One raw line as text nodes, its markdown marks in spans of their own.
function rawLine(text: string, marks: HTMLElement[]) {
  const span = document.createElement('span');
  span.className = 'br-veil-text';
  const mark = (value: string) => {
    const each = document.createElement('span');
    each.className = 'br-veil-mark';
    each.textContent = value;
    marks.push(each);
    span.append(each);
  };
  const leading = LEADING_MARKS.exec(text);
  let rest = text;
  if (leading) {
    span.append(leading[1]!);
    mark(leading[2]!);
    rest = text.slice(leading[0].length);
  }
  for (const [index, part] of rest.split(INLINE_MARKS).entries()) {
    if (part === '') continue;
    if (index % 2 === 1) mark(part);
    else span.append(part);
  }
  return span;
}

type Veil = {el: HTMLElement; marks: HTMLElement[]; lineRects: Map<number, Rect[]>};

/**
 * The raw frame over the page, with source line `anchor` at `anchorY`
 * (from the strip's bottom), so the block the page opens on starts where
 * its raw text is. A line wraps at the article's measure as its rendered
 * text will, and the lines stack from the anchor's up and down by their
 * own heights. Lines not on the page's side (removed text) show as red
 * rows, cut to one line each.
 */
function buildVeil(raw: {lines: string[]; tints: string}, anchor: number, anchorY: number, colors: {bg: string; fg: string}): Veil {
  const el = document.createElement('div');
  el.className = 'br-veil';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--br-veil-bg', `#${colors.bg}`);
  el.style.setProperty('--br-veil-fg', `#${colors.fg}`);
  el.style.top = `${top()}px`;
  const numbers: Array<number | null> = [];
  let line = 0;
  for (const tint of raw.tints) numbers.push(tint === '-' ? null : (line += 1));
  let at = numbers.findIndex((number) => number !== null && number >= anchor);
  if (at < 0) at = numbers.length - 1;

  const content = article ? article.getBoundingClientRect() : null;
  const padding = article ? parseFloat(getComputedStyle(article).paddingLeft) || 0 : 0;
  const left = content ? content.left + padding : 16;
  const width = content ? Math.max(120, content.width - 2 * padding) : innerWidth - 32;
  // Enough lines to fill the view were none of them to wrap.
  const above = Math.ceil(anchorY / VEIL_LINE_PX) + 1;
  const below = Math.ceil((viewHeight() - anchorY) / VEIL_LINE_PX) + 1;
  const first = Math.max(0, at - above);
  const marks: HTMLElement[] = [];
  const rows: Array<{number: number | null; row: HTMLElement; span: HTMLElement}> = [];
  for (let index = first; index < Math.min(raw.lines.length, at + below); index += 1) {
    const row = document.createElement('div');
    const tint = raw.tints[index];
    row.className = `br-veil-line${tint === '+' ? ' br-veil-added' : tint === '-' ? ' br-veil-removed' : tint === 'x' ? ' br-veil-deleted' : ''}`;
    row.style.left = `${left}px`;
    row.style.width = `${width}px`;
    const span = rawLine(tint === '-' ? `- ${raw.lines[index]!}` : raw.lines[index]!, marks);
    row.append(span);
    el.append(row);
    rows.push({number: numbers[index]!, row, span});
  }
  document.body.append(el);
  const heights = rows.map(({row}) => row.offsetHeight);
  const anchorRow = at - first;
  let y = anchorY;
  for (let index = anchorRow; index < rows.length; index += 1) {
    rows[index]!.row.style.top = `${y}px`;
    y += heights[index]!;
  }
  y = anchorY;
  for (let index = anchorRow - 1; index >= 0; index -= 1) {
    y -= heights[index]!;
    rows[index]!.row.style.top = `${y}px`;
  }
  const lineRects = new Map<number, Rect[]>();
  for (const {number, span} of rows) {
    if (number === null) continue;
    const rect = relative(span.getBoundingClientRect());
    // A blank line still holds its row.
    lineRects.set(number, [{...rect, w: Math.max(rect.w, 8), h: Math.max(rect.h, VEIL_LINE_PX)}]);
  }
  return {el, marks, lineRects};
}

function rawRect(veil: Veil, lines: [number, number]) {
  const rects: Rect[] = [];
  for (let line = lines[0]; line <= lines[1]; line += 1) rects.push(...(veil.lineRects.get(line) ?? []));
  return union(rects);
}

// ---------------------------------------------------------------------------
// Playing a plan.

// Settles the first time the animation finishes or is canceled. Its
// `finished` promise is replaced each time it leaves the finished state,
// so the events are what any later finish() reaches.
function play(el: Element, keyframes: Keyframe[], step: Pick<DevelopStep, 'start' | 'duration' | 'easing'>, fill: FillMode = 'backwards') {
  const animation = el.animate(keyframes, {delay: step.start, duration: step.duration, easing: step.easing, fill});
  playing.push(animation);
  return new Promise<void>((resolve) => {
    animation.addEventListener('finish', () => resolve(), {once: true});
    animation.addEventListener('cancel', () => resolve(), {once: true});
  });
}

function cssColor(name: string) {
  return getComputedStyle(root).getPropertyValue(name).trim() || 'transparent';
}

// Each cell of a row, or the element itself: a row can't hold a tint or a
// glow of its own in every browser, its cells can.
const paintTargets = (el: HTMLElement) => (el.tagName === 'TR' ? [...el.children] as HTMLElement[] : [el]);

// Where a glow shows: a row's cells; a code block's own box, whose
// background would hide a glow on its wrapper; and a picture's frame, since
// an image covers anything drawn inside its box.
function glowTargets(el: HTMLElement): Array<{target: Element; ring: boolean}> {
  if (el.tagName === 'TR') return paintTargets(el).map((target) => ({target, ring: false}));
  const pre = el.tagName === 'PRE' ? el : el.querySelector(':scope > pre');
  if (pre) return [{target: pre, ring: false}];
  const images = el.tagName === 'IMG' ? [el] : [...el.querySelectorAll('img')];
  if (images.length > 0 && !el.textContent?.trim()) return images.map((target) => ({target, ring: true}));
  return [{target: el, ring: false}];
}

function glow(el: HTMLElement, step: DevelopStep) {
  const color = cssColor('--br-glow');
  return Promise.all(glowTargets(el).map(({target, ring}) => {
    const shadow = (value: string) => ({boxShadow: ring ? `0 0 0 4px ${value}` : `inset 0 0 0 100vmax ${value}`});
    return play(target, [shadow('transparent'), {...shadow(color), offset: 0.3}, shadow('transparent')], step);
  }));
}

function scrollSmoothly(distance: number, step: DevelopStep): Promise<unknown> {
  const from = scrollY;
  const started = performance.now() + step.start;
  return new Promise((resolve) => {
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      scrollTo({top: from + distance, behavior: 'instant'});
      resolve(undefined);
    };
    playing.push({finish: end});
    const frame = (now: number) => {
      if (done) return;
      const progress = Math.min(1, Math.max(0, (now - started) / step.duration));
      if (progress >= 1) {
        end();
        return;
      }
      scrollTo({top: from + distance * (1 - (1 - progress) ** 3), behavior: 'instant'});
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

const imagesOf = (el: HTMLElement) => [...el.querySelectorAll('img'), ...(el.tagName === 'IMG' ? [el as HTMLImageElement] : [])];

// `overlays` collects what a step adds to the page for the develop only:
// the line tints and the pictures' boxes. They go once the page settles.
function runStep(unit: Unit, step: DevelopStep, overlays: HTMLElement[]): Promise<unknown> {
  const {el} = unit;
  switch (step.effect) {
    case 'flip': {
      const from = flipFrom(unit.raw!, unit.rich);
      return play(el, [
        {transformOrigin: '0 0', transform: `translate(${from.dx}px, ${from.dy}px) scale(${from.s})`, opacity: 0},
        {transformOrigin: '0 0', transform: 'none', opacity: 1},
      ], step);
    }
    case 'fade':
      return play(el, [{opacity: 0}, {opacity: 1}], step);
    case 'tint':
      return Promise.all(unit.marked.map((marked) => {
        const kind = marked.getAttribute('data-mark') === 'modified' ? 'modified' : 'added';
        if (marked.tagName === 'TR' || marked.tagName === 'HR' || marked.tagName === 'IMG') {
          const color = cssColor(`--br-tint-${kind}`);
          return Promise.all(paintTargets(marked).map((cell) => play(cell, [{backgroundColor: color}, {backgroundColor: getComputedStyle(cell).backgroundColor}], step)));
        }
        // The diff's tint over the block, shrinking toward its bar.
        const tint = document.createElement('span');
        tint.className = `br-tint br-tint-${kind}`;
        tint.setAttribute('aria-hidden', 'true');
        marked.prepend(tint);
        overlays.push(tint);
        return play(tint, [{transform: 'scaleX(1)'}, {transform: 'scaleX(0)'}], step);
      }));
    case 'frame':
      return Promise.all(imagesOf(el).map((image) => {
        // Where the picture lands, which its block's move leaves out.
        const box = document.createElement('span');
        box.className = 'br-image-box';
        box.setAttribute('aria-hidden', 'true');
        let [x, y] = [0, 0];
        for (let at: HTMLElement | null = image; at; at = at.offsetParent as HTMLElement | null) [x, y] = [x + at.offsetLeft, y + at.offsetTop];
        Object.assign(box.style, {left: `${x}px`, top: `${y}px`, width: `${image.offsetWidth}px`, height: `${image.offsetHeight}px`});
        document.body.append(box);
        overlays.push(box);
        const shown = (DEVELOP.imageStartMs - step.start) / step.duration;
        return play(box, [{opacity: 0}, {opacity: 1, offset: shown}, {opacity: 0}], step, 'both');
      }));
    case 'image':
      return Promise.all(imagesOf(el).map((image) => play(image, [{opacity: 0, filter: 'blur(6px)'}, {opacity: 1, filter: 'blur(0)'}], step)));
    case 'rules':
      return Promise.all([...el.querySelectorAll<HTMLElement>('th, td')].slice(0, MAX_ANIMATED_CELLS).map((cell) => play(cell, [{borderColor: 'transparent'}, {borderColor: getComputedStyle(cell).borderTopColor}], step)));
    case 'code': {
      const plain = getComputedStyle(el.querySelector('pre') ?? el).color;
      return Promise.all([...el.querySelectorAll<HTMLElement>('pre span[class]')].slice(0, MAX_ANIMATED_TOKENS).map((token) => play(token, [{color: plain}, {color: getComputedStyle(token).color}], step)));
    }
    case 'glow':
      return Promise.all((unit.marked.length > 0 ? unit.marked : [el]).map((target) => glow(target, step)));
    case 'scroll':
      return scrollSmoothly(distanceToPlace(anchorTarget ?? el), step);
  }
}

// The block a trip opens on, and where in the view it goes, as a fraction
// of the height under the strip.
let anchorTarget: HTMLElement | null = null;
let anchorFraction = 0;
const distanceToPlace = (el: HTMLElement) => el.getBoundingClientRect().top - top() - anchorFraction * viewHeight();

/** Plays `plan`; any input finishes it at once. The page is final when it settles. */
function perform(plan: DevelopPlan, units: Unit[], veil: Veil | null) {
  finishAll();
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  const overlays: HTMLElement[] = [];
  const running: Array<Promise<unknown>> = [];
  if (veil) {
    if (plan.veil?.markers) running.push(...veil.marks.map((mark) => play(mark, [{opacity: 1}, {opacity: 0}], {...plan.veil!.markers!, easing: 'linear'}, 'forwards')));
    if (plan.veil?.text) running.push(...[...veil.el.children].map((line) => play(line, [{opacity: 1}, {opacity: 0}], {...plan.veil!.text!, easing: 'ease-in'}, 'forwards')));
    if (plan.veil) running.push(play(veil.el, [{opacity: 1}, {opacity: 0}], {...plan.veil.fade, easing: 'ease-out'}, 'forwards'));
  }
  for (const step of plan.steps) {
    const unit = byId.get(step.id);
    if (unit) running.push(runStep(unit, step, overlays));
  }
  if (plan.chips) {
    for (const chip of chipsInView()) running.push(play(chip, [{opacity: 0}, {opacity: 1}], {...plan.chips, easing: 'ease-out'}));
  }
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    veil?.el.remove();
    for (const overlay of overlays) overlay.remove();
    playing.length = 0;
    settleArrival = null;
    savePlace();
  };
  settleArrival = settle;
  // The animations' own end. A page out of sight can hold them back, so a
  // little after the plan's end every one still playing is finished where
  // it stands, and the final page shows.
  void Promise.all(running).then(settle);
  setTimeout(() => {
    if (!settled) finishAll();
  }, plan.done + 500);
}

// The before chips and removed markers on screen. They sit where their
// blocks land, so they show once the blocks are there.
function chipsInView() {
  if (!article) return [];
  const [from, to] = [top(), innerHeight];
  return [...article.querySelectorAll('details.br-before, details.br-removed')].filter((chip) => {
    const rect = chip.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > from && rect.top < to;
  });
}

function finishAll() {
  for (const animation of [...playing]) animation.finish();
  settleArrival?.();
}

// ---------------------------------------------------------------------------
// Arriving: from a trip's hash, on load and on every later trip to this page.

// A trip that reached the page while it was out of sight, such as a split
// in a cmux workspace in the background, where animations don't advance:
// it plays when the page shows, unless the reader acted first.
let whenShown: PageHash | null = null;

// The head script painted the trip's first frame in the terminal's
// background. Once the raw frame covers the page, or when nothing plays,
// the page's own background takes over, leaving no attribute behind.
function releaseFirstFrame() {
  if (!root.hasAttribute('data-br-first')) return;
  root.removeAttribute('data-br-first');
  root.removeAttribute('style');
}

function arrive(hash: PageHash) {
  try {
    arriveAt(hash);
  } finally {
    releaseFirstFrame();
  }
}

function arriveAt(hash: PageHash) {
  whenShown = null;
  if (imagePage) {
    arriveAtImage(hash);
    return;
  }
  if (!article || (hash.at === undefined && hash.d === undefined)) return;
  finishAll();
  // Place-keeping: the block the reader had on screen, where they had it.
  // A live refresh is a new page of the file the split shows, and opens
  // where the reader has since scrolled to.
  const place = hash.d === 'none' ? placeKept() : null;
  anchorFraction = place ? place.f : hash.f ?? 0;
  const anchorEl = place ? place.el : hash.at !== undefined ? blockAt(hash.at) : null;
  anchorTarget = anchorEl;
  const motion = hash.m !== false;
  if (motion && hash.d && document.visibilityState === 'hidden') {
    if (anchorEl) scrollTo({top: scrollY + distanceToPlace(anchorEl), behavior: 'instant'});
    whenShown = hash;
    return;
  }
  const reduced = reducedMotion.matches;
  const units = hash.d === 'none' ? freshUnits(hash.g ?? []) : hash.d ? collectUnits() : [];
  const anchorUnit = anchorEl ? units.find((unit) => unit.el === anchorEl || unit.el.contains(anchorEl)) : undefined;
  // A revisit scrolls there in its plan; every other arrival is there at once.
  const scrolls = hash.d === 'short' && motion && !reduced && anchorUnit !== undefined;
  if (anchorEl && !scrolls) scrollTo({top: scrollY + distanceToPlace(anchorEl), behavior: 'instant'});
  if (!hash.d) return;
  if (!scrolls) for (const unit of units) unit.rich = relative(unit.el.getBoundingClientRect());
  let veil: Veil | null = null;
  if (hash.d === 'full' && motion) {
    const raw = readRaw();
    if (raw) {
      const anchorY = anchorEl ? anchorEl.getBoundingClientRect().top - top() : 0;
      veil = buildVeil(raw, hash.at ?? 1, anchorY, {bg: hash.bg ?? FALLBACK_COLORS.bg, fg: hash.fg ?? FALLBACK_COLORS.fg});
      for (const unit of units) unit.raw = rawRect(veil, unit.lines);
    }
  }
  const plan = planDevelop({
    units,
    viewport: {height: viewHeight()},
    mode: hash.d,
    ...(anchorUnit ? {anchor: anchorUnit.id} : {}),
    pulse: hash.g ?? [],
    reduced,
    still: !motion,
  });
  if (!plan.veil) veil?.el.remove();
  perform(plan, units, plan.veil ? veil : null);
}

// An image's page has no blocks to develop: on a first visit its pictures
// come in as a markdown page's do, from a blur to sharp. A page out of
// sight waits until it shows.
function arriveAtImage(hash: PageHash) {
  if (hash.d !== 'full' || hash.m === false) return;
  if (document.visibilityState === 'hidden') {
    whenShown = hash;
    return;
  }
  finishAll();
  const step = {start: 0, duration: DEVELOP.imageMs, easing: 'ease-out'};
  const running = [...imagePage!.querySelectorAll('.br-frame img')].map((image) => (reducedMotion.matches
    ? play(image, [{opacity: 0}, {opacity: 1}], {...step, duration: 160})
    : play(image, [{opacity: 0, filter: 'blur(6px)'}, {opacity: 1, filter: 'blur(0)'}], step)));
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    playing.length = 0;
    settleArrival = null;
  };
  settleArrival = settle;
  void Promise.all(running).then(settle);
  setTimeout(() => {
    if (!settled) finishAll();
  }, DEVELOP.imageMs + 500);
}

// ---------------------------------------------------------------------------
// An image's compare modes, as the TUI keys them: `1` side by side, `2`
// flip, `3` difference. Flip shows one side at a time; `f`, `2` again or a
// click on the picture turns it over. Difference lays the after side over
// the before side, so only what changed is light.

type Compare = 'side' | 'flip' | 'difference';
const COMPARES: readonly Compare[] = ['side', 'flip', 'difference'];
const comparing = Boolean(imagePage?.querySelector('.br-modes'));

function applyCompare(mode: Compare) {
  if (!imagePage || !comparing) return;
  imagePage.dataset.mode = mode;
  for (const button of imagePage.querySelectorAll<HTMLElement>('.br-mode')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
}

let compare: Compare = COMPARES.find((each) => each === store(COMPARE_KEY)) ?? 'side';
function chooseCompare(mode: Compare) {
  if (!comparing) return;
  if (mode === 'flip' && compare === 'flip') {
    turnOver();
    return;
  }
  compare = mode;
  store(COMPARE_KEY, mode);
  applyCompare(mode);
}

// Flip shows the after side first; each turn shows the other.
function turnOver() {
  if (!imagePage || compare !== 'flip') return;
  imagePage.classList.toggle('br-showing-before');
}

function toggleSwitch(name: 'board' | 'fit') {
  if (!imagePage) return;
  const off = imagePage.classList.toggle(name === 'board' ? 'br-board-off' : 'br-actual');
  imagePage.querySelector(`.br-${name}`)?.setAttribute('aria-pressed', String(!off));
}

// What won't resolve on GitHub on this page, in page order: the strip's
// chip steps from one to the next. Old text in `before` views and removed
// markers is no finding.
let finding = -1;
function nextFinding() {
  const all = [...document.querySelectorAll<HTMLElement>('.br-main :is(a.br-broken, .br-card.br-refused):not(:is(.br-before-body, .br-removed-body) *)')];
  if (all.length === 0) return;
  finding = (finding + 1) % all.length;
  const target = all[finding]!;
  target.scrollIntoView({block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth'});
  if (!reducedMotion.matches) void glow(target, {id: '', effect: 'glow', start: 0, duration: 600, easing: 'ease-out'});
}

// ---------------------------------------------------------------------------
// The page's keys and controls, shown only once this script runs.

function showControls() {
  for (const el of document.querySelectorAll<HTMLElement>('.br-js')) el.hidden = false;
}

const originalMedia = new WeakMap<HTMLSourceElement, string>();

function applyTheme(theme: Theme) {
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  // A <picture> picks its source by the system's scheme, so a forced theme
  // rewrites the sources that name one.
  for (const source of document.querySelectorAll<HTMLSourceElement>('.markdown-body picture > source[media]')) {
    const original = originalMedia.get(source) ?? source.media;
    originalMedia.set(source, original);
    const wants = /prefers-color-scheme:\s*(dark|light)/.exec(original)?.[1];
    if (wants) source.media = theme === 'auto' ? original : wants === theme ? 'all' : 'not all';
  }
  const button = document.querySelector('.br-theme');
  const name = button?.querySelector('.br-theme-name');
  if (name) name.textContent = THEME_NAMES[theme];
  button?.setAttribute('aria-label', `Theme: ${THEME_NAMES[theme]}`);
}

let theme: Theme = THEMES.find((each) => each === store(THEME_KEY)) ?? 'auto';
function cycleTheme() {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
  store(THEME_KEY, theme);
  applyTheme(theme);
}

function applyMarks(shown: boolean) {
  root.classList.toggle('br-marks-off', !shown);
  document.querySelector('.br-marks')?.setAttribute('aria-pressed', String(shown));
}

let marksShown = store(MARKS_KEY) !== 'off';
function toggleMarks() {
  marksShown = !marksShown;
  store(MARKS_KEY, marksShown ? 'on' : 'off');
  applyMarks(marksShown);
}

function toggleHelp(open?: boolean) {
  const help = document.getElementById('br-help');
  if (!help) return;
  help.hidden = !(open ?? help.hidden);
  document.querySelector('.br-help-button')?.setAttribute('aria-expanded', String(!help.hidden));
}

// Changes in page order: each marked block and each removed marker, as the
// file head counts them.
const changes = () => (article ? [...article.querySelectorAll<HTMLElement>('[data-mark], details.br-removed')] : []);

// The change a step would land on: the last one whose top has reached the
// step line, by the same rule `[` and `]` step by, and the one a step is
// scrolling to while it scrolls.
function currentChange(all: HTMLElement[]) {
  if (stepping && performance.now() < stepping.until) return Math.min(stepping.index, all.length - 1);
  const line = top() + CHANGE_INSET_PX + CHANGE_SLOP_PX;
  let index = 0;
  for (const [each, el] of all.entries()) if (el.getBoundingClientRect().top <= line) index = each;
  return index;
}

function showChangePosition() {
  const all = changes();
  const at = document.querySelector('.br-changes-at');
  if (at && all.length > 0) at.textContent = `change ${currentChange(all) + 1} of ${all.length}`;
}

// The change a step is scrolling to, while it scrolls: the next step goes
// on from there, not from wherever the smooth scroll has got to.
let stepping: {index: number; until: number} | null = null;

function stepChange(direction: 1 | -1) {
  const all = changes();
  if (all.length === 0) return;
  const line = top() + CHANGE_INSET_PX;
  let index = -1;
  if (stepping && performance.now() < stepping.until) {
    index = stepping.index + direction;
  } else {
    const tops = all.map((el) => el.getBoundingClientRect().top);
    if (direction === 1) index = tops.findIndex((y) => y > line + CHANGE_SLOP_PX);
    else for (const [each, y] of tops.entries()) if (y < line - CHANGE_SLOP_PX) index = each;
  }
  index = index < 0 ? (direction === 1 ? all.length - 1 : 0) : Math.min(index, all.length - 1);
  stepping = {index, until: performance.now() + STEP_SCROLL_MS};
  showChangePosition();
  const target = all[index]!;
  scrollTo({top: scrollY + target.getBoundingClientRect().top - line, behavior: reducedMotion.matches ? 'instant' : 'smooth'});
  if (!reducedMotion.matches) void glow(target, {id: '', effect: 'glow', start: 0, duration: 600, easing: 'ease-out'});
}

function stepFile(direction: 1 | -1) {
  // On a file page, the rail's files; on the overview, its rows.
  const files = [...document.querySelectorAll<HTMLAnchorElement>('.br-rail a.br-rail-file')];
  if (files.length > 0) {
    const index = files.findIndex((link) => link.classList.contains('br-current'));
    const next = files[index + direction];
    if (next) location.assign(next.href);
    return;
  }
  const rows = [...document.querySelectorAll<HTMLAnchorElement>('a.br-row')];
  const focused = rows.indexOf(document.activeElement as HTMLAnchorElement);
  const next = rows[focused < 0 ? (direction === 1 ? 0 : rows.length - 1) : focused + direction];
  next?.focus();
  next?.scrollIntoView({block: 'nearest'});
}

function onKey(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
  const actions: Record<string, () => void> = {
    ']': () => stepChange(1),
    '[': () => stepChange(-1),
    '}': () => stepFile(1),
    '{': () => stepFile(-1),
    t: cycleTheme,
    m: toggleMarks,
    ...(comparing ? {'1': () => chooseCompare('side'), '2': () => chooseCompare('flip'), '3': () => chooseCompare('difference'), f: turnOver} : {}),
    '?': () => toggleHelp(),
    Escape: () => toggleHelp(false),
  };
  const action = actions[event.key];
  if (!action) return;
  event.preventDefault();
  action();
}

function wire() {
  applyTheme(theme);
  applyMarks(marksShown);
  applyCompare(compare);
  showControls();
  showChangePosition();
  // Any input ends the arrival at once, and one still waiting for the page
  // to show is dropped: the reader is reading.
  const interrupt = () => {
    whenShown = null;
    finishAll();
  };
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) addEventListener(type, interrupt, {capture: true, passive: true});
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden' && whenShown) arrive(whenShown);
  });
  addEventListener('keydown', onKey);
  let queued = false;
  addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      showChangePosition();
      // An arrival's blocks are still moving; it keeps the place once it settles.
      if (!settleArrival) savePlace();
    });
  }, {passive: true});
  document.querySelector('.br-theme')?.addEventListener('click', cycleTheme);
  document.querySelector('.br-marks')?.addEventListener('click', toggleMarks);
  document.querySelector('.br-help-button')?.addEventListener('click', () => toggleHelp());
  for (const button of document.querySelectorAll<HTMLElement>('.br-mode')) {
    button.addEventListener('click', () => chooseCompare(button.dataset.mode as Compare));
  }
  document.querySelector('.br-board')?.addEventListener('click', () => toggleSwitch('board'));
  document.querySelector('.br-fit')?.addEventListener('click', () => toggleSwitch('fit'));
  imagePage?.querySelector('.br-compare')?.addEventListener('click', turnOver);
  // The strip's count of what won't resolve becomes a step through it.
  const chip = document.querySelector<HTMLElement>('span.br-findings');
  if (chip) {
    chip.setAttribute('role', 'button');
    chip.tabIndex = 0;
    chip.addEventListener('click', nextFinding);
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        nextFinding();
      }
    });
  }
  for (const button of document.querySelectorAll<HTMLElement>('.br-changes [data-step]')) {
    button.addEventListener('click', () => stepChange(button.dataset.step === '-1' ? -1 : 1));
  }
  // A before chip opening fades its old text in.
  article?.addEventListener('toggle', (event) => {
    const details = event.target as HTMLDetailsElement;
    if (!details.open || !details.matches('details.br-before') || reducedMotion.matches) return;
    details.querySelector('.br-before-body')?.animate([{opacity: 0}, {opacity: 1}], {duration: 120, easing: 'ease-out'});
  }, true);
  // A later trip to this page in the same split is a new hash, not a reload.
  addEventListener('hashchange', arriveAtLocation);
}

// The sanitizer gives every id on the page GitHub's `user-content-` prefix,
// and github.com still takes a heading's link as `#slug`: a pasted or typed
// one lands on its heading here too. The browser finds a hash that names an
// id itself, and our trip's hash has `=` in it, which no slug has.
function slugTarget(hash: string) {
  const slug = hash.replace(/^#/, '');
  if (slug === '' || slug.includes('=')) return null;
  try {
    return document.getElementById(`user-content-${decodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

function arriveAtLocation() {
  arrive(readPageHash(location.hash));
  slugTarget(location.hash)?.scrollIntoView({block: 'start', behavior: 'instant'});
}

wire();
arriveAtLocation();
