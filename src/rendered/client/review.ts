import {readReviewHash} from '../hash.js';
import {unpackDiff, wordRange, type CardDiff, type DrawnLine, type LineKind, type PackedDiff} from '../review/diff.js';
import {readSession, readStore, STORE_KEYS, writeSession, writeStore} from '../review/store.js';
import {expandGap, keptShown, tableHtml} from '../review/table.js';
import {relativeTime} from '../review/time.js';

// The Review in browser page's script. The page arrives drawn; this adds
// what a reader does on it: the theme, Unified and Split, context to
// expand, Source and Rich, collapsing and marking files viewed (kept in
// this browser for this review), the file tree and its filter, the menu,
// image compare modes, a long diff loaded in place, the keys, and the trip
// a press in the terminal makes: a hash that names the card to open at,
// which a split that is already open hears as a hashchange, or a live
// refresh's, which lands where the reader was, as they left each card,
// and pulses the cards the edit changed. Repo text only arrives here inside HTML the worker
// escaped and data this script reads as data.

type PageData = {id: string; cards: Array<{path?: string; diff: PackedDiff | null}>};
// `packed`: the diff as the data carries it, until its table is drawn
// again; `diff` then. `loaded`: its table is drawn, which a folded diff
// waits for the reader to ask.
type CardState = {packed: PackedDiff | null; diff: CardDiff | null; loaded: boolean; shown: number[]; viewed: boolean; collapsed: boolean};

const root = document.documentElement;
root.classList.add('rv-live');

const $ = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) => scope.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(selector: string, scope: ParentNode = document) => [...scope.querySelectorAll<T>(selector)];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const narrowSplit = matchMedia('(max-width: 700px)');
const narrowTree = matchMedia('(max-width: 900px)');

const data = JSON.parse($('#rv-data')!.textContent ?? '{}') as PageData;
const cards = $$<HTMLElement>('.rv-card');
// A card's path exactly as the repo names it.
const pathOf = (index: number) => {
  const path = data.cards[index]?.path;
  return typeof path === 'string' ? path : undefined;
};
const states: CardState[] = cards.map((_, index) => {
  const packed = data.cards[index]?.diff ?? null;
  return {packed, diff: null, loaded: !packed?.fold, shown: [], viewed: false, collapsed: false};
});
// Motion follows the trip that opened the page (`--no-animations` sends it
// off) and the system's reduced-motion setting.
let motion = readReviewHash(location.hash).m !== false;
const smooth = () => (motion && !reduced.matches ? 'smooth' : 'auto');

let layout: 'unified' | 'split' = readStore(STORE_KEYS.layout) === 'split' ? 'split' : 'unified';
const drawnLayout = () => (narrowSplit.matches ? 'unified' : layout);
let current = 0;
// While a jump scrolls, the file the scroll passes isn't the one picked.
let jumping = 0;

// ---------- Viewed, kept per review ----------
// Each mark keeps the file's diff signature: a mark made on an earlier diff
// of the file no longer holds, as on GitHub.
const viewedKey = STORE_KEYS.viewed + data.id;
// A file that only looks different has no Viewed box: it is no file to review.
const reviewable = (index: number) => $('[data-act="viewed"]', cards[index]) !== null;
const readViewed = (): Record<string, string> => {
  try {
    const parsed = JSON.parse(readStore(viewedKey) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, string> : {};
  } catch {
    return {};
  }
};
// Writes the one card's mark into the marks as stored now, so a mark made
// in another tab, or on a newer page of this review, stays as it is.
const saveViewed = (index: number) => {
  if (!reviewable(index)) return;
  const marks = readViewed();
  const card = cards[index]!;
  const key = card.dataset.vk!;
  if (states[index]!.viewed) marks[key] = card.dataset.sig!;
  else delete marks[key];
  writeStore(viewedKey, JSON.stringify(marks));
};

// ---------- Tables ----------
const KIND_OF: Record<string, LineKind> = {add: '+', del: '-'};

// The lines of the table the page arrived with, in order, as the diff
// model holds them: each row's kind, its numbers and its HTML after the
// marker. Only a table drawn unified with no context revealed reads so.
function drawnLines(box: HTMLElement): DrawnLine[] {
  return $$<HTMLTableRowElement>('tr:not(.hdr)', box).map((row) => {
    const [old, now] = $$('td.ln', row).map((cell) => cell.dataset.n);
    const code = $('td.cd', row)!.cloneNode(true) as HTMLElement;
    code.querySelector(':scope > .mk')?.remove();
    return {t: KIND_OF[row.className] ?? ' ', ...(old ? {o: Number(old)} : {}), ...(now ? {n: Number(now)} : {}), h: code.innerHTML};
  });
}

// A card's diff, read the first time the script draws its table.
function diffOf(index: number) {
  const state = states[index]!;
  if (!state.diff && state.packed) state.diff = unpackDiff(state.packed, state.packed.fold ? [] : drawnLines($('.rv-tbl', cards[index]!)!));
  return state.diff;
}

function drawTable(index: number, fresh?: number) {
  const state = states[index]!;
  const box = $('.rv-tbl', cards[index]!);
  if (!state.packed || !box || !state.loaded) return;
  box.innerHTML = tableHtml(diffOf(index)!, state.shown, drawnLayout(), fresh);
}

// A folded diff, drawn in place from the page's data.
function loadDiff(index: number) {
  const state = states[index]!;
  const card = cards[index]!;
  if (state.loaded || !state.packed) return;
  state.loaded = true;
  $('.rv-tbl', card)!.hidden = false;
  $('.rv-load', card)?.remove();
  drawTable(index);
  rememberCard(index);
}

function setLayout(next: 'unified' | 'split', redraw = true) {
  layout = next;
  writeStore(STORE_KEYS.layout, next);
  for (const button of $$('[data-act="mode"]')) button.setAttribute('aria-pressed', String(button.dataset.m === next));
  if (redraw) for (const index of cards.keys()) drawTable(index);
}

// ---------- Theme ----------
function applyTheme(theme: string) {
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  for (const button of $$('[data-theme-set]')) button.setAttribute('aria-pressed', String(button.dataset.themeSet === (theme === 'light' || theme === 'dark' ? theme : 'auto')));
}

// ---------- Toast and copy ----------
let toastTimer = 0;
function toast(message: string) {
  const box = $('#toast')!;
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    box.hidden = true;
  }, 1800);
}

