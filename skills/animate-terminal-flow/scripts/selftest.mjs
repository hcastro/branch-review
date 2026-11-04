#!/usr/bin/env node
// Self-test for the capture pipeline. It records a tiny terminal app with
// record-tui.py, replays the cast with cast-to-frames.mjs (with --png), and
// checks the frames, the Kitty image placements, the markers and the PNGs.
//
// The app asks the terminal for DA1 and Kitty graphics support, prints 16,
// 256 and truecolor text, moves the cursor, shows one image through Unicode
// placeholders (as branch-review does) and one as a direct placement, then
// switches to the alt screen, deletes the image and draws a box.
//
// Usage: node selftest.mjs [--keep]   (exit 0 when every check passes)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {KITTY_DIACRITICS} from './kitty-diacritics.mjs';
import {convert, encodePng} from './cast-to-frames.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const keep = process.argv.includes('--keep');
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'atf-selftest-'));
const failures = [];
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? ` (${detail})` : ''}`);
}

// A 40x20 PNG: red left half, blue right half. And a 30x40 green one.
function twoTone(width, height, left, right) {
  const px = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = x < width / 2 ? left : right;
      px.set(c, (y * width + x) * 3);
    }
  }
  return encodePng(px, width, height, 3);
}
fs.writeFileSync(path.join(work, 'a.png'), twoTone(40, 40, [255, 0, 0], [0, 0, 255]));
fs.writeFileSync(path.join(work, 'b.png'), twoTone(30, 40, [0, 200, 0], [0, 200, 0]));

const diacritics = JSON.stringify(KITTY_DIACRITICS);
const app = `
import fs from 'node:fs';
const D = ${diacritics}.map((c) => String.fromCodePoint(c));
const ESC = '\\x1b';
const out = (s) => process.stdout.write(s);
process.stdin.setRawMode(true);
process.stdin.resume();
let buf = '';
const waitFor = (re) => new Promise((resolve) => {
  const on = (d) => { buf += d.toString('latin1'); const m = re.exec(buf); if (m) { process.stdin.off('data', on); buf = buf.slice(m.index + m[0].length); resolve(m); } };
  process.stdin.on('data', on); on(Buffer.alloc(0));
});
const apc = (keys, payload) => ESC + '_G' + keys + (payload ? ';' + payload : '') + ESC + '\\\\';
const send = (id, png, keys) => {
  const b64 = fs.readFileSync(png).toString('base64');
  for (let i = 0; i < b64.length; i += 64) {
    const more = i + 64 < b64.length ? 1 : 0;
    out(i === 0 ? apc(keys + ',i=' + id + ',f=100,t=d,q=2,m=' + more, b64.slice(i, i + 64)) : apc('m=' + more + ',q=2', b64.slice(i, i + 64)));
  }
};
const ph = (id, row, col0, n, skipCol) => {
  let s = ESC + '[38;5;' + id + 'm';
  for (let c = col0; c < col0 + n; c++) s += '\\u{10EEEE}' + D[row] + (skipCol && c > col0 ? '' : D[c]);
  return s + ESC + '[39m';
};
out(apc('i=31,s=1,v=1,a=q,t=d,f=24', 'AAAA') + ESC + '[16t' + ESC + '[c');
const da = await waitFor(/\\x1b\\[\\?[\\d;]*c/);
const answered = buf + da.input;
const graphics = /_Gi=31;OK/.test(da.input) ? 'OK' : 'none';
out(ESC + '[?25l' + ESC + '[2J' + ESC + '[H');
out('graphics: ' + graphics + '\\r\\n');
out(ESC + '[31mRED' + ESC + '[0m ' + ESC + '[38;5;208mORANGE256' + ESC + '[0m ' + ESC + '[38;2;10;200;120mTRUE' + ESC + '[0m ' + ESC + '[1;4mBOLDU' + ESC + '[0m ' + ESC + '[7mINV' + ESC + '[0m\\r\\n');
out(ESC + '[10;30HCORNER');
send(7, '${path.join(work, 'a.png')}', 'a=t');
out(apc('a=p,U=1,i=7,c=4,r=2,q=2'));
out(ESC + '[5;10H' + ph(7, 0, 0, 4, false));
out(ESC + '[6;10H' + ph(7, 1, 0, 4, true));
out(ESC + '[12;2H');
send(9, '${path.join(work, 'b.png')}', 'a=T,c=3,r=2,C=1');
out(ESC + '[20;1HREADY-1');
await waitFor(/n/);
out(ESC + '[?1000h' + ESC + '[?1006h' + ESC + '[21;1HMOUSE-ON');
const click = await waitFor(/\\x1b\\[<0;(\\d+);(\\d+)m/);
out(ESC + '[?1000l' + ESC + '[?1006l');
out(ESC + '[?1049h' + ESC + '[2J' + ESC + '[H');
out(apc('a=d,d=I,i=7,q=2'));
out(ESC + '[32mSECOND SCREEN' + ESC + '[0m\\r\\n');
out('\\u250c\\u2500\\u2500\\u2510\\r\\n\\u2514\\u2500\\u2500\\u2518\\r\\n');
out('CLICK ' + click[1] + ',' + click[2] + '\\r\\n');
out('READY-2');
await waitFor(/q/);
out(ESC + '[?1049l' + ESC + '[?25h');
process.exit(0);
`;
fs.writeFileSync(path.join(work, 'app.mjs'), app);
fs.writeFileSync(path.join(work, 'steps.json'), JSON.stringify([
  {waitFor: 'READY-1', timeout: 8000},
  {wait: 150},
  {mark: 'first'},
  {send: 'n'},
  {waitFor: 'MOUSE-ON', timeout: 8000},
  {mouse: {col: 5, row: 7}},
  {waitFor: 'READY-2', timeout: 8000},
  {wait: 150},
  {mark: 'second'},
  {resize: '70x24'},
  {wait: 150},
]));

const cast = path.join(work, 'selftest.cast');
const rec = spawnSync('python3', [path.join(HERE, 'record-tui.py'), '--cols', '60', '--rows', '22', '--cwd', work, '--steps', path.join(work, 'steps.json'), '--out', cast, '--', process.execPath, path.join(work, 'app.mjs')], {encoding: 'utf8'});
check('recorder exits 0', rec.status === 0, rec.stderr.trim().split('\n').slice(-3).join(' | '));
if (rec.status !== 0) finish();

const report = JSON.parse(fs.readFileSync(`${cast}.record.json`, 'utf8'));
check('recorder answered DA1', report.queries_answered.DA1 >= 1);
check('recorder answered the Kitty graphics query', report.queries_answered['kitty graphics query'] >= 1);
check('recorder answered the cell size query', report.queries_answered['CSI 16 t cell size'] >= 1);
check('child exited by the quit key', report.stopped_by === 'quit keys' && report.exit_status === 0, `${report.stopped_by} ${report.exit_status}`);

const castLines = fs.readFileSync(cast, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('cast header is asciicast v2 at 60x22', castLines[0].version === 2 && castLines[0].width === 60 && castLines[0].height === 22);
check('cast holds input events', castLines.some((e) => e[1] === 'i' && e[2] === 'n'));
check('cast holds the Kitty transmission', castLines.some((e) => e[1] === 'o' && e[2].includes('\x1b_Ga=t')));

const out = path.join(work, 'frames');
let converted;
try {
  converted = await convert({cast, out, settleMs: 8, fontSize: 15, cell: {w: 9, h: 19}, png: true, times: [], scale: 2, theme: null, fontFamily: null});
} catch (error) {
  check('cast-to-frames converts the cast', false, error.message);
  finish();
}
const {framesJson: fj, imagesJson: ij, summary} = converted;

const names = fj.markers.map((m) => m.name).join(',');
check('two markers in order', names === 'first,second' && fj.markers[0].t < fj.markers[1].t, names);

const textOf = (frame, y) => {
  const runs = fj.lines[frame.r[y]];
  let line = '';
  for (const run of runs) {
    line = line.padEnd(run[0], ' ');
    line += run[4] ? run[2].repeat(run[1] / run[4]) : run[2];
  }
  return line;
};
const runAt = (frame, y, text) => fj.lines[frame.r[y]].find((r) => r[2] === text);
const first = fj.frames[fj.markers[0].frame];
const second = fj.frames[fj.markers[1].frame];

check('the app saw graphics OK', textOf(first, 0).startsWith('graphics: OK'), textOf(first, 0));
const red = runAt(first, 1, 'RED');
check('16-color text keeps palette index 1', red && fj.styles[red[3]].fg === 1, JSON.stringify(red));
const orange = runAt(first, 1, 'ORANGE256');
check('256-color text keeps index 208', orange && fj.styles[orange[3]].fg === 208);
const tc = runAt(first, 1, 'TRUE');
check('truecolor text keeps #0ac878', tc && fj.styles[tc[3]].fg === '#0ac878');
const bu = runAt(first, 1, 'BOLDU');
check('bold and underline', bu && fj.styles[bu[3]].b === 1 && fj.styles[bu[3]].u === 1);
const inv = runAt(first, 1, 'INV');
check('inverse', inv && fj.styles[inv[3]].inv === 1);
const corner = runAt(first, 9, 'CORNER');
check('cursor move puts CORNER at row 9, col 29', corner && corner[0] === 29, JSON.stringify(corner));
check('READY-1 on row 19', textOf(first, 19).startsWith('READY-1'));

const overlays = first.o !== undefined ? fj.overlays[first.o] : [];
const ph = overlays.find((o) => o.k === '7.1');
check('placeholder image 7 is placed at col 9, row 4, 4x2 cells', ph && ph.c === 9 && ph.r === 4 && ph.w === 4 && ph.h === 2 && ph.sc === 0 && ph.sr === 0, JSON.stringify(ph));
const direct = overlays.find((o) => o.k === '9.1');
check('direct image 9 is placed at col 1, row 11, 3x2 cells', direct && direct.c === 1 && direct.r === 11 && direct.w === 3 && direct.h === 2, JSON.stringify(direct));
const img7 = ij.images.find((i) => i.key === '7.1');
check('image 7 decoded to a 40x40 PNG', img7 && img7.width === 40 && img7.height === 40 && fs.existsSync(path.join(out, img7.file)));
check('image 7 has a 4x2 virtual placement', img7 && img7.placement && img7.placement.cols === 4 && img7.placement.rows === 2 && img7.placement.virtual);
check('image 7 deleted between the markers', img7 && img7.deletedAt > fj.markers[0].t && img7.deletedAt < fj.markers[1].t, String(img7 && img7.deletedAt));
check('image 7 shown interval holds the first marker', img7 && img7.shown.some((s) => s.from <= fj.markers[0].t && s.to >= fj.markers[0].t && s.rect.col === 9 && s.rect.row === 4));

check('second screen shows SECOND SCREEN', textOf(second, 0).startsWith('SECOND SCREEN'), textOf(second, 0));
check('second screen has no image overlays', second.o === undefined);
const box = fj.lines[second.r[1]].find((r) => r[2] === '─');
check('SGR mouse click reached the app at 5,7', textOf(second, 3).startsWith('CLICK 5,7'), textOf(second, 3));
check('resize is recorded and replayed', fj.resizes.length === 1 && JSON.stringify(fj.frames[fj.frames.length - 1].s) === '[70,24]', JSON.stringify(fj.resizes));
check('box drawing is a repeated glyph run', box && box[1] === 2 && box[4] === 1, JSON.stringify(fj.lines[second.r[1]]));
check('frames are in time order', fj.frames.every((f, i) => i === 0 || f.t >= fj.frames[i - 1].t));

check('marker PNGs written', summary.pngs && summary.pngs.length === 2 && summary.pngs.every((f) => fs.statSync(f).size > 1000));
check('contact sheet written', summary.contactSheet && fs.existsSync(summary.contactSheet));

// Pixel checks: the image's left half is red, right half blue, in the marker PNG.
if (summary.pngs) {
  const {chromium} = await import(pathToFileURL(path.join(spawnSync('npm', ['root', '-g'], {encoding: 'utf8'}).stdout.trim(), 'playwright', 'index.mjs')).href).catch(() => ({}));
  if (chromium) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(pathToFileURL(summary.pngs[0]).href);
    const at = async (cx, cy) => page.evaluate(async ([x, y]) => {
      const img = document.images[0];
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
    }, [cx, cy]);
    // Scale 2, cells 9x19. Image box: cols 9-12, rows 4-5. The 40x40 image fits a 36x38 box as 36x36, centered.
    const left = await at(Math.round((9 * 9 + 9) * 2), Math.round((4 * 19 + 19) * 2));
    const right = await at(Math.round((9 * 9 + 27) * 2), Math.round((4 * 19 + 19) * 2));
    const text = await at(0, 0);
    await browser.close();
    check('PNG: image left half is red', left[0] > 200 && left[2] < 60, JSON.stringify(left));
    check('PNG: image right half is blue', right[2] > 200 && right[0] < 60, JSON.stringify(right));
    check('PNG: background is the theme background', Math.abs(text[0] - 0x11) < 8 && Math.abs(text[2] - 0x18) < 8, JSON.stringify(text));
  } else {
    check('Playwright available for pixel checks', false);
  }
}

finish();

function finish() {
  console.log(`\n${passed} passed, ${failures.length} failed${keep ? ` · kept ${work}` : ''}`);
  if (!keep) fs.rmSync(work, {recursive: true, force: true});
  process.exit(failures.length ? 1 : 0);
}
