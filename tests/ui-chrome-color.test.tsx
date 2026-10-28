import {describe, expect, it, vi} from 'vitest';

// Chalk picks its colour level when first imported, and Ink colours through
// it; force full colour before any import of the app so the frame carries
// every SGR code the chrome uses.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '3';
  return previous;
});

const {buildFixture, cellPosition, emitMouseMoveAt, flush, gutter, renderFixture} = await import('./ui-fixtures.js');

if (previousForceColor === undefined) {
  delete process.env.FORCE_COLOR;
} else {
  process.env.FORCE_COLOR = previousForceColor;
}

type Style = {fg: string | null; bold: boolean; dim: boolean};

// The SGR state in effect at the first `needle` on the first frame row that
// holds it.
function styleAt(frame: string, needle: string): Style {
  const strip = (text: string) => text.replace(/\u001B\[[0-9;]*m/g, '');
  const line = frame.split('\n').find((row) => strip(row).includes(needle));
  expect(line, `row with ${JSON.stringify(needle)}`).toBeDefined();
  const target = strip(line!).indexOf(needle);
  const style: Style = {fg: null, bold: false, dim: false};
  let seen = 0;
  for (const part of line!.split(/(\u001B\[[0-9;]*m)/)) {
    const sgr = part.match(/^\u001B\[([0-9;]*)m$/);
    if (!sgr) {
      if (part && seen + part.length > target) return style;
      seen += part.length;
      continue;
    }

    const params = sgr[1] ? sgr[1].split(';') : ['0'];
    for (let index = 0; index < params.length; index += 1) {
      const code = Number(params[index]);
      if (code === 0) Object.assign(style, {fg: null, bold: false, dim: false});
      else if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code === 22) Object.assign(style, {bold: false, dim: false});
      else if (code === 39) style.fg = null;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) style.fg = String(code);
      else if (code === 38) {
        const mode = params[index + 1];
        const length = mode === '5' ? 2 : 4;
        style.fg = params.slice(index, index + 1 + length).join(';');
        index += length;
      } else if (code === 48) {
        index += params[index + 1] === '5' ? 2 : 4;
      }
    }
  }

  return style;
}

function fixture() {
  return buildFixture([
    {path: 'src/alpha.ts', rawDiff: '@@ -1 +1 @@\n-a\n+alpha', rendered: ['• src/alpha.ts:1: ', `${gutter(1)}alpha`]},
    {path: 'src/bravo.ts', rawDiff: '@@ -1 +1 @@\n-b\n+bravo', rendered: ['• src/bravo.ts:1: ', `${gutter(1)}bravo`]},
  ]);
}

describe('chrome colours', () => {
  it('draws tree file names in the default foreground', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 24});
    await flush();

    expect(styleAt(instance.lastFrame() ?? '', '• bravo.ts')).toEqual({fg: null, bold: false, dim: false});

    instance.unmount();
  });

  it('draws directory rows without dim', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 24});
    await flush();

    expect(styleAt(instance.lastFrame() ?? '', '▾ src').dim).toBe(false);

    instance.unmount();
  });

  it('uses plain cyan with bold, never bright cyan, for the title, path, selected row and hovered button', async () => {
    const instance = renderFixture(fixture(), {columns: 120, rows: 24});
    await flush();

    const frame = instance.lastFrame() ?? '';
    expect(styleAt(frame, 'branch-review')).toMatchObject({fg: '36', bold: true});
    expect(styleAt(frame, 'src/alpha.ts')).toMatchObject({fg: '36', bold: true});
    expect(styleAt(frame, '• alpha.ts')).toMatchObject({fg: '36', bold: true});

    const button = cellPosition(frame, ['Copy path'], 'Copy path', 2);
    await emitMouseMoveAt(button.column, button.row);
    await flush();
    expect(styleAt(instance.lastFrame() ?? '', 'Copy path')).toMatchObject({fg: '36', bold: true});
    expect(instance.lastFrame()).not.toMatch(/\u001B\[(?:[0-9;]*;)?96[;m]/);

    instance.unmount();
  });
});
