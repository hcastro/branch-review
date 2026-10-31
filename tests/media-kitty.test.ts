import {describe, expect, it} from 'vitest';
import {
  KITTY_QUERY,
  PLACEHOLDER,
  apc,
  deleteImage,
  frameGap,
  placeVirtual,
  placeholderRun,
  startLoop,
  tmuxPassthrough,
  tmuxWrap,
  transmitFrame,
  transmitPng,
} from '../src/media/kitty.js';
import {KITTY_DIACRITICS} from '../src/media/kittyDiacritics.js';
import {frameLine, truncateAnsi} from '../src/sections.js';
import {cellWidth, graphemes} from '../src/ui/text.js';

const ESC = '\x1B';
const ST = `${ESC}\\`;

// The start of Kitty's rowcolumn-diacritics table as the cmux probe used it.
const CMUX_PROBE_DIACRITICS = [
  0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a,
  0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365,
  0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f,
  0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
].map((code) => String.fromCodePoint(code));

// Each graphics command as its control keys and payload.
function commands(sequence: string) {
  const found = [...sequence.matchAll(/\x1B_G([^;\x1B]*)(?:;([^\x1B]*))?\x1B\\/g)];
  expect(found.map((match) => match[0]).join('')).toBe(sequence);
  return found.map((match) => ({
    keys: Object.fromEntries(match[1]!.split(',').map((pair) => pair.split('=') as [string, string])),
    payload: match[2] ?? '',
  }));
}

function bytes(count: number) {
  return Uint8Array.from({length: count}, (_, index) => (index * 7 + 3) % 256);
}

describe('graphics commands', () => {
  it('wraps a control string and payload in one APC', () => {
    expect(apc('a=q,i=1')).toBe(`${ESC}_Ga=q,i=1${ST}`);
    expect(apc('a=q,i=1', 'AAAA')).toBe(`${ESC}_Ga=q,i=1;AAAA${ST}`);
  });

  it('sends a PNG as base64 in chunks of at most 4096 bytes, m=1 on all but the last', () => {
    const png = bytes(10_000);
    const sent = commands(transmitPng(7, png));

    expect(sent.length).toBe(Math.ceil(Buffer.from(png).toString('base64').length / 4096));
    expect(sent.length).toBeGreaterThan(2);
    expect(sent[0]!.keys).toEqual({a: 't', f: '100', t: 'd', i: '7', q: '2', m: '1'});
    for (const [index, command] of sent.entries()) {
      expect(command.payload.length).toBeLessThanOrEqual(4096);
      expect(command.keys.m).toBe(index === sent.length - 1 ? '0' : '1');
    }
    for (const command of sent.slice(0, -1)) expect(command.payload.length).toBe(4096);
    expect(Buffer.from(sent.map((command) => command.payload).join(''), 'base64')).toEqual(Buffer.from(png));
  });

  it('ends on m=0 when the base64 fills its last chunk exactly', () => {
    // 3072 bytes are exactly 4096 base64 characters.
    const one = commands(transmitPng(1, bytes(3072)));
    expect(one).toHaveLength(1);
    expect(one[0]!.keys.m).toBe('0');
    expect(one[0]!.payload).toHaveLength(4096);

    const two = commands(transmitPng(1, bytes(6144)));
    expect(two.map((command) => [command.keys.m, command.payload.length])).toEqual([['1', 4096], ['0', 4096]]);
  });

  it('sends a small PNG as one command with m=0', () => {
    const sent = commands(transmitPng(255, bytes(30)));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.keys).toEqual({a: 't', f: '100', t: 'd', i: '255', q: '2', m: '0'});
  });

  it('places, deletes and loops with exact sequences', () => {
    expect(placeVirtual(42, 40, 14)).toBe(`${ESC}_Ga=p,U=1,i=42,c=40,r=14,q=2${ST}`);
    expect(deleteImage(42)).toBe(`${ESC}_Ga=d,d=I,i=42,q=2${ST}`);
    expect(startLoop(42)).toBe(`${ESC}_Ga=a,i=42,s=3,v=1,q=2${ST}`);
  });

  it('sends animation frames chunked like a transmit, with a delay of at least 20 ms', () => {
    const sent = commands(transmitFrame(9, bytes(5000), 5));
    expect(sent[0]!.keys).toEqual({a: 'f', i: '9', f: '100', z: '20', q: '2', m: '1'});
    expect(sent.at(-1)!.keys.m).toBe('0');
    expect(commands(transmitFrame(9, bytes(10), 80))[0]!.keys.z).toBe('80');
  });

  it('quiets every command with q=2 and never deletes with d=A', () => {
    const all = [
      transmitPng(3, bytes(9000)),
      transmitFrame(3, bytes(9000), 40),
      placeVirtual(3, 2, 2),
      deleteImage(3),
      startLoop(3),
    ].join('');
    const sent = commands(all);
    for (const command of sent) expect(command.keys.q, JSON.stringify(command.keys)).toBe('2');
    expect(all).not.toContain('d=A');
    expect(sent.filter((command) => command.keys.a === 'd').map((command) => command.keys.d)).toEqual(['I']);
  });

  it('refuses ids and sizes outside what the placeholder cells can carry', () => {
    for (const id of [0, 256, 1.5, -1, Number.NaN]) {
      expect(() => transmitPng(id, bytes(4)), String(id)).toThrow(RangeError);
      expect(() => deleteImage(id), String(id)).toThrow(RangeError);
    }
    expect(() => placeVirtual(1, 0, 1)).toThrow(RangeError);
    expect(() => placeVirtual(1, 298, 1)).toThrow(RangeError);
    expect(() => placeholderRun(1, 297, 0, 1)).toThrow(RangeError);
    expect(() => placeholderRun(1, 0, 290, 8)).toThrow(RangeError);
  });

  it('asks whether the terminal speaks the protocol with a 1×1 query image', () => {
    expect(KITTY_QUERY).toBe(`${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}`);
  });
});

