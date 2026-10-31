import {describe, expect, it} from 'vitest';
import {buildFixture, flush, gutter, renderFixture} from './ui-fixtures.js';

// The rendered view renders the review's markdown in the background, the
// file under the reader's eyes first: the UI tells it which file that is.

describe('the rendered view\'s focus', () => {
  it('follows the active file as the reader moves through the review', async () => {
    const focused: string[] = [];
    const fixture = buildFixture([
      {path: 'README.md', rawDiff: '@@ -1 +1 @@\n-a\n+alpha', rendered: ['• README.md:1: ', `${gutter(1)}alpha`]},
      {path: 'docs/guide.md', rawDiff: '@@ -1 +1 @@\n-g\n+guide', rendered: ['• docs/guide.md:1: ', `${gutter(1)}guide`]},
    ]);
    const instance = renderFixture({...fixture, rendered: {focus: (fileKey) => focused.push(fileKey)}}, {columns: 120, rows: 30});
    await flush();
    expect(focused).toEqual(['README.md']);

    instance.stdin.write('\u001B[B');
    await flush(2);
    expect(focused).toEqual(['README.md', 'docs/guide.md']);
    instance.unmount();
  });
});