// The clipboard gets the exact path, from the page's data; the toast says
// it as the page shows it, each hidden character a marker.
function copyPath(index: number) {
  const card = cards[index]!;
  const text = card.getAttribute('aria-label') ?? '';
  const path = pathOf(index) ?? text;
  const fallback = () => toast(`Path: ${text}`);
  try {
    const writing = navigator.clipboard?.writeText(path);
    if (writing) writing.then(() => toast(`Copied ${text}`), fallback);
    else fallback();
  } catch {
    fallback();
  }
}

// ---------- Current file, jumps, collapse, viewed ----------
function setCurrent(index: number) {
  current = index;
  for (const row of $$<HTMLElement>('.rv-file')) {
    const on = Number(row.dataset.i) === index;
    row.classList.toggle('rv-on', on);
    if (on) row.setAttribute('aria-current', 'true');
    else row.removeAttribute('aria-current');
  }
}

// A glow on the card a jump lands at, once. None with motion off
// (`--no-animations`), which asks for the page's final state at once.
function flash(card: HTMLElement) {
  if (!motion) return;
  card.classList.remove('rv-flash');
  void card.offsetWidth;
  card.classList.add('rv-flash');
  window.setTimeout(() => card.classList.remove('rv-flash'), 1400);
}

// `instant`: the page's first arrival, which lands at once, as an anchor
// does: a glide from the top would carry the reader past every card above.
function goTo(index: number, highlight = true, instant = false) {
  const card = cards[index];
  if (!card || $('#panel-files')!.hidden) return;
  setCurrent(index);
  jumping = Date.now() + 900;
  card.scrollIntoView({behavior: instant ? 'auto' : smooth(), block: 'start'});
  if (highlight) flash(card);
}

const headerAbove = (index: number) => cards[index]!.getBoundingClientRect().top < $('#toolbar')!.getBoundingClientRect().bottom;

