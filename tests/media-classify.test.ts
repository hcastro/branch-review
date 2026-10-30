import {describe, expect, it} from 'vitest';
import {parseUnifiedDiffBlocks} from '../src/blocks/parse.js';
import {classifyMedia} from '../src/media/classify.js';
import {buildReviewModel} from '../src/review/build.js';
import {resolveRefs, type FileStatus} from '../src/git.js';
import type {ReviewFile} from '../src/review/model.js';
import {git, initRepo, writeFiles} from './core-helpers.js';

// Media is recognised from the patch git already printed: the `index` line's
// object ids, the mode lines and the `Binary files` line. Anything that does
// not fit keeps today's view.

const BRANCH = {includeWorktree: false};
const WORKTREE = {includeWorktree: true};

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

const modifiedPng = [
  'diff --git a/a.png b/a.png',
  'index 029ace0..97fa3ee 100644',
  'Binary files a/a.png and b/a.png differ',
  '',
].join('\n');

const addedPng = [
  'diff --git a/n.png b/n.png',
  'new file mode 100644',
  'index 0000000..90ee2d1',
  'Binary files /dev/null and b/n.png differ',
  '',
].join('\n');

const deletedJpeg = [
  'diff --git a/d.JPG b/d.JPG',
  'deleted file mode 100644',
  'index 99727c6..0000000',
  'Binary files a/d.JPG and /dev/null differ',
  '',
].join('\n');

const svgWithHunks = [
  'diff --git a/s.svg b/s.svg',
  'index b284849..35ecfd6 100644',
  '--- a/s.svg',
  '+++ b/s.svg',
  '@@ -1 +1,2 @@',
  '-<svg/>',
  '+<svg>',
  '+</svg>',
  '',
].join('\n');

