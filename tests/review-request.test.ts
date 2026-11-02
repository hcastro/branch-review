import {describe, expect, it} from 'vitest';
import type {DiffRange} from '../src/git.js';
import type {ReviewFile} from '../src/review/model.js';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import {patchObjectIds} from '../src/media/classify.js';
import {cardSpecial, reviewCardRequest} from '../src/rendered/review/request.js';
import {specialText} from '../src/rendered/review/special.js';
import {diffFile} from './rendered-helpers.js';

// How the UI process plans each card of the Review in browser page from the
// review it already built: no git, only the review's patches. Where each
// side's text is, what kind of card it is, and the one line a file with no
// diff to show gets.

const RANGE: DiffRange = {base: 'main', branch: 'feature', diffArg: 'main...feature', includeWorktree: false};
const WORKTREE: DiffRange = {base: 'main', branch: 'HEAD', diffArg: 'abc123', includeWorktree: true};

// The one line a file's card draws in place of a diff, or undefined when it draws its diff.
const cardNotice = (file: ReviewFile) => {
  const special = cardSpecial(file);
  return special && specialText(special, file);
};

const withMetrics = (file: ReviewFile, additions: number, deletions: number): ReviewFile => ({...file, metrics: {path: file.path, additions, deletions, changedLines: additions + deletions}});

