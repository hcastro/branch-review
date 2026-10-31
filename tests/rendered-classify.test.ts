import {describe, expect, it} from 'vitest';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import {failedMarkdownPage, renderableKind} from '../src/rendered/classify.js';
import type {FileStatus} from '../src/git.js';
import type {ReviewFile} from '../src/review/model.js';

const BRANCH = {includeWorktree: false};

function reviewFile(path: string, rawDiff: string, status: FileStatus = 'modified', extra: Partial<ReviewFile> = {}): ReviewFile {
  return {
    path,
    status,
    metrics: {path, additions: 0, deletions: 0, changedLines: 0},
    rawDiff,
    renderedLines: [],
    blocks: parseUnifiedDiffBlocks(rawDiff, path),
    ...extra,
  };
}

const textPatch = (path: string, mode = '100644') => [
  `diff --git a/${path} b/${path}`,
  `index 1111111..2222222 ${mode}`,
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  '-old',
  '+new',
  '',
].join('\n');

describe('renderableKind', () => {
  it('renders markdown by its extension, in any case', () => {
    for (const path of ['README.md', 'docs/a.markdown', 'b.mdown', 'c.mkd', 'D.MD']) {
      expect(renderableKind(reviewFile(path, textPatch(path)), BRANCH)).toBe('markdown');
    }
    for (const path of ['notes.txt', 'md', 'a.md.bak', '.md']) {
      expect(renderableKind(reviewFile(path, textPatch(path)), BRANCH)).toBeNull();
    }
  });

  it('renders a pure rename, whose patch has no hunks and no index line', () => {
    const rawDiff = 'diff --git a/old.md b/new.md\nsimilarity index 100%\nrename from old.md\nrename to new.md\n';
    expect(renderableKind(reviewFile('new.md', rawDiff, 'renamed', {oldPath: 'old.md'}), BRANCH)).toBe('markdown');
  });

  it('refuses a markdown symlink, a type change, a binary .md and a file that failed to load', () => {
    const link = 'diff --git a/l.md b/l.md\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/l.md\n@@ -0,0 +1 @@\n+target.md\n\\ No newline at end of file\n';
    expect(renderableKind(reviewFile('l.md', link, 'added'), BRANCH)).toBeNull();
    const typeChange = `${textPatch('t.md')}diff --git a/t.md b/t.md\nnew file mode 120000\n`;
    expect(renderableKind(reviewFile('t.md', typeChange), BRANCH)).toBeNull();
    const binary = 'diff --git a/b.md b/b.md\nindex 1111111..2222222 100644\nBinary files a/b.md and b/b.md differ\n';
    expect(renderableKind(reviewFile('b.md', binary), BRANCH)).toBeNull();
    expect(renderableKind(reviewFile('e.md', textPatch('e.md'), 'modified', {error: 'boom'}), BRANCH)).toBeNull();
    expect(renderableKind(reviewFile('n.md', textPatch('n.md'), 'modified', {pathError: 'file name is not UTF-8'}), BRANCH)).toBeNull();
  });

  it('takes images and SVG from the media classifier, and leaves video out', () => {
    const png = 'diff --git a/a.png b/a.png\nindex 029ace0..97fa3ee 100644\nBinary files a/a.png and b/a.png differ\n';
    expect(renderableKind(reviewFile('a.png', png), BRANCH)).toBe('raster');
    expect(renderableKind(reviewFile('s.svg', textPatch('s.svg')), BRANCH)).toBe('svg');
    const mp4 = 'diff --git a/v.mp4 b/v.mp4\nindex 029ace0..97fa3ee 100644\nBinary files a/v.mp4 and b/v.mp4 differ\n';
    expect(renderableKind(reviewFile('v.mp4', mp4), BRANCH)).toBeNull();
  });
});

describe('failedMarkdownPage', () => {
  it('renders a markdown file whose terminal diff failed, and gives one with no patch a card with the reason', () => {
    expect(failedMarkdownPage(reviewFile('e.md', textPatch('e.md'), 'modified', {error: 'delta broke'}), BRANCH)).toEqual({render: true});
    expect(failedMarkdownPage(reviewFile('e.md', '', 'modified', {error: 'git diff failed', rawDiffError: 'git diff failed'}), BRANCH)).toEqual({reason: 'git diff failed'});
    expect(failedMarkdownPage(reviewFile('n.md', '', 'modified', {error: 'x', pathError: 'file name is not UTF-8'}), BRANCH)).toEqual({reason: 'file name is not UTF-8'});
    // Only a failed entry, and only markdown, and never a file that has no page anyway.
    expect(failedMarkdownPage(reviewFile('ok.md', textPatch('ok.md')), BRANCH)).toBeNull();
    expect(failedMarkdownPage(reviewFile('a.txt', '', 'modified', {error: 'boom'}), BRANCH)).toBeNull();
    const link = 'diff --git a/l.md b/l.md\nnew file mode 120000\nindex 0000000..1111111\n--- /dev/null\n+++ b/l.md\n@@ -0,0 +1 @@\n+target.md\n';
    expect(failedMarkdownPage(reviewFile('l.md', link, 'added', {error: 'delta broke'}), BRANCH)).toBeNull();
  });
});