// `keepPlace`: folding a card whose header scrolled past brings it back
// under the toolbar; folding them all keeps the reader's place by the card
// they folded from.
function setCollapsed(index: number, collapsed: boolean, {keepPlace = true}: {keepPlace?: boolean} = {}) {
  const card = cards[index]!;
  const above = keepPlace && headerAbove(index);
  states[index]!.collapsed = collapsed;
  card.classList.toggle('rv-collapsed', collapsed);
  const chevron = $('[data-act="collapse"]', card)!;
  chevron.setAttribute('aria-expanded', String(!collapsed));
  chevron.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${card.getAttribute('aria-label') ?? ''}`);
  // Folding a card whose header scrolled past keeps the reader at it.
  if (collapsed && above) card.scrollIntoView({block: 'start'});
  rememberCard(index);
}

function updateProgress() {
  const viewed = states.filter((state) => state.viewed).length;
  const of = cards.filter((_, index) => reviewable(index)).length;
  $('#viewed-n')!.textContent = String(viewed);
  const ring = $('#ring')!;
  const length = Number(ring.getAttribute('stroke-dasharray'));
  ring.setAttribute('stroke-dashoffset', String(of === 0 ? length : length - (length * viewed) / of));
}

function setViewed(index: number, viewed: boolean, save = true) {
  if (!reviewable(index)) return;
  const card = cards[index]!;
  states[index]!.viewed = viewed;
  card.classList.toggle('rv-is-viewed', viewed);
  $<HTMLInputElement>('[data-act="viewed"]', card)!.checked = viewed;
  $(`.rv-file[data-i="${index}"]`)?.classList.toggle('rv-is-viewed', viewed);
  setCollapsed(index, viewed);
  updateProgress();
  if (save) saveViewed(index);
}

function setView(index: number, view: string) {
  const card = cards[index]!;
  const source = $('.rv-v-src', card);
  const rich = $('.rv-v-rich', card);
  if (!source || !rich) return;
  source.hidden = view !== 'source';
  rich.hidden = view !== 'rich';
  for (const button of $$('[data-act="view"]', card)) button.setAttribute('aria-pressed', String(button.dataset.v === view));
  rememberCard(index);
}

// ---------- Tree, drawer, menu, keys ----------
const sidebar = $('#sidebar')!;
function openDrawer(open: boolean) {
  sidebar.classList.toggle('rv-open', open);
  $('#drawer-back')!.classList.toggle('rv-open', open);
  $('.rv-tree-btn')!.setAttribute('aria-expanded', String(open));
  if (open) window.setTimeout(() => $<HTMLInputElement>('#file-filter')?.focus(), 30);
}

function toggleTree() {
  if (narrowTree.matches) {
    openDrawer(!sidebar.classList.contains('rv-open'));
    return;
  }
  hideTree(!$('#panel-files')!.classList.contains('rv-no-tree'));
}

// The wide layout's tree, hidden or shown, as page memory keeps it.
function hideTree(hide: boolean) {
  const panel = $('#panel-files')!;
  writePage({tree: hide ? 0 : undefined});
  panel.classList.toggle('rv-no-tree', hide);
  const button = $('.rv-tree-btn')!;
  button.setAttribute('aria-expanded', String(!hide));
  button.setAttribute('aria-label', hide ? 'Show file tree' : 'Hide file tree');
  button.title = hide ? 'Show file tree' : 'Hide file tree';
}

const menu = $('#menu')!;
let menuFor = -1;
let menuButton: HTMLElement | null = null;
function openMenu(button: HTMLElement, index: number) {
  closeMenu();
  menuFor = index;
  menuButton = button;
  $('.rv-mv', menu)!.textContent = states[index]!.viewed ? 'Mark as not viewed' : 'Mark as viewed';
  menu.hidden = false;
  const box = button.getBoundingClientRect();
  const width = menu.offsetWidth;
  const left = Math.max(8, Math.min(box.right - width, root.clientWidth - width - 8));
  menu.style.left = `${left + scrollX}px`;
  menu.style.top = `${box.bottom + 4 + scrollY}px`;
  button.setAttribute('aria-expanded', 'true');
  $('button', menu)?.focus();
}

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  menuButton?.setAttribute('aria-expanded', 'false');
  menuFor = -1;
}

const keys = $('#keys')!;
let keysReturn: Element | null = null;
function openKeys() {
  keysReturn = document.activeElement;
  keys.hidden = false;
  $('[data-act="keys-close"]', keys)?.focus();
}
function closeKeys() {
  keys.hidden = true;
  if (keysReturn instanceof HTMLElement) keysReturn.focus();
}

// `remember`: the reader's own switch, which a live refresh keeps.
function setTab(tab: string, remember = false) {
  const files = tab === 'files';
  if (remember) writePage({tab: files ? 'files' : 'commits', ...(files ? {} : {cy: Math.round(scrollY)})});
  for (const button of $$('[data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
  $('#panel-files')!.hidden = !files;
  $('#panel-commits')!.hidden = files;
  $('#toolbar')!.hidden = !files;
}

// ---------- Images ----------
// The swipe and onion stages' pictures carry no data of their own: each
// takes its side's from the 2-up picture the first time its mode shows.
function setImageMode(card: HTMLElement, mode: string) {
  for (const button of $$('[data-act="imode"]', card)) button.setAttribute('aria-pressed', String(button.dataset.im === mode));
  for (const panel of $$('[data-im-panel]', card)) panel.hidden = panel.dataset.imPanel !== mode;
  for (const image of $$<HTMLImageElement>(`[data-im-panel="${mode}"] img[data-from]:not([src])`, card)) {
    const from = $<HTMLImageElement>(`.rv-two-up .rv-${image.dataset.from === 'before' ? 'before' : 'after'} img`, card)?.getAttribute('src');
    if (from?.startsWith('data:')) image.setAttribute('src', from);
  }
}

function setSwipe(stage: HTMLElement, percent: number) {
  const at = Math.max(0, Math.min(100, percent));
  stage.style.setProperty('--x', `${at}%`);
  $('.rv-handle', stage)?.setAttribute('aria-valuenow', String(Math.round(at)));
}

for (const stage of $$('.rv-swipe')) {
  let dragging = false;
  const at = (event: PointerEvent) => {
    const box = stage.getBoundingClientRect();
    return ((event.clientX - box.left) / box.width) * 100;
  };
  stage.addEventListener('pointerdown', (event) => {
    dragging = true;
    stage.setPointerCapture(event.pointerId);
    setSwipe(stage, at(event));
  });
  stage.addEventListener('pointermove', (event) => {
    if (dragging) setSwipe(stage, at(event));
  });
  const stop = () => {
    dragging = false;
  };
  stage.addEventListener('pointerup', stop);
  stage.addEventListener('pointercancel', stop);
  const handle = $('.rv-handle', stage)!;
  handle.addEventListener('keydown', (event) => {
    const now = Number(handle.getAttribute('aria-valuenow'));
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      setSwipe(stage, now + (event.key === 'ArrowLeft' ? -5 : 5));
    }
  });
}

for (const range of $$<HTMLInputElement>('.rv-onion-ctl input')) {
  range.addEventListener('input', () => {
    range.closest('.rv-im')!.querySelector<HTMLElement>('.rv-onion')!.style.setProperty('--o', String(Number(range.value) / 100));
  });
}

// ---------- Rich views ----------
// The renderer marks a table row by row, each changed row with its own
// before chip in its last cell. Here a changed table is one block: its
// rows' old views gather into one old table, under one chip after it. And
// a changed block's chip moves to the end of the block's last line of
// text, or to the corner of a block with no line of text, as GitHub's rich
// diff places it; its old view still opens under the block. The words a
// changed paragraph, heading or quote gained are marked, as the source
// diff marks a changed line's.
const befores = new WeakMap<HTMLElement, HTMLDetailsElement>();

const sectionOf = (row: Element) => (row.parentElement?.tagName === 'THEAD' ? 'thead' : 'tbody');

// A row as it was, with none of the page's marks.
function plainRow(row: Element) {
  const copy = row.cloneNode(true) as Element;
  for (const each of [copy, ...copy.querySelectorAll('*')]) {
    for (const name of ['data-mark', 'data-block', 'data-lines', 'id', 'name']) each.removeAttribute(name);
  }
  for (const chip of copy.querySelectorAll('details.br-before')) chip.remove();
  return copy;
}

function regroupTable(table: HTMLTableElement) {
  const rows = [...table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr')];
  if (!rows.some((row) => row.hasAttribute('data-mark') || row.classList.contains('br-removed-row'))) return;
  table.classList.add('rv-tchanged');
  if (rows.every((row) => row.getAttribute('data-mark') === 'added')) table.classList.add('rv-tadded');
  const chips = rows.flatMap((row) => [...row.querySelectorAll<HTMLDetailsElement>(':scope > :is(td, th) > details.br-before')]);
  const removed = rows.filter((row) => row.classList.contains('br-removed-row'));
  if (chips.length === 0 && removed.length === 0) return;
  // The old table: each row as it was where it was, the removed ones back,
  // the added ones out.
  const old = document.createElement('table');
  const sections = {thead: document.createElement('thead'), tbody: document.createElement('tbody')};
  for (const row of rows) {
    if (row.getAttribute('data-mark') === 'added') continue;
    const chip = row.querySelector(':scope > :is(td, th) > details.br-before');
    const was = row.classList.contains('br-removed-row') ? [...row.querySelectorAll('.br-removed-body tbody > tr')]
      : chip ? [...chip.querySelectorAll(`.br-before-body ${sectionOf(row)} > tr`)].slice(-1) : [row];
    for (const each of was) sections[row.classList.contains('br-removed-row') ? 'tbody' : sectionOf(row)].append(plainRow(each));
  }
  old.append(...[sections.thead, sections.tbody].filter((section) => section.rows.length > 0));
  for (const chip of chips) chip.remove();
  const box = document.createElement('details');
  box.className = 'br-before rv-tbefore';
  const summary = document.createElement('summary');
  summary.textContent = 'before';
  const body = document.createElement('div');
  body.className = 'br-before-body';
  body.append(old);
  box.append(summary, body);
  table.after(box);
}

const TEXT_BLOCK = 'p, h1, h2, h3, h4, h5, h6';

// Marks what the block's text gained over its old view's, the span between
// what they share at the start and at the end, across the text nodes it
// runs over, each piece in its own <ins>.
function markWords(block: HTMLElement, box: HTMLDetailsElement) {
  const range = wordRange($('.br-before-body', box)?.textContent ?? '', block.textContent ?? '');
  if (!range) return;
  const [from, to] = range[1];
  const pieces: Array<{node: Text; start: number; end: number}> = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let at = 0, node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const start = Math.max(from, at) - at;
    const end = Math.min(to, at + node.length) - at;
    if (start < end) pieces.push({node, start, end});
    at += node.length;
  }
  for (const {node, start, end} of pieces) {
    const piece = node.splitText(start);
    piece.splitText(end - start);
    if (piece.data.trim() === '') continue;
    const mark = document.createElement('ins');
    mark.className = 'rv-word';
    piece.replaceWith(mark);
    mark.append(piece);
  }
}

function moveChip(box: HTMLDetailsElement) {
  const block = box.previousElementSibling as HTMLElement | null;
  // An item's chip already follows its last word.
  if (!block?.matches('[data-mark="modified"]') || box.parentElement?.tagName === 'LI') return;
  const text = block.matches(TEXT_BLOCK) ? block : block.matches('blockquote, .markdown-alert') ? [...block.querySelectorAll<HTMLElement>(':scope > p')].at(-1) ?? null : null;
  if (text) markWords(block, box);
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = text ? 'rv-chip-before' : 'rv-chip-before rv-corner';
  chip.dataset.act = 'before';
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-label', 'Show this block before the change');
  chip.textContent = 'before';
  (text ?? block).append(chip);
  box.classList.add('rv-moved');
  befores.set(chip, box);
}

function regroupRich() {
  for (const article of $$('.rv-rich .markdown-body')) {
    for (const table of $$<HTMLTableElement>('table', article)) {
      if (!table.closest('.br-before-body, .br-removed-body')) regroupTable(table);
    }
    for (const box of $$<HTMLDetailsElement>('details.br-before:not(.rv-tbefore)', article)) {
      if (!box.closest('.br-before-body, .br-removed-body, td, th')) moveChip(box);
    }
  }
}

// ---------- Events ----------
// A link in a rich view that opens another file in the review names that
// file's card and its rich view, `#file-<n>&v=rich`, with any heading as
// `&h=<id>` (review/page.ts): it jumps to the file's card, in its rich
// view. A link to a heading on the same file lands in the same card, where
// that file's ids are.
const CARD_LINK = /^#file-(\d{1,6})&v=rich(?:&h=(.*))?$/;
function followLink(link: HTMLAnchorElement): boolean {
  const href = link.getAttribute('href') ?? '';
  const page = CARD_LINK.exec(href);
  if (!page && !href.startsWith('#')) return false;
  const index = page ? Number(page[1]) : Number(link.closest<HTMLElement>('.rv-card')?.dataset.i);
  const into = cards[index];
  if (!into) return false;
  const id = page ? page[2] : href.slice(1);
  if (page && $('.rv-v-rich', into)) setView(index, 'rich');
  if (states[index]!.collapsed) setCollapsed(index, false);
  const heading = id ? [...into.querySelectorAll<HTMLElement>('[id], [name]')].find((each) => each.id === id || each.getAttribute('name') === id) : null;
  if (heading) {
    setCurrent(index);
    jumping = Date.now() + 900;
    heading.scrollIntoView({behavior: smooth(), block: 'start'});
  } else {
    goTo(index);
  }
  return true;
}

document.addEventListener('click', (event) => {
  const target = event.target as Element;
  if (!menu.hidden && !target.closest('#menu') && !target.closest('[data-act="menu"]')) closeMenu();
  const link = target.closest<HTMLAnchorElement>('.rv-rich a[href]');
  if (link) {
    if (followLink(link)) event.preventDefault();
    return;
  }
  const item = target.closest<HTMLElement>('[data-menu]');
  if (item) {
    const index = menuFor;
    closeMenu();
    if (index < 0) return;
    switch (item.dataset.menu) {
      case 'copy':
        copyPath(index);
        break;
      case 'viewed':
        setViewed(index, !states[index]!.viewed);
        break;
      case 'tree': {
        if (narrowTree.matches) openDrawer(true);
        else if ($('#panel-files')!.classList.contains('rv-no-tree')) toggleTree();
        setCurrent(index);
        $(`.rv-file[data-i="${index}"]`)?.scrollIntoView({block: 'nearest'});
        break;
      }
      case 'collapse-all':
      case 'expand-all': {
        // The reader stays at the card whose menu they used.
        const fold = item.dataset.menu === 'collapse-all';
        for (const each of cards.keys()) setCollapsed(each, fold, {keepPlace: false});
        setCurrent(index);
        jumping = Date.now() + 900;
        cards[index]!.scrollIntoView({behavior: 'auto', block: 'start'});
        break;
      }
    }
    return;
  }
  const control = target.closest<HTMLElement>('[data-act], [data-theme-set], [data-tab]');
  if (!control) return;
  if (control.dataset.themeSet) {
    applyTheme(control.dataset.themeSet);
    writeStore(STORE_KEYS.theme, control.dataset.themeSet);
    return;
  }
  if (control.dataset.tab) {
    setTab(control.dataset.tab, true);
    return;
  }
  const card = control.closest<HTMLElement>('.rv-card');
  const index = card ? Number(card.dataset.i) : -1;
  switch (control.dataset.act) {
    case 'collapse':
      setCollapsed(index, !states[index]!.collapsed);
      break;
    case 'copy':
      copyPath(index);
      break;
    case 'view':
      setView(index, control.dataset.v!);
      break;
    case 'menu':
      if (menuFor === index) closeMenu();
      else openMenu(control, index);
      break;
    case 'mode':
      setLayout(control.dataset.m === 'split' ? 'split' : 'unified');
      break;
    case 'imode':
      setImageMode(card!, control.dataset.im!);
      break;
    case 'goto':
      event.preventDefault();
      goTo(Number(control.dataset.i));
      if (narrowTree.matches) openDrawer(false);
      break;
    case 'dir': {
      const item = control.parentElement!;
      const shut = item.classList.toggle('rv-shut');
      item.setAttribute('aria-expanded', String(!shut));
      break;
    }
    case 'tree':
      toggleTree();
      break;
    case 'drawer-close':
      openDrawer(false);
      break;
    case 'keys':
      openKeys();
      break;
    case 'keys-close':
      closeKeys();
      break;
    case 'dismiss':
      $('#note')!.hidden = true;
      writeStore(STORE_KEYS.note, 'dismissed');
      break;
    case 'report-close':
      $('#report')!.hidden = true;
      writePage({report: 0});
      break;
    case 'before': {
      const box = befores.get(control);
      if (!box) break;
      box.open = !box.open;
      control.setAttribute('aria-expanded', String(box.open));
      break;
    }
    case 'load':
      loadDiff(index);
      break;
    case 'expand': {
      const state = states[index]!;
      const diff = diffOf(index);
      if (!diff) break;
      const gap = Number(control.dataset.g);
      state.shown = expandGap(diff, state.shown, gap);
      drawTable(index, gap);
      rememberCard(index);
      break;
    }
  }
});

keys.addEventListener('click', (event) => {
  if (event.target === keys) closeKeys();
});

document.addEventListener('change', (event) => {
  const target = event.target as HTMLInputElement;
  if (target.dataset?.act === 'viewed') setViewed(Number(target.closest<HTMLElement>('.rv-card')!.dataset.i), target.checked);
});

$<HTMLInputElement>('#file-filter')?.addEventListener('input', (event) => {
  const query = (event.target as HTMLInputElement).value.trim().toLowerCase();
  let any = false;
  for (const item of $$<HTMLElement>('#tree li[data-path]')) {
    const hit = !query || (pathOf(Number($<HTMLElement>('.rv-file', item)?.dataset.i)) ?? '').toLowerCase().includes(query);
    item.hidden = !hit;
    any ||= hit;
  }
  for (const dir of $$<HTMLElement>('#tree .rv-dir')) dir.hidden = !$$<HTMLElement>('li[data-path]', dir).some((item) => !item.hidden);
  $('#tree-empty')!.hidden = any;
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!keys.hidden) {
      closeKeys();
      return;
    }
    if (!menu.hidden) {
      const button = menuButton;
      closeMenu();
      button?.focus();
      return;
    }
    if (sidebar.classList.contains('rv-open')) openDrawer(false);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target as HTMLElement;
  const tag = target.tagName?.toLowerCase();
  if ((tag === 'input' && (target as HTMLInputElement).type !== 'checkbox') || tag === 'textarea' || target.isContentEditable) return;
  if (!keys.hidden) return;
  if (event.key === '?') {
    event.preventDefault();
    openKeys();
    return;
  }
  if ($('#panel-files')!.hidden || cards.length === 0) return;
  if (event.key === 'j') {
    event.preventDefault();
    goTo(Math.min(cards.length - 1, current + 1));
  } else if (event.key === 'k') {
    event.preventDefault();
    goTo(Math.max(0, current - 1));
  } else if (event.key === 'v' && reviewable(current)) {
    event.preventDefault();
    const viewed = !states[current]!.viewed;
    setViewed(current, viewed);
    if (viewed && current < cards.length - 1) goTo(current + 1, false);
  }
});

