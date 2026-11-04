// The page's arrival from a press in the TUI, drawn on a canvas over the
// page: the page's background stands in for it, every line of text in view
// shows as scrambled glyphs, and a teal to violet scanline sweeps down once.
// Each line the scanline passes decodes left to right into its real text,
// its leading edge in the brand colors. The glyphs mix letters with the
// specks the TUI's launch sends off, so the two halves read as one trip.
// The page itself is never touched: the canvas only covers it, so nothing
// reflows. Lines are measured again as the page scrolls or lays out.

/** The scanline waits this long after the page shows, as the CSS curtain does. */
export const DECODE_DELAY_MS = 80;
/** How long the scanline takes from the top of the window to the bottom. */
export const DECODE_SWEEP_MS = 620;
/** How long one line takes to decode once the scanline reaches it. */
export const DECODE_LINE_MS = 200;
/** The whole arrival: the last line in view has decoded by then. */
export const DECODE_MS = DECODE_DELAY_MS + DECODE_SWEEP_MS + DECODE_LINE_MS;

/** The glyphs a line shows before it decodes: letters, code, and the TUI's specks. */
export const DECODE_GLYPHS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0123456789{}[]<>/=+*#%&$⣿⠿⠶⠖⠒';

// How often the scrambled glyphs change.
const SHUFFLE_MS = 60;
// Lines measured again this often, for a page that lays out as it arrives.
const MEASURE_MS = 120;
// Caps on the work one frame does on a very long page.
const MAX_NODES = 2000;
const MAX_RECTS = 1500;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

/** The CSS curtain's cubic-bezier(0.65, 0, 0.35, 1), as ease in and out. */
export function easeInOut(u: number) {
  const x = clamp01(u);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function inverseEase(y: number) {
  const target = clamp01(y);
  let low = 0;
  let high = 1;
  for (let step = 0; step < 24; step += 1) {
    const middle = (low + high) / 2;
    if (easeInOut(middle) < target) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

/** Where the scanline is, `t` ms into the arrival, in a window `height` tall. */
export function scanlineY(t: number, height: number) {
  return easeInOut((t - DECODE_DELAY_MS) / DECODE_SWEEP_MS) * height;
}

/** How far a line whose top is at `top` has decoded, 0 to 1, `t` ms in. */
export function lineProgress(t: number, top: number, height: number) {
  const reachedAt = DECODE_DELAY_MS + DECODE_SWEEP_MS * inverseEase(height > 0 ? top / height : 0);
  return clamp01((t - reachedAt) / DECODE_LINE_MS);
}

/** `count` glyphs for one line, the same for the same seed. */
export function scrambled(count: number, seed: number) {
  let state = seed >>> 0 || 1;
  let text = '';
  for (let index = 0; index < count; index += 1) {
    // mulberry32
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    const unit = ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    text += DECODE_GLYPHS[Math.floor(unit * DECODE_GLYPHS.length)];
  }
  return text;
}

type Line = {left: number; top: number; width: number; height: number; color: string; size: number; bg: string};
type Palette = {bg: string; a: string; b: string; glow: string};

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE']);

type Rgba = [number, number, number, number];

function parseColor(value: string): Rgba | null {
  const match = /rgba?\(([^)]+)\)/.exec(value);
  if (!match) return null;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/**
 * What a line of text sits on: its own and its ancestors' backgrounds laid
 * over one another down to the first opaque one, so a glyph's cover on a
 * tinted diff row or a filled pill matches it. A gradient counts as the
 * brand's middle color.
 */
function backgroundOf(element: Element, page: Rgba, brand: Rgba): string {
  const layers: Rgba[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const computed = getComputedStyle(node);
    if (computed.backgroundImage.includes('gradient')) {
      layers.push(brand);
      break;
    }
    const color = parseColor(computed.backgroundColor);
    if (color && color[3] > 0) {
      layers.push(color);
      if (color[3] >= 1) break;
    }
  }
  let [r, g, b] = page;
  for (const [lr, lg, lb, la] of layers.reverse()) {
    r = lr * la + r * (1 - la);
    g = lg * la + g * (1 - la);
    b = lb * la + b * (1 - la);
  }
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function textNodes(height: number) {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && nodes.length < MAX_NODES; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || SKIP.has(parent.tagName) || !node.nodeValue?.trim()) continue;
    const box = parent.getBoundingClientRect();
    // Near the window: a glide to a card brings the next screen in.
    if (box.bottom < -height || box.top > 2 * height || box.width === 0) continue;
    nodes.push(node as Text);
  }
  return nodes;
}

function measure(nodes: Text[], height: number, page: Rgba, brand: Rgba) {
  const lines: Line[] = [];
  const range = document.createRange();
  const styles = new Map<Element, {color: string; size: number; bg: string}>();
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent) continue;
    let style = styles.get(parent);
    if (!style) {
      const computed = getComputedStyle(parent);
      style = {color: computed.color, size: parseFloat(computed.fontSize) || 14, bg: backgroundOf(parent, page, brand)};
      styles.set(parent, style);
    }
    range.selectNodeContents(node);
    for (const rect of range.getClientRects()) {
      if (rect.width < 2 || rect.bottom < 0 || rect.top > height) continue;
      lines.push({left: rect.left, top: rect.top, width: rect.width, height: rect.height, ...style});
      if (lines.length >= MAX_RECTS) return lines;
    }
  }
  return lines;
}

