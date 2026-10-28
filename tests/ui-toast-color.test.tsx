import React from 'react';
import stripAnsi from 'strip-ansi';
import {render} from 'ink-testing-library';
import {describe, expect, it, vi} from 'vitest';

// Ink colours through chalk, which picks its colour level when first
// imported; force colour on before any import so the frame carries SGR codes.
const previousForceColor = vi.hoisted(() => {
  const previous = process.env.FORCE_COLOR;
  process.env.FORCE_COLOR = '1';
  return previous;
});

const {App} = await import('../src/ui/App.js');
const {buildDiffSections} = await import('../src/sections.js');
const {parseUnifiedDiffBlocks} = await import('../src/blocks/parse.js');

// chalk has read the variable by now; restore it so other test files that
// share this worker process keep their own colour level.
if (previousForceColor === undefined) {
  delete process.env.FORCE_COLOR;
} else {
  process.env.FORCE_COLOR = previousForceColor;
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function renderWithWriter(write: () => Promise<{ok: true; command: {command: string; args: string[]; displayName: string}} | {ok: false; message: string; hint?: string}>) {
  const rawDiff = '@@ -1 +1 @@\n-a\n+b';
  const metrics = {path: 'src/a.ts', additions: 1, deletions: 1, changedLines: 2};
  return render(
    <App
      base="development"
      branch="HEAD"
      sections={buildDiffSections([{path: 'src/a.ts', metrics, diff: '• src/a.ts:1: \n   1 ⋮   1 │b'}])}
      branchMetrics={{filesChanged: 1, additions: 1, deletions: 1, changedLines: 2}}
      review={{
        base: 'development',
        branch: 'HEAD',
        label: 'development...HEAD',
        metrics: {filesChanged: 1, additions: 1, deletions: 1, changedLines: 2},
        files: [{path: 'src/a.ts', status: 'modified', metrics, rawDiff, renderedLines: [], blocks: parseUnifiedDiffBlocks(rawDiff, 'src/a.ts')}],
      }}
      copyWriter={write}
      dimensions={{columns: 150, rows: 30}}
    />,
  );
}

async function clickCopyPath(instance: ReturnType<typeof render>) {
  const lines = stripAnsi(instance.lastFrame() ?? '').split('\n');
  const row = lines.findIndex((line) => line.includes('Copy path'));
  const column = lines[row]!.indexOf('Copy path');
  process.stdin.emit('data', `\u001B[<0;${column + 1};${row + 1}M`);
  await flush();
  await flush();
}

describe('copy toast colour', () => {
  it('draws a failed copy with a failure marker in red', async () => {
    const instance = renderWithWriter(async () => ({ok: false, message: 'Clipboard write failed using pbcopy.', hint: 'boom'}));
    await flush();
    await clickCopyPath(instance);

    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/\u001B\[31m✗ Clipboard write failed using pbcopy\. · boom/);
    expect(stripAnsi(frame)).not.toContain('✓ Clipboard');

    instance.unmount();
  });

  it('draws a successful copy with a check mark in cyan', async () => {
    const instance = renderWithWriter(async () => ({ok: true, command: {command: '/usr/bin/pbcopy', args: [], displayName: 'pbcopy'}}));
    await flush();
    await clickCopyPath(instance);

    expect(instance.lastFrame() ?? '').toMatch(/\u001B\[36m✓ Copied path · src\/a\.ts/);

    instance.unmount();
  });
});