// The current file follows the scroll: the last card whose top passed a
// line just under the toolbar.
let ticking = false;
function onScroll() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    if ($('#panel-files')!.hidden) {
      savePlace();
      return;
    }
    // A scroll during a jump still moves the reader's place, which a live
    // refresh lands at; only the file the jump picked stays current.
    savePlace();
    if (Date.now() < jumping) return;
    const at = cardAtLine();
    if (at !== current) setCurrent(at);
  });
}

// The last card whose top passed a line just under the toolbar.
function cardAtLine() {
  const line = $('#toolbar')!.getBoundingClientRect().bottom + 60;
  let at = 0;
  for (const [index, card] of cards.entries()) if (card.getBoundingClientRect().top <= line) at = index;
  return at;
}

// Where the reader is: the card at the line, and how far down it the top
// of the window is, kept for this tab, which a live refresh lands at.
const placeKey = STORE_KEYS.place + data.id;
// While Commits shows, its scroll is kept, and the Files place as it was.
function savePlace() {
  if ($('#panel-files')!.hidden) {
    writePage({tab: 'commits', cy: Math.round(scrollY)});
    return;
  }
  const at = cardAtLine();
  const card = cards[at];
  // By the file's view key, which a newer page with a file added above it
  // still gives the same card.
  if (card) writeSession(placeKey, JSON.stringify({vk: card.dataset.vk, dy: Math.round(-card.getBoundingClientRect().top)}));
}
function readPlace(): {i: number; dy: number} | null {
  try {
    const place = JSON.parse(readSession(placeKey) ?? 'null') as {vk?: unknown; dy?: unknown} | null;
    const index = place && typeof place.vk === 'string' ? cards.findIndex((card) => card.dataset.vk === place.vk) : -1;
    return index >= 0 && typeof place!.dy === 'number' ? {i: index, dy: place!.dy} : null;
  } catch {
    return null;
  }
}
addEventListener('scroll', onScroll, {passive: true});
narrowSplit.addEventListener('change', () => setLayout(layout));
narrowTree.addEventListener('change', () => {
  if (!narrowTree.matches) openDrawer(false);
});

