import {afterEach, describe, expect, it, vi} from 'vitest';
import {isColorDisabled, makeControlCharsVisible, resolveRefs} from '../src/git.js';
import {buildReviewModel} from '../src/review/build.js';
import {buildCodePayload, buildFileDiffPayload, buildPathPayload} from '../src/clipboard/payloads.js';
import {toDisplayText} from '../src/ui/text.js';
import {cleanupTempDirs, initRepo, withEnv, writeFiles} from './core-helpers.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

// The hidden set from the escaping decision, outside C0, DEL and C1.
const INVISIBLE = [
  0x061C, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069,
  0x00AD, 0x200B, 0x200C, 0x200D, 0x2028, 0x2029, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF,
  0xE0000, 0xE0001, 0xE0041, 0xE007F,
];

function marker(code: number) {
  return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

const RAW_HIDDEN = new RegExp('[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F\\u00AD\\u061C\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u{E0000}-\\u{E007F}]', 'u');

describe('one escape table for diff content and paths', () => {
  it('shows each invisible or bidi character in a path as a marker', () => {
    for (const code of INVISIBLE) {
      const char = String.fromCodePoint(code);
      expect(toDisplayText(`a${char}.ts`)).toBe(`a${marker(code)}.ts`);
    }
  });

  it('shows the same characters in diff content as markers, keeping tab and newline', () => {
    const text = INVISIBLE.map((code) => String.fromCodePoint(code)).join('') + '\tend\n';
    expect(makeControlCharsVisible(text)).toBe(`${INVISIBLE.map(marker).join('')}\tend\n`);
    expect(makeControlCharsVisible('x\x1B[31my\rz\x7F\u009B')).toBe('x␛[31my^Mz^?<U+009B>');
  });

  it('keeps ordinary non-ASCII text, emoji included', () => {
    expect(toDisplayText('café 日本 😀.ts')).toBe('café 日本 😀.ts');
    expect(makeControlCharsVisible('café 日本 😀\n')).toBe('café 日本 😀\n');
  });

  it('never lets a bidi override in a diff line reach the screen, and copies keep it', () => {
    const cwd = initRepo({'auth.ts': 'safe\n'});
    const line = 'const isAdmin = false; // \u202E } if (isAdmin) { \u2066 \u200B';
    writeFiles(cwd, {'auth.ts': `safe\n${line}\n`, 'zero\u200Bwidth.ts': 'x\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    withEnv({NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: 'xterm-256color'}, () => {
      const model = buildReviewModel({cwd, range, width: 120});
      for (const file of model.files) {
        // delta's own colour and erase-line sequences are allowed; nothing else.
        expect(file.renderedLines.join('\n').replace(/\x1B\[[0-9;]*[mK]/g, '')).not.toMatch(RAW_HIDDEN);
      }
      const auth = model.files.find((file) => file.path === 'auth.ts')!;
      expect(auth.renderedLines.join('\n')).toContain('<U+202E>');
      expect(auth.renderedLines.join('\n')).toContain('<U+2066>');
      expect(buildFileDiffPayload(auth)).toContain(`+${line}\n`);
      expect(buildCodePayload(auth.blocks[0]!)).toBe(line);

      const zero = model.files.find((file) => file.path === 'zero\u200Bwidth.ts')!;
      expect(buildPathPayload(zero)).toBe('zero\u200Bwidth.ts');
      expect(toDisplayText(zero.path)).toBe('zero<U+200B>width.ts');
    });
  });
});

describe('colour-off rule', () => {
  const off: NodeJS.ProcessEnv[] = [
    {NO_COLOR: '1'},
    {NO_COLOR: 'yes'},
    {FORCE_COLOR: '0'},
    {FORCE_COLOR: 'false'},
    {TERM: 'dumb'},
  ];
  const on: NodeJS.ProcessEnv[] = [
    {},
    {NO_COLOR: ''},
    {FORCE_COLOR: '1'},
    {FORCE_COLOR: 'true'},
    {FORCE_COLOR: ''},
    {TERM: 'xterm-256color'},
  ];

  for (const env of off) {
    it(`turns colour off for ${JSON.stringify(env)}`, () => {
      expect(isColorDisabled(env)).toBe(true);
    });
  }

  for (const env of on) {
    it(`keeps colour for ${JSON.stringify(env)}`, () => {
      expect(isColorDisabled(env)).toBe(false);
    });
  }

  it('renders delta without colour under TERM=dumb and FORCE_COLOR=false', () => {
    const cwd = initRepo({'a.txt': 'one\ngone\n'});
    writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    for (const env of [{TERM: 'dumb', NO_COLOR: undefined, FORCE_COLOR: undefined}, {TERM: 'xterm', NO_COLOR: undefined, FORCE_COLOR: 'false'}]) {
      withEnv(env, () => {
        const rendered = buildReviewModel({cwd, range, width: 100}).files[0]!.renderedLines.join('\n');
        expect(rendered).not.toMatch(/\x1B\[[0-9;]*m/);
        expect(rendered).toMatch(/│\+two/);
        expect(rendered).toMatch(/│-gone/);
      });
    }
  });
});
