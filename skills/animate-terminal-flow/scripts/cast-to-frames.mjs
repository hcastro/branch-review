#!/usr/bin/env node
// Replays an asciicast v2 file through @xterm/headless with its exact timing
// and writes what a motion video needs:
//
//   frames.json   the screen as styled runs, one entry per change, with its time
//   images.json   every Kitty graphics image, decoded to images/*.png, with the
//                 cells it showed in and when it was shown and deleted
//   markers.json  the cast's "m" events with their times and frame index
//   capture.js    the same data as `window.TERMINAL_CAPTURE`, for a <script> tag
//   render-grid.js  a copy of the renderer, so the folder is self-contained
//   png/          with --png: the screen at each marker, plus contact-sheet.png
//
// xterm.js ignores APC strings, so the Kitty graphics commands are cut out of
// the stream here and handled in order: transmit (t, T; f=100 PNG or f=24/32
// raw, o=z, chunked m=1), put (p, U=1 virtual or direct at the cursor), delete
// (d), animation frames (f, a). Unicode placeholder cells (U+10EEEE with row
// and column diacritics, the image id in the foreground color) become image
// overlays on the grid.
//
// Usage:
//   node cast-to-frames.mjs IN.cast --out DIR [--png] [--times 1.5,3.2]
//        [--settle-ms 8] [--font-size 15] [--cell 9x19] [--font-family CSS]
//        [--theme theme.json] [--scale 2]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {KITTY_DIACRITICS} from './kitty-diacritics.mjs';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const {Terminal} = require('@xterm/headless');
const {Unicode11Addon} = require('@xterm/addon-unicode11');

const PLACEHOLDER = 0x10eeee;
const DIACRITIC_INDEX = new Map(KITTY_DIACRITICS.map((cp, i) => [cp, i]));

// ---- args --------------------------------------------------------------------
function parseArgs(argv) {
  const args = {settleMs: 8, fontSize: 15, cell: null, fontFamily: null, png: false, times: [], scale: 2, theme: null, pad: 0};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out') args.out = next();
    else if (a === '--png') args.png = true;
    else if (a === '--settle-ms') args.settleMs = Number(next());
    else if (a === '--font-size') args.fontSize = Number(next());
    else if (a === '--font-family') args.fontFamily = next();
    else if (a === '--cell') {
      const m = /^([\d.]+)x([\d.]+)$/.exec(next());
      if (!m) throw new Error('--cell wants WxH in CSS px, such as 9x19');
      args.cell = {w: Number(m[1]), h: Number(m[2])};
    } else if (a === '--times') args.times = next().split(',').map(Number);
    else if (a === '--scale') args.scale = Number(next());
    else if (a === '--theme') args.theme = JSON.parse(fs.readFileSync(next(), 'utf8'));
    else if (a === '--pad') args.pad = Number(next());
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exit(0);
    } else rest.push(a);
  }
  if (rest.length !== 1 || !args.out) throw new Error('usage: cast-to-frames.mjs IN.cast --out DIR [--png]');
  args.cast = rest[0];
  return args;
}

// ---- PNG helpers ---------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Raw RGB or RGBA pixels to a PNG.
export function encodePng(pixels, width, height, channels) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return {width: buf.readUInt32BE(16), height: buf.readUInt32BE(20)};
}

// ---- the replay ------------------------------------------------------------------
class Replay {
  constructor(header, args) {
    this.args = args;
    this.cols = header.width;
    this.rows = header.height;
    this.header = header;
    const term = new Terminal({cols: this.cols, rows: this.rows, allowProposedApi: true, scrollback: 2000});
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    this.term = term;
    this.now = 0;
    this.sync = false;
    this.cursorVisible = true;
    this.apcCarry = '';
    this.kittyPending = null;
    this.images = new Map(); // key -> image record
    this.activeKey = new Map(); // kitty id -> key of the image it names now
    this.generation = new Map();
    this.direct = []; // direct placements
    this.styles = [];
    this.styleIndex = new Map();
    this.rowsTable = [];
    this.rowIndex = new Map();
    this.overlays = [];
    this.overlayIndex = new Map();
    this.frames = [];
    this.lastFrameKey = '';
    this.warnings = new Set();
    this.cell = term.buffer.active.getNullCell();

    term.parser.registerCsiHandler({prefix: '?', final: 'h'}, (params) => this.privateMode(params, true));
    term.parser.registerCsiHandler({prefix: '?', final: 'l'}, (params) => this.privateMode(params, false));
    term.parser.registerCsiHandler({final: 'J'}, (params) => {
      const mode = params[0] || 0;
      if (mode === 2 || mode === 3) this.clearDirect(this.term.buffer.active.type);
      return false;
    });
  }