// ---------- What a live refresh keeps ----------
// What the reader did to the page in this tab: the tab they left it on
// and how far down Commits they were, a report they closed, a tree they
// hid. A press starts the page afresh.
type PageMemory = {tab?: 'files' | 'commits'; cy?: number; report?: 0; tree?: 0};
const pageKey = STORE_KEYS.page + data.id;
function readPage(): PageMemory {
  try {
    const parsed = JSON.parse(readSession(pageKey) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as PageMemory : {};
  } catch {
    return {};
  }
}
// Merges `update` into what is kept; a field set to undefined goes.
function writePage(update: {[K in keyof PageMemory]?: PageMemory[K] | undefined}) {
  writeSession(pageKey, JSON.stringify({...readPage(), ...update}));
}

// What the reader did to each card in this tab, by its view key: the view
// they switched to, whether they left it folded or open, whether they
// loaded its diff. A live refresh draws the newer page the same way before
// it scrolls back, so the reader lands where they were among cards that
// look as they left them: a Viewed card they opened again stays open. A
// card the edit changed opens again, as an edit clears its Viewed.
type CardMemory = {v?: string; c?: 0 | 1; l?: 1; s?: number[]};
const cardsKey = STORE_KEYS.cards + data.id;
const readMemory = (): Record<string, CardMemory> => {
  try {
    const parsed = JSON.parse(readSession(cardsKey) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, CardMemory> : {};
  } catch {
    return {};
  }
};
// Off while the page sets its cards up from storage, which is no reader's
// doing. `force`: a press's own doing as the page loads, which a refresh
// keeps (a Viewed card the press opened stays open).
let remembering = false;
function rememberCard(index: number, force = false) {
  if (!remembering && !force) return;
  const card = cards[index]!;
  const rich = $('.rv-v-rich', card);
  const memory = readMemory();
  const state = states[index]!;
  const entry: CardMemory = {
    ...(rich && !rich.hidden ? {v: 'rich'} : rich ? {v: 'source'} : {}),
    c: state.collapsed ? 1 : 0,
    ...(state.loaded && state.packed?.fold ? {l: 1 as const} : {}),
    // A gap never opened is a hole in the array: kept as 0.
    ...(state.shown.some((count) => count > 0) ? {s: Array.from(state.shown, (count) => count ?? 0)} : {}),
  };
  memory[card.dataset.vk!] = entry;
  writeSession(cardsKey, JSON.stringify(memory));
}

// Each card's signature on the page this tab showed last, and the cards
// whose signature differs here: those a live refresh pulses. A card new
// to the review differs too.
const signaturesKey = STORE_KEYS.signatures + data.id;
const changed = (() => {
  let before: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(readSession(signaturesKey) ?? 'null') as unknown;
    if (parsed && typeof parsed === 'object') before = parsed as Record<string, string>;
  } catch {
    before = null;
  }
  writeSession(signaturesKey, JSON.stringify(Object.fromEntries(cards.map((card) => [card.dataset.vk!, card.dataset.sig!]))));
  return new Set(before ? cards.flatMap((card, index) => (before![card.dataset.vk!] === card.dataset.sig ? [] : [index])) : []);
})();

function restoreCards() {
  const memory = readMemory();
  let reopened = false;
  for (const [index, card] of cards.entries()) {
    const entry = memory[card.dataset.vk!];
    if (!entry) continue;
    if (entry.v === 'rich' || entry.v === 'source') setView(index, entry.v);
    if (entry.l) loadDiff(index);
    // The context the reader opened, on a card the edit left as it was, as
    // far as this page carries it: the same diff can arrive with less of
    // its file. A card that can't be drawn so stays as it arrived, and the
    // rest of the page still lands.
    const shown = entry.s;
    if (!changed.has(index) && Array.isArray(shown) && shown.length <= 10_000 && shown.every((count) => Number.isInteger(count) && count >= 0)) {
      try {
        const diff = diffOf(index);
        if (diff) {
          states[index]!.shown = keptShown(diff, shown);
          drawTable(index);
        }
      } catch {
        states[index]!.shown = [];
      }
    }
    // After the viewed marks, which fold their cards as the page loads.
    if (entry.c === undefined) continue;
    if (!changed.has(index)) {
      setCollapsed(index, entry.c === 1);
    } else if (entry.c === 1) {
      // A changed card arrives open, and stays as the reader now sees it:
      // the next refresh that leaves it alone keeps it open.
      entry.c = 0;
      reopened = true;
    }
  }
  if (reopened) writeSession(cardsKey, JSON.stringify(memory));
}

// A soft wash of the accent over a card the edit changed, once. None
// with motion off or reduced: the card's Viewed box and counts say it.
function pulse() {
  if (!motion || reduced.matches) return;
  for (const index of changed) {
    const card = cards[index]!;
    card.classList.add('rv-pulse');
    window.setTimeout(() => card.classList.remove('rv-pulse'), 700);
  }
}

// What a press on the open page puts back: the tree, the report, and each
// card's context closed. A card's view, fold and loaded diff stay.
function resetPage() {
  if ($('#panel-files')!.classList.contains('rv-no-tree')) hideTree(false);
  const report = $('#report');
  if (report) report.hidden = false;
  for (const [index, state] of states.entries()) {
    if (!state.shown.some((count) => count > 0)) continue;
    state.shown = [];
    drawTable(index);
    rememberCard(index, true);
  }
}

// ---------- The scanline ----------
// The head script arms the first arrival; this clears it once it has
// played, and plays it again for a later press that only changes the hash
// of a page already open. The curtain takes 700 ms with its delay.
const ARRIVAL_MS = 900;
let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
function scanIn(hash: ReturnType<typeof readReviewHash>, again: boolean) {
  if (again) {
    if (!hash.m || hash.n === undefined || hash.l || reduced.matches) return;
    root.classList.remove('rv-arriving');
    // A reflow between the two, so the animation starts over.
    void root.offsetWidth;
    root.classList.add('rv-arriving');
  }
  if (!root.classList.contains('rv-arriving')) return;
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => root.classList.remove('rv-arriving'), ARRIVAL_MS);
}