describe('the row and column diacritics', () => {
  it('has the 297 entries of Kitty\'s table, starting as the cmux probe did and ending at U+1D244', () => {
    expect(KITTY_DIACRITICS).toHaveLength(297);
    expect(KITTY_DIACRITICS.slice(0, 40)).toEqual(CMUX_PROBE_DIACRITICS);
    expect(KITTY_DIACRITICS.at(-1)).toBe('\u{1D244}');
    expect(new Set(KITTY_DIACRITICS).size).toBe(297);
  });

  it('holds only combining marks, so each joins the cell before it', () => {
    for (const mark of KITTY_DIACRITICS) {
      expect(/^\p{Mn}$/u.test(mark), mark.codePointAt(0)!.toString(16)).toBe(true);
    }
  });
});

describe('placeholder runs', () => {
  it('writes the id as a 256-color foreground and addresses every cell by row and column', () => {
    const run = placeholderRun(42, 3, 5, 2);
    const d = KITTY_DIACRITICS;
    expect(run).toBe(`${ESC}[38;5;42m${PLACEHOLDER}${d[3]}${d[5]}${PLACEHOLDER}${d[3]}${d[6]}${ESC}[39m`);
  });

  it('measures one cell per placeholder, the last table entries included', () => {
    expect(cellWidth(placeholderRun(1, 0, 0, 40))).toBe(40);
    expect(cellWidth(placeholderRun(1, 296, 257, 40))).toBe(40);
    const plain = placeholderRun(1, 296, 0, 297).replace(/\x1B\[[0-9;]*m/g, '');
    const cells = graphemes(plain);
    expect(cells).toHaveLength(297);
    expect(cells.every((cell) => cell.width === 1)).toBe(true);
  });

  it('survives frameLine whole, with the border at the pane edge', () => {
    const run = placeholderRun(9, 0, 0, 30);
    const framed = frameLine(run, 30, '');
    expect(framed).toContain(run);
    expect(cellWidth(framed.replace(/\x1B\[[0-9;]*m/g, ''))).toBe(34);
  });

  it('is cut by truncateAnsi at a cell boundary, every kept cell still fully addressed', () => {
    const run = placeholderRun(9, 7, 0, 30);
    const cut = truncateAnsi(run, 12);
    expect(cut.startsWith(`${ESC}[38;5;9m`)).toBe(true);
    const cells = graphemes(cut.replace(/\x1B\[[0-9;]*m/g, ''));
    expect(cells).toHaveLength(12);
    for (const [column, cell] of cells.entries()) {
      expect(cell.text).toBe(`${PLACEHOLDER}${KITTY_DIACRITICS[7]}${KITTY_DIACRITICS[column]}`);
    }
  });
});

describe('tmux passthrough', () => {
  it('wraps the sequence in a DCS and doubles every ESC inside it', () => {
    const inner = deleteImage(5);
    const wrapped = tmuxWrap(inner);
    expect(wrapped).toBe(`${ESC}Ptmux;${inner.replaceAll(ESC, `${ESC}${ESC}`)}${ST}`);
    const body = wrapped.slice(`${ESC}Ptmux;`.length, -ST.length);
    expect(body.replaceAll(`${ESC}${ESC}`, '')).not.toContain(ESC);
  });
});

describe('tmux passthrough for every graphics command', () => {
  it('wraps each APC in a sequence on its own, so no passthrough is longer than one chunk', () => {
    const sequence = transmitPng(7, bytes(10_000)) + placeVirtual(7, 4, 2);
    const wrapped = tmuxPassthrough(sequence);
    const dcs = [...wrapped.matchAll(/\x1BPtmux;((?:[^\x1B]|\x1B\x1B)*)\x1B\\/g)];
    // Nothing outside the passthroughs.
    expect(dcs.map((match) => match[0]).join('')).toBe(wrapped);
    const inner = dcs.map((match) => match[1]!.replaceAll(`${ESC}${ESC}`, ESC));
    expect(inner.join('')).toBe(sequence);
    // One passthrough per command.
    expect(inner).toEqual([...sequence.matchAll(/\x1B_G[^\x1B]*\x1B\\/g)].map((match) => match[0]));
    expect(inner.length).toBe(commands(sequence).length);
    for (const body of dcs.map((match) => match[1]!)) {
      expect(body.replaceAll(`${ESC}${ESC}`, '')).not.toContain(ESC);
      expect(body.length).toBeLessThan(4096 + 64);
    }
  });

  it('leaves an empty sequence empty', () => {
    expect(tmuxPassthrough('')).toBe('');
  });
});

describe('animation frame gaps', () => {
  it('sets a frame\'s gap with an exact sequence, at least 20 ms', () => {
    expect(frameGap(42, 1, 120)).toBe(`${ESC}_Ga=a,i=42,r=1,z=120,q=2${ST}`);
    expect(frameGap(42, 1, 3)).toBe(`${ESC}_Ga=a,i=42,r=1,z=20,q=2${ST}`);
    expect(() => frameGap(42, 0, 100)).toThrow(RangeError);
  });
});