describe('reviewCardRequest', () => {
  it('reads both sides of a modified file by the blob ids its patch names, and carries its blocks and counts', () => {
    const file = withMetrics(diffFile('a\n', 'b\n', 'src/a.ts'), 1, 1);
    const card = reviewCardRequest(file, RANGE, null);
    expect(card).toMatchObject({path: 'src/a.ts', status: 'modified', kind: 'text', additions: 1, deletions: 1});
    expect(card.blocks.map((block) => block.rawDiff)).toEqual(file.blocks.map((block) => block.rawDiff));
    expect(card.sides.before).toMatchObject({kind: 'blob'});
    expect(card.sides.after).toMatchObject({kind: 'blob'});
    expect(card.special).toBeUndefined();
  });

  it('reads a new file\'s reviewed side only, a deleted file\'s base side only, and the work tree for uncommitted changes', () => {
    expect(reviewCardRequest(diffFile(null, 'b\n', 'new.ts'), RANGE, null).sides.before).toBeUndefined();
    const deleted = reviewCardRequest(diffFile('a\n', null, 'old.ts'), RANGE, null);
    expect(deleted.sides.after).toBeUndefined();
    expect(deleted.sides.before).toMatchObject({kind: 'blob'});
    const changed = diffFile('a\n', 'b\n', 'src/a.ts');
    // Checked against the blob id the patch names, so a file rewritten since is never read as its diff.
    expect(reviewCardRequest(changed, WORKTREE, null).sides.after).toEqual({kind: 'worktree', path: 'src/a.ts', id: patchObjectIds(changed.rawDiff)!.after});
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

describe('the one line in place of a diff', () => {
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

describe('cardSpecial', () => {
  const SUBMODULE = 'diff --git a/lib b/lib\nindex 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 160000\n--- a/lib\n+++ b/lib\n@@ -1 +1 @@\n-Subproject commit 1111111111111111111111111111111111111111\n+Subproject commit 2222222222222222222222222222222222222222\n';
  const ADDED_SUBMODULE = 'diff --git a/lib b/lib\nnew file mode 160000\nindex 0000000..2222222\n--- /dev/null\n+++ b/lib\n@@ -0,0 +1 @@\n+Subproject commit 2222222222222222222222222222222222222222\n';
  const REMOVED_SUBMODULE = 'diff --git a/lib b/lib\ndeleted file mode 160000\nindex 1111111..0000000\n--- a/lib\n+++ /dev/null\n@@ -1 +0,0 @@\n-Subproject commit 1111111111111111111111111111111111111111\n';
  const pointer = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid.repeat(64)}\nsize ${size}\n`;
  const withRaw = (rawDiff: string, status: ReviewFile['status'], path = 'lib'): ReviewFile => ({...diffFile('a\n', 'b\n', path), status, rawDiff, blocks: parseUnifiedDiffBlocks(rawDiff, path)});

  it('names a submodule by the commits it moved between, and draws none of its lines', () => {
    expect(cardSpecial(withRaw(SUBMODULE, 'modified'))).toEqual({kind: 'submodule', before: '1111111111111111111111111111111111111111', after: '2222222222222222222222222222222222222222'});
    expect(cardSpecial(withRaw(ADDED_SUBMODULE, 'added'))).toEqual({kind: 'submodule', after: '2222222222222222222222222222222222222222'});
    expect(cardNotice(withRaw(SUBMODULE, 'modified'))).toBe('Submodule updated from 1111111 to 2222222.');
    expect(cardNotice(withRaw(ADDED_SUBMODULE, 'added'))).toBe('Submodule added at 2222222.');
    expect(cardSpecial(withRaw(REMOVED_SUBMODULE, 'deleted'))).toEqual({kind: 'submodule', before: '1111111111111111111111111111111111111111'});
    expect(cardNotice(withRaw(REMOVED_SUBMODULE, 'deleted'))).toBe('Submodule removed, it was at 1111111.');
  });

  it('reads a submodule only from git\'s header, never from a line of the file that holds a carriage return or a Unicode line break', () => {
    for (const separator of ['\r', '\u2028', '\u2029']) {
      const text = `hello\nfoo${separator}new mode 160000${separator}bar\nHIDDEN_PAYLOAD_LINE\n`;
      const file = diffFile('hello\n', text, 'notes.txt');
      expect(file.rawDiff).toContain(`+foo${separator}new mode 160000`);
      expect(cardSpecial(file), JSON.stringify(separator)).toBeUndefined();
      // Its sides are read, for the diff to draw.
      expect(reviewCardRequest(file, RANGE, null).sides.after).toMatchObject({kind: 'blob'});
      const index = {...file, rawDiff: file.rawDiff.replace('+bar', `+x${separator}index 1111111..2222222 160000`)};
      expect(cardSpecial(index), JSON.stringify(separator)).toBeUndefined();
    }
  });

  it('names a Git LFS pointer by the size of the file it stands for, on the side the review shows', () => {
    const lfs = diffFile(pointer('a', 1_200_000), pointer('b', 2_500_000), 'img/big.psd');
    expect(cardSpecial(lfs)).toEqual({kind: 'lfs', bytes: 2_500_000});
    expect(cardSpecial(diffFile(pointer('a', 1_200_000), null, 'img/big.psd'))).toEqual({kind: 'lfs', bytes: 1_200_000});
    expect(cardNotice(lfs)).toBe('Git LFS file not shown.');
    // Text that only mentions the spec is no pointer.
    expect(cardSpecial(diffFile('a\n', 'version https://git-lfs.github.com/spec/v1 is the format\n', 'notes.txt'))).toBeUndefined();
  });

  it('reads a side as a pointer only when every line its hunk shows is one, as the spec writes them', () => {
    const lines = (...extra: string[]) => `${pointer('a', 10).trimEnd()}\n${extra.join('\n')}${extra.length > 0 ? '\n' : ''}`;
    // A pointer's lines followed by code: the code is the file's, and draws.
    expect(cardSpecial(diffFile(null, lines('echo HIDDEN_PAYLOAD_LINE', 'echo more'), 'run.sh'))).toBeUndefined();
    expect(cardSpecial(diffFile('x\n', lines('echo HIDDEN_PAYLOAD_LINE'), 'run.sh'))).toBeUndefined();
    // Keys out of order, unknown or repeated, a bad oid, no size, a pointer of 1024 bytes or more.
    const version = 'version https://git-lfs.github.com/spec/v1';
    const oid = `oid sha256:${'a'.repeat(64)}`;
    for (const text of [`${version}\nsize 10\n${oid}\n`, `${version}\n${oid}\nsize 10\nzeta 1\n`, `${version}\n${oid}\n${oid}\nsize 10\n`, `${version}\noid sha256:abc\nsize 10\n`, `${version}\n${oid}\n`, `${version}\n${Array.from({length: 12}, (_, at) => `ext-${at}-x sha256:${'b'.repeat(64)}`).join('\n')}\n${oid}\nsize 10\n`]) {
      expect(cardSpecial(diffFile(null, text, 'f.bin'))).toBeUndefined();
    }
    expect(cardSpecial(diffFile(null, `${version}\next-0-tool sha256:${'b'.repeat(64)}\n${oid}\nsize 10\n`, 'f.bin'))).toEqual({kind: 'lfs', bytes: 10});
    // Keys in order, every value well formed, but 1024 bytes or more in all.
    const long = `${version}\next-0-tool ${'b'.repeat(1_000)}\n${oid}\nsize 10\n`;
    expect(Buffer.byteLength(long)).toBeGreaterThanOrEqual(1024);
    expect(cardSpecial(diffFile(null, long, 'f.bin'))).toBeUndefined();
    expect(cardSpecial(diffFile(null, long.replace('b'.repeat(1_000), 'b'.repeat(800)), 'f.bin'))).toEqual({kind: 'lfs', bytes: 10});
  });

  it('carries a mode change that came with changes to the text, for the header to say', () => {
    const file = diffFile('a\n', 'b\n', 'bin/run');
    const raw = file.rawDiff.replace(/^index (\S+) 100644$/m, 'old mode 100644\nnew mode 100755\nindex $1');
    expect(reviewCardRequest({...file, rawDiff: raw}, RANGE, null)).toMatchObject({mode: {from: '100644', to: '100755'}});
    expect(cardSpecial({...file, rawDiff: raw})).toBeUndefined();
  });
});