// ---------- Arrival ----------
// A trip names the card to open at, which glows once; a trip with no card
// opens the page at its top. A press on the same file again, to a split
// that shows the page already, arrives as a new hash, which glides there.
// `first`: the page's own load, which lands at once.
function arrive(first = false) {
  const hash = readReviewHash(location.hash);
  if (hash.m !== undefined) motion = hash.m;
  scanIn(hash, !first);
  // A live refresh: back where the reader was, with the page and each card
  // as they left them, no glow and no motion but a pulse on what changed.
  if (hash.l && first) {
    const kept = readPage();
    // The tree first: it changes how wide every card is.
    if (kept.tree === 0 && !narrowTree.matches && !$('#panel-files')!.classList.contains('rv-no-tree')) toggleTree();
    if (kept.report === 0 && $('#report')) $('#report')!.hidden = true;
    restoreCards();
    pulse();
    if (kept.tab === 'commits') {
      setTab('commits');
      scrollTo({top: typeof kept.cy === 'number' ? kept.cy : 0, behavior: 'auto'});
      return;
    }
  } else {
    // A press opens the page as it arrives: what the reader did before it
    // is no longer theirs to come back to. On the page already open, the
    // tree, the report and the context come back as a new page shows them,
    // so the next live refresh, which reads what is kept, finds the page
    // as the reader sees it.
    if (first) writeSession(cardsKey, '{}');
    else resetPage();
    writeSession(pageKey, '{}');
  }
  setTab('files');
  const place = hash.l ? readPlace() : null;
  // The card at the reader's place stays as they left it, folded or open,
  // so the distance kept down it still lands on the same line.
  if (place && cards[place.i]) {
    setCurrent(place.i);
    jumping = Date.now() + 900;
    scrollTo({top: cards[place.i]!.getBoundingClientRect().top + scrollY + place.dy, behavior: 'auto'});
    return;
  }
  if (hash.l && hash.file !== undefined && cards[hash.file]) {
    setCurrent(hash.file);
    jumping = Date.now() + 900;
    cards[hash.file]!.scrollIntoView({behavior: 'auto', block: 'start'});
    return;
  }
  if (hash.file !== undefined && cards[hash.file]) {
    if (states[hash.file]!.collapsed) {
      setCollapsed(hash.file, false);
      // Kept, so a live refresh doesn't fold it again from its Viewed mark.
      rememberCard(hash.file, true);
    }
    goTo(hash.file, true, first);
  } else {
    jumping = Date.now() + 900;
    scrollTo({top: 0, behavior: first ? 'auto' : smooth()});
    setCurrent(0);
  }
}
addEventListener('hashchange', () => arrive());
addEventListener('pagehide', savePlace);

// Relative times stay true while the page stays open.
function refreshTimes() {
  const now = Date.now() / 1000;
  for (const time of $$<HTMLElement>('time[data-t]')) time.textContent = relativeTime(Number(time.dataset.t), now);
}
setInterval(refreshTimes, 60_000);

regroupRich();
applyTheme(readStore(STORE_KEYS.theme) ?? 'auto');
if (readStore(STORE_KEYS.note) === 'dismissed') $('#note')!.hidden = true;
const marks = readViewed();
for (const [index, card] of cards.entries()) {
  if (marks[card.dataset.vk!] === card.dataset.sig) setViewed(index, true, false);
}
// A mark made on another diff of a file isn't applied here, and stays
// stored: it may be the mark of a newer page of this review.
updateProgress();
// The page arrives drawn unified: only a split layout draws again.
setLayout(layout, drawnLayout() === 'split');
refreshTimes();
arrive(true);
remembering = true;
