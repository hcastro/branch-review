import {describe, expect, it} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewFile} from '../src/review/model.js';
import {cardNotice, reviewCardRequest} from '../src/rendered/review/request.js';
import {diffFile} from './rendered-helpers.js';

// How the UI process plans each card of the Review in browser page from the
// review it already built: no git, only the review's patches. Where each
// side's text is, what kind of card it is, and the one line a file with no
// diff to show gets.

const RANGE: DiffRange = {base: 'main', branch: 'feature', diffArg: 'main...feature', includeWorktree: false};
const WORKTREE: DiffRange = {base: 'main', branch: 'HEAD', diffArg: 'abc123', includeWorktree: true};

const withMetrics = (file: ReviewFile, additions: number, deletions: number): ReviewFile => ({...file, metrics: {path: file.path, additions, deletions, changedLines: additions + deletions}});

describe('reviewCardRequest', () => {
  it('reads both sides of a modified file by the blob ids its patch names, and carries its blocks and counts', () => {
    const file = withMetrics(diffFile('a\n', 'b\n', 'src/a.ts'), 1, 1);
    const card = reviewCardRequest(file, RANGE, null);
    expect(card).toMatchObject({path: 'src/a.ts', status: 'modified', kind: 'text', additions: 1, deletions: 1});
    expect(card.blocks.map((block) => block.rawDiff)).toEqual(file.blocks.map((block) => block.rawDiff));
    expect(card.sides.before).toMatchObject({kind: 'blob'});
    expect(card.sides.after).toMatchObject({kind: 'blob'});
    expect(card.notice).toBeUndefined();
  });

  it('reads a new file\'s reviewed side only, a deleted file\'s base side only, and the work tree for uncommitted changes', () => {
    expect(reviewCardRequest(diffFile(null, 'b\n', 'new.ts'), RANGE, null).sides.before).toBeUndefined();
    const deleted = reviewCardRequest(diffFile('a\n', null, 'old.ts'), RANGE, null);
    expect(deleted.sides.after).toBeUndefined();
    expect(deleted.sides.before).toMatchObject({kind: 'blob'});
    expect(reviewCardRequest(diffFile('a\n', 'b\n', 'src/a.ts'), WORKTREE, null).sides.after).toMatchObject({kind: 'worktree', path: 'src/a.ts'});
  });

  it('reads no side of a submodule, whose patch names the submodule\'s commits, which the repo never holds', () => {
    const bump = 'diff --git a/lib b/lib\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 160000\n--- a/lib\n+++ b/lib\n@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n';
    const added = 'diff --git a/lib b/lib\nnew file mode 160000\nindex 0000000..2222222\n--- /dev/null\n+++ b/lib\n@@ -0,0 +1 @@\n+Subproject commit 2222222222222222222222222222222222222222\n';
    const file = (rawDiff: string, status: ReviewFile['status']): ReviewFile => ({...diffFile('a\n', 'b\n', 'lib'), status, rawDiff});
    expect(reviewCardRequest(file(bump, 'modified'), RANGE, null).sides).toEqual({});
    expect(reviewCardRequest(file(added, 'added'), RANGE, null).sides).toEqual({});
    expect(reviewCardRequest(file(bump, 'modified'), WORKTREE, null).sides).toEqual({});
  });

  it('takes its kind and fragment from what the review renders, with the links its rich view draws broken', () => {
    const file = diffFile('# A\n', '# B\n', 'README.md');
    const fragment = {cwd: '/repo', key: 'k', path: 'README.md', status: 'modified' as const, source: {kind: 'none' as const, reason: 'x'}, groups: [], links: {}, assets: {base: null, after: {tree: 'feature'}, epoch: 1}};
    expect(reviewCardRequest(file, RANGE, {kind: 'markdown', fragment, brokenRefs: [2]})).toMatchObject({kind: 'markdown', fragment, brokenRefs: [2]});
  });

  it('carries the old path of a moved file', () => {
    const file = {...diffFile('a\n', 'b\n', 'docs/new.md'), status: 'renamed' as const, oldPath: 'docs/old.md'};
    expect(reviewCardRequest(file, RANGE, null)).toMatchObject({status: 'renamed', oldPath: 'docs/old.md'});
  });
});

describe('cardNotice', () => {
  const bare = (rawDiff: string, overrides: Partial<ReviewFile> = {}): ReviewFile => ({path: 'f', status: 'modified', metrics: {path: 'f', additions: 0, deletions: 0, changedLines: 0}, rawDiff, renderedLines: [], blocks: [], ...overrides});

  it('says why a file has no diff to show, in one line', () => {
    expect(cardNotice(bare('diff --git a/f b/f\nindex 1..2 100644\nBinary files a/f and b/f differ\n'))).toBe('Binary file not shown.');
    expect(cardNotice(bare('diff --git a/f b/f\nold mode 100644\nnew mode 100755\n'))).toBe('File mode changed from 100644 to 100755.');
    expect(cardNotice(bare('diff --git a/a b/f\nsimilarity index 100%\nrename from a\nrename to f\n', {status: 'renamed', oldPath: 'a'}))).toBe('File renamed without changes.');
    expect(cardNotice(bare('diff --git a/f b/f\nnew file mode 100644\nindex 0000000..e69de29\n', {status: 'added'}))).toBe('Empty file added.');
    expect(cardNotice(bare('diff --git a/f b/f\ndeleted file mode 100644\nindex e69de29..0000000\n', {status: 'deleted'}))).toBe('Empty file deleted.');
    expect(cardNotice(bare('', {error: 'git diff failed: boom'}))).toBe("This file's diff couldn't be read: git diff failed: boom");
    expect(cardNotice(diffFile('a\n', 'b\n', 'f'))).toBeUndefined();
  });
});
