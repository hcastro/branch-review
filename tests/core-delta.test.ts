import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {getColoredFileDiff, getReviewFileContents, resolveRefs} from '../src/git.js';
import {buildReviewModel, buildReviewSections} from '../src/review/build.js';
import {buildCodePayload, buildFileDiffPayload} from '../src/clipboard/payloads.js';
import {cleanupTempDirs, initRepo, makeTempDir, pathWithOnly, withEnv, writeExecutable, writeFiles} from './core-helpers.js';
import {cellPosition, emitMouseDragAt, emitMousePressAt, flush, renderFixture} from './ui-fixtures.js';

// Each test builds real repos and runs git and delta many times.
vi.setConfig({testTimeout: 30_000});

afterEach(cleanupTempDirs);

const SGR = /\x1B\[[0-9;]*m/;
const COLOR_ENV = {NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: 'xterm-256color'};

function changedRepo() {
  const cwd = initRepo({'a.txt': 'one\n'});
  writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
  return cwd;
}

describe('git and delta run without a shell', () => {
  it('reports a missing delta instead of rendering nothing', () => {
    const cwd = changedRepo();
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const bin = pathWithOnly(['git']);

    withEnv({...COLOR_ENV, PATH: bin}, () => {
      expect(() => buildReviewModel({cwd, range, width: 100})).toThrow(/delta not found/);
    });
  });

  it('shows delta stderr when delta exits non-zero', () => {
    const cwd = changedRepo();
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const bin = pathWithOnly(['git']);
    writeExecutable(path.join(bin, 'delta'), '#!/bin/sh\necho "delta exploded" >&2\nexit 3\n');

    withEnv({...COLOR_ENV, PATH: bin}, () => {
      const model = buildReviewModel({cwd, range, width: 100});
      expect(model.files[0]?.error).toMatch(/delta exploded/);
      expect(model.files[0]?.blocks[0]?.addedCode).toBe('two');
    });
  });

  it('is not affected by a login shell profile', () => {
    const cwd = changedRepo();
    const range = resolveRefs(cwd, 'HEAD', 'main');
    const home = makeTempDir('branch-review-home-');
    const profile = 'echo "Welcome back"\ncd /\n';
    for (const name of ['.bash_profile', '.profile', '.bashrc']) {
      fs.writeFileSync(path.join(home, name), profile);
    }

    withEnv({...COLOR_ENV, HOME: home}, () => {
      const model = buildReviewModel({cwd, range, width: 100});
      const rendered = model.files[0]?.renderedLines.join('\n') ?? '';
      expect(rendered).not.toContain('Welcome back');
      expect(rendered.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')).toContain('two');
    });
  });
});

describe('control characters in file contents', () => {
  it('are visible on screen and kept exact in copy payloads', () => {
    const cwd = initRepo({'evil.sh': 'safe\n'});
    const contents = 'safe\nret\rover\nback\bspace\necho ok; \x1B]0; echo HIDDEN ;\x07\ncsi\u009Bend\n';
    writeFiles(cwd, {'evil.sh': contents});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    withEnv(COLOR_ENV, () => {
      const model = buildReviewModel({cwd, range, width: 100});
      const file = model.files[0]!;
      const rendered = file.renderedLines.join('\n');
      // delta's own colour and erase-line sequences are allowed; nothing else.
      const withoutSgr = rendered.replace(/\x1B\[[0-9;]*[mK]/g, '');

      expect(withoutSgr).toContain('ret^Mover');
      expect(withoutSgr).toContain('back^Hspace');
      expect(withoutSgr).toContain('␛]0; echo HIDDEN ;^G');
      expect(withoutSgr).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F\u0080-\u009F]/);

      expect(buildFileDiffPayload(file)).toContain('+echo ok; \x1B]0; echo HIDDEN ;\x07\n');
      expect(buildCodePayload(file.blocks[0]!)).toContain('ret\rover');
      expect(buildCodePayload(file.blocks[0]!)).toContain('csi\u009Bend');
      expect(getReviewFileContents(cwd, range, file)).toBe(contents);
    });
  });
});

describe('NO_COLOR', () => {
  for (const env of [{NO_COLOR: '1', FORCE_COLOR: undefined}, {NO_COLOR: undefined, FORCE_COLOR: '0'}]) {
    it(`renders the diff without colour when ${JSON.stringify(env)}`, () => {
      const cwd = initRepo({'a.txt': 'one\ngone\n'});
      writeFiles(cwd, {'a.txt': 'one\ntwo\n'});
      const range = resolveRefs(cwd, 'HEAD', 'main');

      withEnv(env, () => {
        const rendered = getColoredFileDiff(cwd, range, 'a.txt', 100);
        expect(rendered).not.toMatch(SGR);
        expect(rendered).toMatch(/│\+two/);
        expect(rendered).toMatch(/│-gone/);
        expect(rendered).toContain('• a.txt:1:');
      });
    });
  }

  it('keeps colour when NO_COLOR is empty', () => {
    const cwd = changedRepo();
    const range = resolveRefs(cwd, 'HEAD', 'main');

    withEnv({NO_COLOR: '', FORCE_COLOR: undefined, TERM: 'xterm-256color'}, () => {
      expect(getColoredFileDiff(cwd, range, 'a.txt', 100)).toMatch(SGR);
    });
  });
});

describe('the Kitty image placeholder character in file contents', () => {
  // A terminal with Kitty graphics draws a transmitted image wherever
  // U+10EEEE appears under a 256-colour foreground, which delta's syntax
  // colours supply. Repo text must never produce such a cell.
  it('is drawn as a marker and copied by drag-select as the raw character', async () => {
    const cwd = initRepo({'icons.txt': 'start\n'});
    writeFiles(cwd, {'icons.txt': 'start\nimg \u{10EEEE}̅̅ end\n'});
    const range = resolveRefs(cwd, 'HEAD', 'main');

    const model = withEnv(COLOR_ENV, () => buildReviewModel({cwd, range, width: 100}));
    const rendered = model.files[0]!.renderedLines.join('\n');
    expect(rendered).toContain('img <U+10EEEE>');
    expect(rendered).not.toContain('\u{10EEEE}');

    const writes: string[] = [];
    const instance = renderFixture({sections: buildReviewSections(model), review: model}, {columns: 150, rows: 30}, writes);
    await flush();
    const frame = instance.lastFrame();
    expect(frame).not.toContain('\u{10EEEE}');
    const from = cellPosition(frame, ['img <U+10EEEE>'], 'img');
    const to = cellPosition(frame, ['img <U+10EEEE>'], 'end', 'end'.length - 1);
    await emitMousePressAt(from.column, from.row);
    await emitMouseDragAt(to.column, to.row);
    await emitMouseDragAt(to.column, to.row, true);
    await flush(2);

    expect(writes).toEqual(['img \u{10EEEE}̅̅ end']);
    instance.unmount();
  });
});