  privateMode(params, on) {
    for (const p of params) {
      const mode = Array.isArray(p) ? p[0] : p;
      if (mode === 2026) this.sync = on;
      if (mode === 25) this.cursorVisible = on;
    }
    return false;
  }

  warn(message) {
    if (!this.warnings.has(message)) {
      this.warnings.add(message);
      console.error(`cast-to-frames: ${message}`);
    }
  }

  write(data) {
    if (!data) return Promise.resolve();
    return new Promise((resolve) => this.term.write(data, resolve));
  }

  // Writes output to xterm with the Kitty APCs cut out and handled in place.
  async output(data) {
    let s = this.apcCarry + data;
    this.apcCarry = '';
    for (;;) {
      const start = s.indexOf('\x1b_');
      if (start < 0) {
        await this.write(s);
        return;
      }
      await this.write(s.slice(0, start));
      const end = s.indexOf('\x1b\\', start + 2);
      if (end < 0) {
        this.apcCarry = s.slice(start);
        return;
      }
      this.apc(s.slice(start + 2, end));
      s = s.slice(end + 2);
    }
  }

  apc(body) {
    if (!body.startsWith('G')) return;
    const semi = body.indexOf(';');
    const control = semi < 0 ? body.slice(1) : body.slice(1, semi);
    const payload = semi < 0 ? '' : body.slice(semi + 1);
    const keys = {};
    for (const pair of control.split(',')) {
      const eq = pair.indexOf('=');
      if (eq > 0) keys[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    const continuing = this.kittyPending && !('a' in keys) && !('i' in keys) && !('f' in keys) && !('I' in keys);
    if (continuing) {
      this.kittyPending.payload.push(payload);
      if (keys.m === '1') return;
      const done = this.kittyPending;
      this.kittyPending = null;
      this.command(done.keys, done.payload.join(''));
      return;
    }
    if (keys.m === '1') {
      this.kittyPending = {keys, payload: [payload]};
      return;
    }
    this.kittyPending = null;
    this.command(keys, payload);
  }

  decodePayload(keys, payload) {
    const medium = keys.t || 'd';
    let data;
    if (medium === 'd') data = Buffer.from(payload, 'base64');
    else if (medium === 'f' || medium === 't') {
      const file = Buffer.from(payload, 'base64').toString('utf8');
      try {
        data = fs.readFileSync(file);
      } catch {
        this.warn(`image file ${file} (t=${medium}) is gone; it was not captured`);
        return null;
      }
    } else {
      this.warn(`transmission medium t=${medium} (shared memory) is not supported`);
      return null;
    }
    if (keys.o === 'z') data = zlib.inflateSync(data);
    const format = keys.f || '32';
    if (format === '100') {
      const size = pngSize(data);
      if (!size) return null;
      return {png: data, ...size};
    }
    const width = Number(keys.s);
    const height = Number(keys.v);
    const channels = format === '24' ? 3 : 4;
    if (!width || !height || data.length < width * height * channels) return null;
    return {png: encodePng(data, width, height, channels), width, height};
  }

  imageId(keys) {
    return Number(keys.i || 0) || null;
  }

  command(keys, payload) {
    const action = keys.a || 't';
    const id = this.imageId(keys);
    if (action === 'q') return;
    if (action === 't' || action === 'T') {
      if (!id) {
        this.warn('an image without an id (i=) was sent; it was not captured');
        return;
      }
      const decoded = this.decodePayload(keys, payload);
      if (!decoded) return;
      const gen = (this.generation.get(id) || 0) + 1;
      this.generation.set(id, gen);
      const old = this.activeKey.get(id);
      if (old) this.retire(old);
      const key = `${id}.${gen}`;
      const file = `images/img-${String(id).padStart(3, '0')}-${gen}.png`;
      fs.writeFileSync(path.join(this.args.out, file), decoded.png);
      this.images.set(key, {key, id, file, width: decoded.width, height: decoded.height, transmittedAt: this.now, deletedAt: null, placement: null, virtualActive: false, direct: false, animation: null});
      this.activeKey.set(id, key);
      if (action === 'T') this.place(keys, key);
      return;
    }
    if (action === 'p') {
      const key = this.activeKey.get(id);
      if (!key) return;
      this.place(keys, key);
      return;
    }
    if (action === 'd') {
      const what = keys.d || 'a';
      if (what === 'i' || what === 'I') {
        const key = this.activeKey.get(id);
        if (!key) return;
        const image = this.images.get(key);
        image.virtualActive = false;
        this.direct = this.direct.filter((p) => p.key !== key);
        if (what === 'I') {
          this.retire(key);
          this.activeKey.delete(id);
        }
      } else if (what === 'a' || what === 'A') {
        this.direct = [];
        for (const key of this.activeKey.values()) {
          this.images.get(key).virtualActive = false;
          if (what === 'A') this.retire(key);
        }
        if (what === 'A') this.activeKey.clear();
      } else {
        this.warn(`delete mode d=${what} is treated as deleting every placement`);
        this.direct = [];
      }
      return;
    }
    if (action === 'f') {
      const key = this.activeKey.get(id);
      if (!key) return;
      const decoded = this.decodePayload(keys, payload);
      if (!decoded) return;
      const image = this.images.get(key);
      image.animation ??= {frames: [{file: image.file, delay: 40}], loopStartedAt: null};
      const n = image.animation.frames.length + 1;
      const file = `images/img-${String(id).padStart(3, '0')}-${key.split('.')[1]}-f${n}.png`;
      fs.writeFileSync(path.join(this.args.out, file), decoded.png);
      image.animation.frames.push({file, delay: Math.max(20, Number(keys.z || 40))});
      if (keys.x || keys.y || keys.c) this.warn('animation frames with offsets (x, y) or a base frame (c) are kept as whole frames');
      return;
    }
    if (action === 'a') {
      const key = this.activeKey.get(id);
      if (!key) return;
      const image = this.images.get(key);
      image.animation ??= {frames: [{file: image.file, delay: 40}], loopStartedAt: null};
      if (keys.r && keys.z) {
        const frame = image.animation.frames[Number(keys.r) - 1];
        if (frame) frame.delay = Math.max(20, Number(keys.z));
      }
      if (keys.s === '3' || keys.s === '2') image.animation.loopStartedAt = this.now;
      if (keys.s === '1') image.animation.loopStartedAt = null;
      return;
    }
    if (action === 'c') this.warn('frame composition (a=c) is ignored');
  }

  retire(key) {
    const image = this.images.get(key);
    if (image && image.deletedAt === null) image.deletedAt = this.now;
  }

  place(keys, key) {
    const image = this.images.get(key);
    const cellPx = this.header.x_terminal?.cell_px || {w: 10, h: 20};
    if (keys.U === '1') {
      image.placement = {cols: Number(keys.c) || Math.ceil(image.width / cellPx.w), rows: Number(keys.r) || Math.ceil(image.height / cellPx.h), virtual: true};
      image.virtualActive = true;
      return;
    }
    const buf = this.term.buffer.active;
    const cols = Number(keys.c) || Math.ceil(image.width / cellPx.w);
    const rows = Number(keys.r) || Math.ceil(image.height / cellPx.h);
    image.direct = true;
    this.direct.push({key, screen: buf.type, col: buf.cursorX, absRow: buf.baseY + buf.cursorY, cols, rows, z: Number(keys.z || 0), fit: keys.c || keys.r ? 'stretch' : 'contain'});
    if (keys.C !== '1') {
      // Kitty moves the cursor past the image: right by its columns, down by its rows minus one.
      const down = '\n'.repeat(Math.max(0, rows - 1));
      this.term.write(`${down}\x1b[${cols}C`);
    }
  }

  clearDirect(screen) {
    this.direct = this.direct.filter((p) => p.screen !== screen);
  }

  styleOf(cell, placeholder) {
    const s = {};
    if (!placeholder) {
      if (cell.isFgPalette()) s.fg = cell.getFgColor();
      else if (cell.isFgRGB()) s.fg = hex(cell.getFgColor());
    }
    if (cell.isBgPalette()) s.bg = cell.getBgColor();
    else if (cell.isBgRGB()) s.bg = hex(cell.getBgColor());
    if (cell.isBold()) s.b = 1;
    if (cell.isItalic()) s.i = 1;
    if (cell.isUnderline()) s.u = 1;
    if (cell.isDim()) s.d = 1;
    if (cell.isInverse()) s.inv = 1;
    if (cell.isStrikethrough()) s.s = 1;
    if (cell.isInvisible()) s.x = 1;
    const key = JSON.stringify(s);
    let index = this.styleIndex.get(key);
    if (index === undefined) {
      index = this.styles.length;
      this.styles.push(s);
      this.styleIndex.set(key, index);
    }
    return index;
  }

  // The image id, row and column a placeholder cell names.
  placeholder(cell, chars, prev) {
    let id = null;
    if (cell.isFgPalette()) id = cell.getFgColor();
    else if (cell.isFgRGB()) id = cell.getFgColor();
    const marks = [...chars].slice(1).map((c) => DIACRITIC_INDEX.get(c.codePointAt(0)));
    let row = marks[0];
    let col = marks[1];
    if (marks[2] !== undefined) id = (id ?? 0) + (marks[2] << 24);
    // Kitty infers missing marks from the cell to the left.
    if (prev && prev.id === id) {
      if (row === undefined) row = prev.row;
      if (col === undefined && row === prev.row) col = prev.col + 1;
    }
    return {id, row: row ?? 0, col: col ?? 0};
  }

  snapshot() {
    const buf = this.term.buffer.active;
    const cell = this.cell;
    const rowRefs = [];
    const cells = new Map(); // key -> [{y, x, row, col}]
    for (let y = 0; y < this.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      const runs = [];
      let cur = null;
      let prevPh = null;
      for (let x = 0; line && x < this.cols; x++) {
        line.getCell(x, cell);
        const width = cell.getWidth();
        if (width === 0) continue;
        const chars = cell.getChars() || ' ';
        const cp = chars.codePointAt(0);
        let text = chars;
        let style;
        if (cp === PLACEHOLDER) {
          const ph = this.placeholder(cell, chars, prevPh);
          prevPh = ph;
          const key = this.activeKey.get(ph.id);
          const image = key && this.images.get(key);
          if (image && image.virtualActive) {
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push({y, x, row: ph.row, col: ph.col});
          }
          text = ' ';
          style = this.styleOf(cell, true);
        } else {
          prevPh = null;
          style = this.styleOf(cell, false);
        }
        const ascii = text.length === 1 && text >= ' ' && text <= '~';
        if (ascii && width === 1 && cur && !cur.glyph && cur.style === style && cur.col + cur.width === x) {
          cur.text += text;
          cur.width += 1;
          continue;
        }
        if (!ascii && cur && cur.glyph === text && cur.style === style && cur.glyphW === width && cur.col + cur.width === x) {
          cur.width += width;
          continue;
        }
        cur = ascii && width === 1 ? {col: x, width: 1, text, style} : {col: x, width, text, style, glyph: text, glyphW: width};
        runs.push(cur);
      }
      // Trim blanks on the default background off the ends of text runs, and drop blank runs.
      for (const r of runs) {
        if (r.glyph || !isBlankStyle(this.styles[r.style])) continue;
        const lead = r.text.length - r.text.trimStart().length;
        r.text = r.text.trim();
        r.col += lead;
        r.width = r.text.length;
      }
      const kept = runs.filter((r) => r.width > 0);
      const encoded = kept.map((r) => (r.glyph ? [r.col, r.width, r.glyph, r.style, r.glyphW] : [r.col, r.width, r.text, r.style]));
      const key = JSON.stringify(encoded);
      let index = this.rowIndex.get(key);
      if (index === undefined) {
        index = this.rowsTable.length;
        this.rowsTable.push(encoded);
        this.rowIndex.set(key, index);
      }
      rowRefs.push(index);
    }

    const overlays = [];
    for (const [key, list] of cells) overlays.push(...rects(key, list));
    for (const p of this.direct) {
      if (p.screen !== buf.type) continue;
      const top = p.absRow - buf.viewportY;
      const r0 = Math.max(top, 0);
      const r1 = Math.min(top + p.rows, this.rows);
      const c1 = Math.min(p.col + p.cols, this.cols);
      if (r1 <= r0 || c1 <= p.col) continue;
      overlays.push({k: p.key, c: p.col, r: r0, w: c1 - p.col, h: r1 - r0, sc: 0, sr: r0 - top, pc: p.cols, pr: p.rows, z: p.z, fit: p.fit});
    }
    let overlayRef;
    if (overlays.length) {
      const key = JSON.stringify(overlays);
      overlayRef = this.overlayIndex.get(key);
      if (overlayRef === undefined) {
        overlayRef = this.overlays.length;
        this.overlays.push(overlays);
        this.overlayIndex.set(key, overlayRef);
      }
    }
    const frame = {t: round(this.now), r: rowRefs};
    if (overlayRef !== undefined) frame.o = overlayRef;
    frame.c = [buf.cursorX, buf.cursorY, this.cursorVisible ? 1 : 0];
    if (this.cols !== this.header.width || this.rows !== this.header.height) frame.s = [this.cols, this.rows];
    const frameKey = JSON.stringify([frame.r, frame.o, frame.c, frame.s]);
    if (frameKey === this.lastFrameKey) return false;
    this.lastFrameKey = frameKey;
    this.frames.push(frame);
    return true;
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
  }
}

function isBlankStyle(s) {
  return s.bg === undefined && !s.inv && !s.u && !s.s;
}

function hex(n) {
  return `#${n.toString(16).padStart(6, '0')}`;
}

function round(t) {
  return Math.round(t * 1e6) / 1e6;
}

// Placeholder cells grouped into rectangles: runs on a row whose image
// columns count up, merged down while their image rows count up.
function rects(key, list) {
  list.sort((a, b) => a.y - b.y || a.x - b.x);
  const segments = [];
  for (const c of list) {
    const last = segments[segments.length - 1];
    if (last && last.y === c.y && last.x + last.w === c.x && last.col + last.w === c.col && last.row === c.row) last.w += 1;
    else segments.push({y: c.y, x: c.x, w: 1, row: c.row, col: c.col});
  }
  const out = [];
  for (const s of segments) {
    const above = out.find((o) => o.c === s.x && o.w === s.w && o.sc === s.col && o.r + o.h === s.y && o.sr + o.h === s.row);
    if (above) above.h += 1;
    else out.push({k: key, c: s.x, r: s.y, w: s.w, h: 1, sc: s.col, sr: s.row, z: 0});
  }
  return out;
}

// ---- Playwright -------------------------------------------------------------------
function loadPlaywright() {
  const tries = [() => require('playwright')];
  for (const cmd of [['npm', ['root', '-g']], ['pnpm', ['root', '-g']]]) {
    tries.push(() => {
      const root = execFileSync(cmd[0], cmd[1], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
      return createRequire(path.join(root, 'noop.js'))('playwright');
    });
  }
  for (const attempt of tries) {
    try {
      return attempt();
    } catch {
      // next
    }
  }
  throw new Error('Playwright not found locally or globally (npm i -g playwright)');
}

export async function renderPngs({outDir, captureFile = 'capture.js', shots, fontSize, fontFamily, cell, scale, theme, sheetTitle}) {
  const {chromium} = loadPlaywright();
  const pngDir = path.join(outDir, 'png');
  fs.mkdirSync(pngDir, {recursive: true});
  const page$ = path.join(outDir, '_render.html');
  const mountOpts = {fontSize, ...(fontFamily ? {fontFamily} : {}), ...(cell ? {cellWidth: cell.w, cellHeight: cell.h} : {}), ...(theme ? {theme} : {})};
  fs.writeFileSync(page$, `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}#term{display:inline-block}</style></head><body><div id="term"></div>
<script src="render-grid.js"></script><script src="${captureFile}"></script>
<script>window.grid = TerminalGrid.mount(document.getElementById('term'), Object.assign({}, window.TERMINAL_CAPTURE, ${JSON.stringify(mountOpts)}));</script></body></html>`);
  const browser = await chromium.launch();
  const written = [];
  try {
    const page = await browser.newPage({viewport: {width: 800, height: 600}, deviceScaleFactor: scale});
    await page.goto(pathToFileURL(page$).href);
    await page.evaluate(() => document.fonts.ready);
    const size = await page.evaluate(() => ({w: Math.ceil(grid.width), h: Math.ceil(grid.height)}));
    await page.setViewportSize({width: size.w, height: size.h});
    for (const [i, shot] of shots.entries()) {
      await page.evaluate((t) => grid.seek(t), shot.t);
      await page.evaluate(() => grid.ready());
      const safe = shot.name.replace(/[^\w.-]+/g, '_');
      const file = path.join(pngDir, /^\d/.test(safe) ? `${safe}.png` : `${String(i + 1).padStart(2, '0')}-${safe}.png`);
      await page.locator('#term').screenshot({path: file});
      written.push({...shot, file});
    }
    // Contact sheet.
    const sheet = path.join(outDir, '_sheet.html');
    const columns = written.length > 6 ? 3 : 2;
    const thumb = Math.min(Math.round(size.w), 640);
    const cards = written.map((w) => `<figure><img src="png/${path.basename(w.file)}"><figcaption>${escapeHtml(w.name)} · ${w.t.toFixed(2)}s</figcaption></figure>`).join('');
    fs.writeFileSync(sheet, `<!doctype html><html><head><meta charset="utf-8"><style>
      body{margin:0;padding:20px;background:#24262b;font:13px -apple-system,Helvetica,sans-serif;color:#ddd}
      h1{font-size:15px;margin:0 0 14px} .grid{display:grid;grid-template-columns:repeat(${columns},${thumb}px);gap:16px}
      figure{margin:0} img{width:${thumb}px;display:block;border:1px solid #444} figcaption{padding:5px 2px}
    </style></head><body><h1>${escapeHtml(sheetTitle || '')}</h1><div class="grid">${cards}</div></body></html>`);
    const sheetPage = await browser.newPage({viewport: {width: thumb * columns + 16 * (columns - 1) + 40, height: 400}, deviceScaleFactor: 1});
    await sheetPage.goto(pathToFileURL(sheet).href);
    await sheetPage.evaluate(() => Promise.all([...document.images].map((im) => im.decode().catch(() => {}))));
    const sheetPng = path.join(outDir, 'contact-sheet.png');
    await sheetPage.screenshot({path: sheetPng, fullPage: true});
    return {shots: written, sheet: sheetPng};
  } finally {
    await browser.close();
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
}

// ---- main -------------------------------------------------------------------------
export async function convert(args) {
  const lines = fs.readFileSync(args.cast, 'utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  if (header.version !== 2) throw new Error(`not an asciicast v2 file: ${args.cast}`);
  const events = lines.slice(1).map((l) => JSON.parse(l));
  fs.mkdirSync(path.join(args.out, 'images'), {recursive: true});
  const replay = new Replay(header, args);
  const markers = [];
  const inputs = [];
  const resizes = [];
  const settle = args.settleMs / 1000;
  for (let i = 0; i < events.length; i++) {
    const [t, kind, data] = events[i];
    replay.now = t;
    if (kind === 'o') {
      await replay.output(data);
      const next = events[i + 1];
      const settled = !next || next[0] - t >= settle || next[1] !== 'o';
      // While the app holds a synchronized update, wait for its end (up to 1 s).
      if (settled && (!replay.sync || !next || next[0] - t > 1)) replay.snapshot();
    } else if (kind === 'm') {
      replay.snapshot();
      markers.push({name: String(data), t: round(t), frame: replay.frames.length - 1});
    } else if (kind === 'i') {
      inputs.push({t: round(t), data});
    } else if (kind === 'r') {
      const [cols, rows] = String(data).split('x').map(Number);
      replay.resize(cols, rows);
      resizes.push({t: round(t), cols, rows});
      replay.snapshot();
    }
  }
  const duration = round(events.length ? events[events.length - 1][0] : 0);

  // When and where each image showed.
  const shown = new Map();
  replay.frames.forEach((frame, i) => {
    const list = frame.o !== undefined ? replay.overlays[frame.o] : [];
    const end = i + 1 < replay.frames.length ? replay.frames[i + 1].t : duration;
    const byKey = new Map();
    for (const o of list) {
      if (!byKey.has(o.k)) byKey.set(o.k, []);
      byKey.get(o.k).push({col: o.c, row: o.r, cols: o.w, rows: o.h, srcCol: o.sc, srcRow: o.sr});
    }
    for (const [key, rectsList] of byKey) {
      if (!shown.has(key)) shown.set(key, []);
      const intervals = shown.get(key);
      const last = intervals[intervals.length - 1];
      const sig = JSON.stringify(rectsList);
      if (last && last.to === frame.t && last.sig === sig) last.to = end;
      else intervals.push({from: frame.t, to: end, sig, rects: rectsList});
    }
  });
  const images = [...replay.images.values()].map((image) => ({
    ...image,
    shown: (shown.get(image.key) || []).map(({from, to, rects: r}) => ({from: round(from), to: round(to), rect: bounding(r), rects: r})),
  }));

  const theme = header.theme ? {fg: header.theme.fg, bg: header.theme.bg, cursor: header.x_terminal?.cursor || header.theme.fg, palette: String(header.theme.palette || '').split(':').filter(Boolean)} : null;
  const framesJson = {
    version: 1,
    source: path.resolve(args.cast),
    cols: header.width,
    rows: header.height,
    duration,
    recorded: {theme, terminal: header.x_terminal || null, cellPx: header.x_terminal?.cell_px || null},
    styles: replay.styles,
    lines_note: 'lines[i] is a list of runs: [col, width, text, style] for ASCII text, [col, width, glyph, style, glyphWidth] for a repeated non-ASCII glyph',
    lines: replay.rowsTable,
    overlays: replay.overlays,
    frames: replay.frames,
    markers,
    inputs,
    resizes,
  };
  const imagesJson = {version: 1, cellPx: framesJson.recorded.cellPx, images};
  fs.writeFileSync(path.join(args.out, 'frames.json'), JSON.stringify(framesJson));
  fs.writeFileSync(path.join(args.out, 'images.json'), JSON.stringify(imagesJson, null, 1));
  fs.writeFileSync(path.join(args.out, 'markers.json'), JSON.stringify(markers, null, 1));
  fs.writeFileSync(path.join(args.out, 'capture.js'), `window.TERMINAL_CAPTURE = ${JSON.stringify({frames: framesJson, images: imagesJson})};\n`);
  fs.copyFileSync(path.join(HERE, 'render-grid.js'), path.join(args.out, 'render-grid.js'));

  const summary = {frames: replay.frames.length, uniqueRows: replay.rowsTable.length, styles: replay.styles.length, images: images.length, markers: markers.length, duration, warnings: [...replay.warnings]};
  if (args.png) {
    const shots = markers.map((m) => ({name: m.name, t: m.t}));
    for (const t of args.times) shots.push({name: `t${t}`, t});
    if (!shots.length) shots.push({name: 'end', t: duration});
    const result = await renderPngs({outDir: args.out, shots, fontSize: args.fontSize, fontFamily: args.fontFamily, cell: args.cell, scale: args.scale, theme: args.theme, sheetTitle: path.basename(args.cast)});
    summary.pngs = result.shots.map((s) => s.file);
    summary.contactSheet = result.sheet;
  }
  return {summary, framesJson, imagesJson};
}

function bounding(list) {
  const c0 = Math.min(...list.map((r) => r.col));
  const r0 = Math.min(...list.map((r) => r.row));
  const c1 = Math.max(...list.map((r) => r.col + r.cols));
  const r1 = Math.max(...list.map((r) => r.row + r.rows));
  return {col: c0, row: r0, cols: c1 - c0, rows: r1 - r0};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const {summary} = await convert(args);
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error(`cast-to-frames: ${error.stack || error.message}`);
    process.exit(1);
  }
}