describe('classifyMedia', () => {
  it('classifies a modified PNG in branch mode with both sides as blobs', () => {
    expect(classifyMedia(reviewFile('a.png', modifiedPng), BRANCH)).toEqual({
      fileKey: 'a.png',
      kind: 'raster',
      format: 'png',
      before: {side: 'before', source: 'blob', path: 'a.png', abbrevId: '029ace0', key: 'blob|a.png|029ace0'},
      after: {side: 'after', source: 'blob', path: 'a.png', abbrevId: '97fa3ee', key: 'blob|a.png|97fa3ee'},
      hasSourceBlocks: false,
      contentKey: 'png|blob|a.png|029ace0|blob|a.png|97fa3ee',
    });
  });

  it('reads the after side from the work tree in worktree mode', () => {
    const ref = classifyMedia(reviewFile('a.png', modifiedPng), WORKTREE);
    expect(ref?.before?.source).toBe('blob');
    expect(ref?.after).toEqual({side: 'after', source: 'worktree', path: 'a.png', abbrevId: '97fa3ee', key: 'worktree|a.png|97fa3ee'});
  });

  it('has only an after side for an added file and only a before side for a deleted one', () => {
    const added = classifyMedia(reviewFile('n.png', addedPng, 'added'), BRANCH);
    expect(added?.before).toBeUndefined();
    expect(added?.after?.abbrevId).toBe('90ee2d1');
    expect(added?.contentKey).toBe('png|-|blob|n.png|90ee2d1');

    const deleted = classifyMedia(reviewFile('d.JPG', deletedJpeg, 'deleted'), WORKTREE);
    expect(deleted?.format).toBe('jpeg');
    expect(deleted?.after).toBeUndefined();
    expect(deleted?.before?.abbrevId).toBe('99727c6');
  });

  it('reads an untracked file from the work tree', () => {
    const untracked = classifyMedia(reviewFile('u.png', addedPng.replaceAll('n.png', 'u.png'), 'untracked'), BRANCH);
    expect(untracked?.after?.source).toBe('worktree');
    expect(untracked?.before).toBeUndefined();
  });

  it('maps each extension to its format and kind', () => {
    const cases: Array<[string, string, string]> = [
      ['x.png', 'png', 'raster'], ['x.jpg', 'jpeg', 'raster'], ['x.jpeg', 'jpeg', 'raster'], ['x.gif', 'gif', 'raster'],
      ['x.webp', 'webp', 'raster'], ['x.avif', 'avif', 'raster'], ['x.mp4', 'mp4', 'video'], ['x.m4v', 'mp4', 'video'],
      ['x.MOV', 'mov', 'video'], ['x.webm', 'webm', 'video'],
    ];
    for (const [path, format, kind] of cases) {
      const ref = classifyMedia(reviewFile(path, modifiedPng.replaceAll('a.png', path)), BRANCH);
      expect(ref, path).toMatchObject({format, kind});
    }

    for (const path of ['x.txt', 'x.png.txt', 'png', 'x.tiff', 'x.']) {
      expect(classifyMedia(reviewFile(path, modifiedPng.replaceAll('a.png', path)), BRANCH), path).toBeNull();
    }
  });

  it('uses the old path for the before side of a renamed file with an index line', () => {
    const rawDiff = [
      'diff --git a/old.png b/new.png',
      'similarity index 90%',
      'rename from old.png',
      'rename to new.png',
      'index 029ace0..97fa3ee 100644',
      'Binary files a/old.png and b/new.png differ',
      '',
    ].join('\n');
    const ref = classifyMedia(reviewFile('new.png', rawDiff, 'renamed', {oldPath: 'old.png'}), BRANCH);
    expect(ref?.before).toMatchObject({path: 'old.png', abbrevId: '029ace0'});
    expect(ref?.after).toMatchObject({path: 'new.png', abbrevId: '97fa3ee'});
  });

  it('is not media for a pure rename or a mode-only change, which have no index line', () => {
    const rename = ['diff --git a/n.png b/m.png', 'similarity index 100%', 'rename from n.png', 'rename to m.png', ''].join('\n');
    expect(classifyMedia(reviewFile('m.png', rename, 'renamed', {oldPath: 'n.png'}), BRANCH)).toBeNull();

    const modeOnly = ['diff --git a/a.png b/a.png', 'old mode 100644', 'new mode 100755', ''].join('\n');
    expect(classifyMedia(reviewFile('a.png', modeOnly), BRANCH)).toBeNull();
  });

  it('refuses symlinks and gitlinks', () => {
    const symlink = [
      'diff --git a/l.png b/l.png',
      'new file mode 120000',
      'index 0000000..c94b0dc',
      '--- /dev/null',
      '+++ b/l.png',
      '@@ -0,0 +1 @@',
      '+a.png',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(classifyMedia(reviewFile('l.png', symlink, 'added'), BRANCH)).toBeNull();

    // A symlink whose target changed, with the binary line forced.
    const symlinkChange = ['diff --git a/l.png b/l.png', 'index 029ace0..97fa3ee 120000', 'Binary files a/l.png and b/l.png differ', ''].join('\n');
    expect(classifyMedia(reviewFile('l.png', symlinkChange), BRANCH)).toBeNull();

    const gitlink = ['diff --git a/sub.png b/sub.png', 'index 1111111..2222222 160000', 'Binary files a/sub.png and b/sub.png differ', ''].join('\n');
    expect(classifyMedia(reviewFile('sub.png', gitlink), BRANCH)).toBeNull();

    const newGitlink = ['diff --git a/sub.png b/sub.png', 'new file mode 160000', 'index 0000000..2222222', 'Binary files /dev/null and b/sub.png differ', ''].join('\n');
    expect(classifyMedia(reviewFile('sub.png', newGitlink, 'added'), BRANCH)).toBeNull();

    const toLink = ['diff --git a/a.png b/a.png', 'old mode 100644', 'new mode 120000', 'index 029ace0..97fa3ee', 'Binary files a/a.png and b/a.png differ', ''].join('\n');
    expect(classifyMedia(reviewFile('a.png', toLink), BRANCH)).toBeNull();
  });

  it('refuses a type change, which git prints as two patches', () => {
    const rawDiff = [
      'diff --git a/a.png b/a.png',
      'deleted file mode 100644',
      'index 029ace0..0000000',
      'Binary files a/a.png and /dev/null differ',
      'diff --git a/a.png b/a.png',
      'new file mode 120000',
      'index 0000000..c94b0dc',
      '--- /dev/null',
      '+++ b/a.png',
      '@@ -0,0 +1 @@',
      '+b.png',
      '',
    ].join('\n');
    expect(classifyMedia(reviewFile('a.png', rawDiff), BRANCH)).toBeNull();
  });

  it('refuses two patches for one path even with no link mode in either', () => {
    // Each patch alone would be media; together their ids name no one change.
    const rawDiff = [
      'diff --git a/a.png b/a.png',
      'deleted file mode 100644',
      'index 029ace0..0000000',
      'Binary files a/a.png and /dev/null differ',
      'diff --git a/a.png b/a.png',
      'new file mode 100644',
      'index 0000000..97fa3ee',
      'Binary files /dev/null and b/a.png differ',
      '',
    ].join('\n');
    expect(classifyMedia(reviewFile('a.png', rawDiff), BRANCH)).toBeNull();
  });

  it('refuses a file with a path error or a load error', () => {
    expect(classifyMedia(reviewFile('a.png', modifiedPng, 'modified', {pathError: 'name is not UTF-8'}), BRANCH)).toBeNull();
    expect(classifyMedia(reviewFile('a.png', modifiedPng, 'modified', {error: 'delta failed'}), BRANCH)).toBeNull();
  });

  it('refuses a raster or video with text hunks, such as a Git LFS pointer', () => {
    const lfs = [
      'diff --git a/a.png b/a.png',
      'index 3d5a7c1..8e2f0b4 100644',
      '--- a/a.png',
      '+++ b/a.png',
      '@@ -1,3 +1,3 @@',
      ' version https://git-lfs.github.com/spec/v1',
      '-oid sha256:1111111111111111111111111111111111111111111111111111111111111111',
      '-size 1200',
      '+oid sha256:2222222222222222222222222222222222222222222222222222222222222222',
      '+size 1300',
      '',
    ].join('\n');
    expect(classifyMedia(reviewFile('a.png', lfs), BRANCH)).toBeNull();
    expect(classifyMedia(reviewFile('a.mp4', lfs.replaceAll('a.png', 'a.mp4')), BRANCH)).toBeNull();
  });

  it('refuses a raster with neither hunks nor a binary line', () => {
    const empty = ['diff --git a/e.png b/e.png', 'new file mode 100644', 'index 0000000..e69de29', ''].join('\n');
    expect(classifyMedia(reviewFile('e.png', empty, 'added'), BRANCH)).toBeNull();
  });

  it('classifies an SVG with text hunks as having source blocks', () => {
    const ref = classifyMedia(reviewFile('s.svg', svgWithHunks), BRANCH);
    expect(ref).toMatchObject({kind: 'svg', format: 'svg', hasSourceBlocks: true});
    expect(ref?.before?.abbrevId).toBe('b284849');
  });

  it('classifies an SVG marked binary in .gitattributes, with no source blocks', () => {
    const rawDiff = ['diff --git a/s.svg b/s.svg', 'index b284849..35ecfd6 100644', 'Binary files a/s.svg and b/s.svg differ', ''].join('\n');
    expect(classifyMedia(reviewFile('s.svg', rawDiff), BRANCH)).toMatchObject({kind: 'svg', hasSourceBlocks: false});
  });

  it('accepts full-length and sha256 object ids, and refuses ids out of range', () => {
    const sha1 = 'a'.repeat(40);
    const sha256 = 'b'.repeat(64);
    const full = modifiedPng.replace('index 029ace0..97fa3ee', `index ${sha1}..${sha256}`);
    const ref = classifyMedia(reviewFile('a.png', full), BRANCH);
    expect(ref?.before?.abbrevId).toBe(sha1);
    expect(ref?.after?.abbrevId).toBe(sha256);

    expect(classifyMedia(reviewFile('a.png', modifiedPng.replace('index 029ace0..97fa3ee', 'index 029ace..97fa3e')), BRANCH)).toBeNull();
    expect(classifyMedia(reviewFile('a.png', modifiedPng.replace('index 029ace0..97fa3ee', 'index 029ACE0..97fa3ee')), BRANCH)).toBeNull();
  });

  it('remembers the result per review file object and range mode', () => {
    const file = reviewFile('a.png', modifiedPng);
    const first = classifyMedia(file, BRANCH);
    expect(classifyMedia(file, BRANCH)).toBe(first);
    expect(classifyMedia(file, WORKTREE)?.after?.source).toBe('worktree');
    expect(classifyMedia({...file}, BRANCH)).not.toBe(first);
    expect(classifyMedia({...file}, BRANCH)).toEqual(first);
  });

  it('classifies the patches a real git prints for added, modified, deleted and untracked images', () => {
    const png = (tail: string) => `\x89PNG\r\n\x1A\n\0\0\0\rIHDR${tail}`;
    const cwd = initRepo({'a.png': png('one'), 'd.png': png('gone'), 'keep.txt': 'x\n'});
    git(cwd, 'checkout', '-q', '-b', 'feature');
    writeFiles(cwd, {'a.png': png('two'), 'n.png': png('new')});
    git(cwd, 'rm', '-q', 'd.png');
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', 'images');
    writeFiles(cwd, {'u.png': png('untracked')});

    const range = resolveRefs(cwd, 'HEAD', 'main');
    const model = buildReviewModel({cwd, range, width: 100});
    const refs = Object.fromEntries(model.files.map((file) => [file.path, classifyMedia(file, range)]));

    const blobId = (spec: string) => git(cwd, 'rev-parse', spec).trim();
    expect(blobId('main:a.png').startsWith(refs['a.png']!.before!.abbrevId)).toBe(true);
    expect(blobId('HEAD:a.png').startsWith(refs['a.png']!.after!.abbrevId)).toBe(true);
    expect(refs['n.png']).toMatchObject({kind: 'raster', after: {source: 'worktree'}});
    expect(refs['n.png']?.before).toBeUndefined();
    expect(refs['d.png']).toMatchObject({kind: 'raster', before: {source: 'blob'}});
    expect(refs['d.png']?.after).toBeUndefined();
    expect(refs['a.png']?.after?.source).toBe('worktree');
    expect(refs['u.png']).toMatchObject({kind: 'raster', after: {source: 'worktree', path: 'u.png'}});
    expect(refs['u.png']?.before).toBeUndefined();

    // Naming the branch reviews commits only, so every side is a blob.
    const branchRange = resolveRefs(cwd, 'feature', 'main');
    const branchModel = buildReviewModel({cwd, range: branchRange, width: 100});
    const branchRef = classifyMedia(branchModel.files.find((file) => file.path === 'a.png')!, branchRange);
    expect(branchRef?.after).toMatchObject({source: 'blob', abbrevId: refs['a.png']!.after!.abbrevId});
  }, 30_000);
});