// The middle of the brand gradient, from the two tokens as hex.
function mixBrand(palette: Palette): Rgba {
  const hex = (value: string) => {
    const match = /^#([0-9a-f]{6})$/i.exec(value);
    if (!match) return null;
    const n = parseInt(match[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = hex(palette.a) ?? [16, 124, 144];
  const b = hex(palette.b) ?? [124, 82, 219];
  return [(a[0]! + b[0]!) / 2, (a[1]! + b[1]!) / 2, (a[2]! + b[2]!) / 2, 1];
}

function token(name: string, fallback: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Plays the arrival over the page and calls `done` once it has. The
 * returned function ends it early. Null when the browser has no 2D canvas,
 * and nothing plays.
 */
export function decodeIn(done: () => void, now: () => number = () => performance.now()): (() => void) | null {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) return null;
  canvas.id = 'rv-decode';
  canvas.setAttribute('aria-hidden', 'true');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483000;pointer-events:none';
  const palette: Palette = {
    bg: token('--rv-bg', '#ffffff'),
    a: token('--rv-brand-a', '#107c90'),
    b: token('--rv-brand-b', '#7c52db'),
    glow: token('--rv-flash', 'rgba(16, 124, 144, 0.35)'),
  };

  // Read once: a resize ends the arrival.
  const width = innerWidth;
  const height = innerHeight;
  const ratio = devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.scale(ratio, ratio);

  const page = parseColor(getComputedStyle(document.body).backgroundColor) ?? parseColor(palette.bg) ?? [255, 255, 255, 1];
  const brand = mixBrand(palette);
  const nodes = textNodes(height);
  let lines = measure(nodes, height, page, brand);
  let measuredAt = 0;
  let measuredScroll = {x: scrollX, y: scrollY};
  const startedAt = now();
  let frame = 0;
  let ended = false;

  const end = () => {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(frame);
    removeEventListener('resize', end);
    canvas.remove();
    done();
  };

  const draw = (t: number) => {
    if (t - measuredAt >= MEASURE_MS) {
      lines = measure(nodes, height, page, brand);
      measuredAt = t;
      measuredScroll = {x: scrollX, y: scrollY};
    }
    // Scrolled since the last measure: the lines moved by as much.
    const dx = measuredScroll.x - scrollX;
    const dy = measuredScroll.y - scrollY;
    const y = scanlineY(t, height);
    const shuffle = Math.floor(t / SHUFFLE_MS);

    context.clearRect(0, 0, width, height);
    // Below the scanline the page is still on its way.
    context.fillStyle = palette.bg;
    context.fillRect(0, y, width, height - y);

    context.textBaseline = 'alphabetic';
    lines.forEach((line, index) => {
      const top = line.top + dy;
      const left = line.left + dx;
      if (top + line.height < 0 || top > height) return;
      const progress = top < y ? lineProgress(t, top, height) : 0;
      if (progress >= 1) return;
      const from = left + line.width * progress;
      const size = Math.min(line.size, line.height * 0.92);
      const cell = size * 0.62;
      const count = Math.max(1, Math.ceil((left + line.width - from) / cell));
      context.save();
      context.beginPath();
      context.rect(from, top, left + line.width - from, line.height);
      context.clip();
      if (top < y) {
        context.fillStyle = line.bg;
        context.fillRect(from, top, left + line.width - from, line.height);
      }
      context.font = `${size}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const glyphs = scrambled(count, index * 7919 + shuffle);
      const baseline = top + line.height * 0.78;
      if (progress > 0) {
        // The decoding edge, two glyphs wide, in the brand colors.
        const edge = context.createLinearGradient(from, 0, from + cell * 2, 0);
        edge.addColorStop(0, palette.a);
        edge.addColorStop(1, palette.b);
        context.fillStyle = edge;
        context.fillText(glyphs.slice(0, 2), from, baseline);
        context.globalAlpha = 0.55;
        context.fillStyle = line.color;
        context.fillText(glyphs.slice(2), from + context.measureText(glyphs.slice(0, 2)).width, baseline);
      } else {
        context.globalAlpha = top < y ? 0.55 : 0.22;
        context.fillStyle = line.color;
        context.fillText(glyphs, from, baseline);
      }
      context.restore();
    });

    const sweep = (t - DECODE_DELAY_MS) / DECODE_SWEEP_MS;
    if (sweep >= 0 && sweep <= 1) {
      const line = context.createLinearGradient(0, 0, width, 0);
      line.addColorStop(0, palette.a);
      line.addColorStop(1, palette.b);
      context.save();
      context.globalAlpha = sweep > 0.85 ? (1 - sweep) / 0.15 : 1;
      context.shadowColor = palette.glow;
      context.shadowBlur = 18;
      context.fillStyle = line;
      context.fillRect(0, y - 1.5, width, 3);
      context.restore();
    }
  };

  const tick = () => {
    const t = now() - startedAt;
    if (t >= DECODE_MS) {
      end();
      return;
    }
    draw(t);
    frame = requestAnimationFrame(tick);
  };

  draw(0);
  document.body.append(canvas);
  addEventListener('resize', end);
  frame = requestAnimationFrame(tick);
  return end;
}
