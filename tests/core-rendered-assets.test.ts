import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {ReviewFile} from '../src/review/model.js';
import {runOperationAsync} from '../src/git.js';
import {createAssetResolver, LATE_IDENTITY, pageLookups, reviewAssetSides, type AssetResolver, type AssetSides, type AssetUse} from '../src/rendered/assets.js';
import type {EmbeddersResult, FragmentRequest, FragmentResult, PageResult} from '../src/rendered/backend.js';
import type {RunOperation} from '../src/rendered/tree.js';
import {changeGroups, type ChangeGroup} from '../src/rendered/changes.js';
import {renderMarkdown, repoPathFor, PAGE_INLINE_LIMIT, type AssetAnswer} from '../src/rendered/markdown.js';
import {createRenderedHandler, summarize} from '../src/rendered/worker/handler.js';
import {cleanupTempDirs, commitAll, git, gitSpy, initRepo, makeTempDir, withEnvAsync, writeExecutable, writeFiles} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';
import {diffFile} from './rendered-helpers.js';

// The asset rule on real repos: an image is inlined only when it is a
// regular file git tracks on that side of the diff, or a file this review
// changed; everything else is a card that says why GitHub won't show it.

afterEach(cleanupTempDirs);

const RED = pngFixture(3, 2, [200, 40, 40, 255]);
const BLUE = pngFixture(4, 5, [40, 40, 200, 255]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10"/></svg>';

function writeBytes(repo: string, file: string, bytes: Buffer | string) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), {recursive: true});
  fs.writeFileSync(path.join(repo, file), bytes);
}

const dataUrl = (mime: string, bytes: Buffer | string) => `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
const blobId = (repo: string, rev: string) => git(repo, 'rev-parse', rev).trim();

// A branch `feature` off `main`; the review is `feature main`.
function refSides(): AssetSides {
  return {base: 'main...feature', after: {tree: 'feature'}, epoch: 0};
}

// README.md's page under the asset rule, as the worker renders it.
function renderPage(resolver: AssetResolver, sides: AssetSides, source: string, groups: ChangeGroup[] = []) {
  return renderMarkdown({path: 'README.md', source, groups, ...pageLookups(resolver, sides, false), link: () => ({kind: 'outside'})});
}

// The text of each `before` view on a page.
const beforeViews = (html: string) => [...html.matchAll(/<div class="br-before-body">([\s\S]*?)<\/div><\/details>/g)].map((match) => match[1]!);

describe('the asset rule at a ref', () => {
  it('inlines a tracked image with its type, id and size', async () => {
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'docs/logo.png', RED);
    writeBytes(repo, 'docs/flow.svg', SVG);
    commitAll(repo, 'images');
    const resolver = createAssetResolver({cwd: repo});

    expect((await resolver.answer(refSides(), 'after', 'docs/logo.png')).answer)
      .toEqual({kind: 'embed', mime: 'image/png', dataUrl: dataUrl('image/png', RED), oid: blobId(repo, 'feature:docs/logo.png'), width: 3, height: 2});
    expect((await resolver.answer(refSides(), 'after', 'docs/flow.svg')).answer)
      .toMatchObject({kind: 'embed', mime: 'image/svg+xml', dataUrl: dataUrl('image/svg+xml', SVG), width: 20, height: 10});
  });

  it('reads the base side from the merge base and the after side from the branch', async () => {
    const repo = initRepo();
    writeBytes(repo, 'logo.png', RED);
    commitAll(repo, 'red');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'logo.png', BLUE);
    commitAll(repo, 'blue');
    // main moves on after the fork: the base side is still the fork point.
    git(repo, 'checkout', '-q', 'main');
    writeBytes(repo, 'logo.png', pngFixture(1, 1));
    commitAll(repo, 'main moved');
    const resolver = createAssetResolver({cwd: repo});

    expect((await resolver.answer(refSides(), 'base', 'logo.png')).answer).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', RED)});
    expect((await resolver.answer(refSides(), 'after', 'logo.png')).answer).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', BLUE)});
  });

  it('says why an image GitHub would not show is a card: untracked, ignored, missing, case mismatch', async () => {
    const repo = initRepo({'.gitignore': 'secret/\n'});
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'docs/Logo.png', RED);
    commitAll(repo, 'logo');
    writeBytes(repo, 'notes/draft.png', RED);
    writeBytes(repo, 'secret/key.png', RED);
    // Ignored files are never read: one nobody can read is still only ignored.
    fs.chmodSync(path.join(repo, 'secret/key.png'), 0o000);
    const resolver = createAssetResolver({cwd: repo});
    const answer = async (file: string) => (await resolver.answer(refSides(), 'after', file)).answer;

    expect(await answer('notes/draft.png')).toEqual({kind: 'refused', reason: 'untracked'});
    expect(await answer('secret/key.png')).toEqual({kind: 'refused', reason: 'ignored'});
    expect(await answer('docs/missing.png')).toEqual({kind: 'refused', reason: 'missing'});
    expect(await answer('docs/logo.png')).toEqual({kind: 'refused', reason: 'caseMismatch', hint: 'logo.png vs Logo.png'});
    expect(await answer('Docs/Logo.png')).toEqual({kind: 'refused', reason: 'caseMismatch', hint: 'Docs/Logo.png vs docs/Logo.png'});
    fs.chmodSync(path.join(repo, 'secret/key.png'), 0o600);
  });

  it('never follows a symlink, never reads a submodule, and leaves an LFS pointer unfetched', async () => {
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'real/logo.png', RED);
    fs.symlinkSync('real/logo.png', path.join(repo, 'link.png'));
    fs.symlinkSync('real', path.join(repo, 'linked'));
    writeBytes(repo, 'big.png', 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n');
    writeBytes(repo, 'notes.txt', 'plain text\n');
    git(repo, 'add', '-A');
    const commit = blobId(repo, 'HEAD');
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${commit},vendor/lib`);
    git(repo, 'commit', '-q', '-m', 'links');
    const resolver = createAssetResolver({cwd: repo});
    const answer = async (file: string) => (await resolver.answer(refSides(), 'after', file)).answer;

    expect(await answer('link.png')).toEqual({kind: 'refused', reason: 'symlink'});
    expect(await answer('linked/logo.png')).toEqual({kind: 'refused', reason: 'symlink'});
    expect(await answer('vendor/lib')).toEqual({kind: 'refused', reason: 'submodule'});
    expect(await answer('vendor/lib/logo.png')).toEqual({kind: 'refused', reason: 'submodule'});
    expect(await answer('big.png')).toEqual({kind: 'refused', reason: 'lfs'});
    expect(await answer('notes.txt')).toEqual({kind: 'refused', reason: 'notImage'});
    expect(await answer('real/logo.png')).toMatchObject({kind: 'embed'});
  });

  it('shows an image over 8 MB as a card without reading it', async () => {
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'huge.png', Buffer.concat([RED, Buffer.alloc(8 * 1024 * 1024)]));
    commitAll(repo, 'huge');
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(refSides(), 'after', 'huge.png')).answer).toEqual({kind: 'refused', reason: 'tooLarge'});
  });

  it('lists each ref\'s files once per review, however many images a page has', async () => {
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    for (let index = 0; index < 5; index += 1) writeBytes(repo, `img/${index}.png`, RED);
    commitAll(repo, 'images');
    const spy = gitSpy();
    const resolver = createAssetResolver({cwd: repo});
    await withEnvAsync({PATH: spy.pathValue}, async () => {
      for (let index = 0; index < 5; index += 1) await resolver.answer(refSides(), 'after', `img/${index}.png`);
      // A new review asks which commit the branch is at, and lists its tree only if that moved.
      await resolver.answer({...refSides(), epoch: 1}, 'after', 'img/0.png');
    });
    expect(spy.calls().filter((call) => /\bls-tree\b/.test(call.args))).toHaveLength(1);
  });
});

describe('lookups that must never reach git or the network', () => {
  it('answers an image path that decodes to an absolute path or a control character as outside the repo, without asking git', async () => {
    expect(repoPathFor('README.md', '/%2F/etc/hosts.png')).toBeNull();
    expect(repoPathFor('README.md', 'logo%00.png')).toBeNull();
    expect(repoPathFor('README.md', 'a%0Ab.png')).toBeNull();
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    const spy = gitSpy();
    const resolver = createAssetResolver({cwd: repo});
    const fragment = await withEnvAsync({PATH: spy.pathValue}, () => renderPage(resolver, refSides(), '# Title\n\n![a](/%2F/etc/hosts.png)\n\n![b](logo%00.png)\n'));
    expect(fragment.html.match(/won't render on GitHub: outside the repo/g)).toHaveLength(2);
    expect(spy.calls().filter((call) => /hosts|logo/.test(call.args))).toEqual([]);
  });

  it('shows an image whose lookup fails as a card in words that carry no path, and renders the rest of the page', async () => {
    const resolver = createAssetResolver({cwd: '/nowhere', run: async () => {
      throw new Error("git ls-tree failed: fatal: '/private/var/folders/x/repo' is outside repository");
    }});
    const fragment = await renderPage(resolver, refSides(), '# Title\n\n![a](logo.png)\n');
    expect(fragment.html).toContain("image not inlined · can't read it from git · logo.png");
    expect(fragment.html).toContain('Title');
    expect(fragment.html).not.toContain('/private/');
  });

  it('fetches nothing in a partial clone: an image whose blob the clone lacks is a card', async () => {
    const source = initRepo({'README.md': '# Project\n'});
    writeBytes(source, 'docs/logo.png', RED);
    writeBytes(source, 'docs/other.png', BLUE);
    commitAll(source, 'images');
    git(source, 'config', 'uploadpack.allowFilter', 'true');
    const holder = makeTempDir('branch-review-partial-');
    git(holder, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${source}`, 'clone');
    const clone = path.join(holder, 'clone');
    const missing = () => git(clone, 'rev-list', '--objects', '--all', '--missing=print').split('\n').filter((line) => line.startsWith('?')).length;
    const before = missing();
    expect(before).toBeGreaterThan(0);

    const resolver = createAssetResolver({cwd: clone});
    const sides: AssetSides = {base: null, after: {tree: 'HEAD'}, epoch: 0};
    expect((await resolver.answer(sides, 'after', 'docs/logo.png')).answer).toEqual({kind: 'refused', reason: 'unreadable', hint: "can't read it from git"});
    expect(missing()).toBe(before);
  });

  it('reads no image in a partial clone on a git too old to keep from fetching, and fetches nothing', async () => {
    const source = initRepo({'README.md': '# Project\n'});
    writeBytes(source, 'docs/logo.png', RED);
    commitAll(source, 'images');
    git(source, 'config', 'uploadpack.allowFilter', 'true');
    const holder = makeTempDir('branch-review-partial-');
    git(holder, 'clone', '-q', '--filter=blob:none', '--no-checkout', `file://${source}`, 'clone');
    const clone = path.join(holder, 'clone');
    const missing = () => git(clone, 'rev-list', '--objects', '--all', '--missing=print').split('\n').filter((line) => line.startsWith('?')).length;
    const before = missing();
    expect(before).toBeGreaterThan(0);

    // A git before 2.44: it says so, and it doesn't know GIT_NO_LAZY_FETCH.
    const bin = makeTempDir('branch-review-old-git-');
    const realGit = execFileSync('/usr/bin/which', ['git'], {encoding: 'utf8'}).trim();
    writeExecutable(path.join(bin, 'git'), [
      '#!/bin/sh',
      'for last; do :; done',
      'if [ "$last" = version ]; then echo "git version 2.43.0"; exit 0; fi',
      'unset GIT_NO_LAZY_FETCH',
      `exec '${realGit}' "$@"`,
      '',
    ].join('\n'));
    const resolver = createAssetResolver({cwd: clone});
    const sides: AssetSides = {base: null, after: {tree: 'HEAD'}, epoch: 0};
    const answer = await withEnvAsync({PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`}, () => resolver.answer(sides, 'after', 'docs/logo.png'));
    expect(answer.answer).toEqual({kind: 'refused', reason: 'unreadable', hint: "can't read it from git"});
    expect(missing()).toBe(before);
  });

  it('asks again for each review whether a file git doesn\'t track is untracked or ignored', async () => {
    const repo = initRepo();
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'notes/draft.png', RED);
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(refSides(), 'after', 'notes/draft.png')).answer).toEqual({kind: 'refused', reason: 'untracked'});
    writeBytes(repo, '.gitignore', 'notes/\n');
    expect((await resolver.answer(refSides(), 'after', 'notes/draft.png')).answer).toEqual({kind: 'refused', reason: 'untracked'});
    expect((await resolver.answer({...refSides(), epoch: 1}, 'after', 'notes/draft.png')).answer).toEqual({kind: 'refused', reason: 'ignored'});
  });

  it('shows an image whose lookups run past the page budget as a card, and renders the page', async () => {
    const hanging = {
      answer: () => new Promise(() => undefined),
      identity: async () => 'never',
      compare: () => new Promise(() => undefined),
    } as unknown as AssetResolver;
    const uses: AssetUse[] = [];
    const fragment = await renderMarkdown({path: 'README.md', source: '# Title\n\n![a](a.png)\n', groups: [], ...pageLookups(hanging, refSides(), false, uses, {budgetMs: 50}), link: () => ({kind: 'outside'})});
    expect(fragment.html).toContain('image not inlined · took too long to read · a.png');
    expect(fragment.html).toContain('Title');
    // Held under no identity the resolver gives, so the page renders again next time.
    expect(uses).toEqual([{side: 'after', path: 'a.png', identity: 'late'}]);
  }, 10_000);

  it('inlines a page\'s images while its link checks run past the budget, which leaves those links unchecked', async () => {
    const embed: AssetAnswer = {kind: 'embed', mime: 'image/png', dataUrl: dataUrl('image/png', RED), oid: 'abc123'};
    const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    // Each image reads in 40 ms; each link check takes 600 ms, as git does on a busy machine.
    const slowLinks = {
      answer: () => later(40, {answer: embed, identity: 'blob:abc123'}),
      identity: async () => 'blob:abc123',
      compare: async () => ({changed: false, base: 'b', after: 'a'}),
      linkTarget: () => ({known: later(600, {kind: 'missing'} as const), checked: later(600, {kind: 'missing'} as const)}),
    } as unknown as AssetResolver;
    const lookups = pageLookups(slowLinks, refSides(), false, [], {budgetMs: 300});
    const fragment = await renderMarkdown({path: 'README.md', source: '# Title\n\n[a](a.md) and [b](b.md).\n\n![a](a.png)\n', groups: [], ...lookups, link: lookups.linkTarget});
    expect(fragment.html).toContain(`src="${embed.dataUrl}"`);
    expect(fragment.html).not.toContain('took too long to read');
    expect(fragment.links.map((link) => link.status)).toEqual(['unchecked', 'unchecked']);
  }, 10_000);
});

describe('the asset rule in the work tree', () => {
  // The review is `HEAD main` with uncommitted changes: files the review
  // changed come from disk under the ids its diff named, and every other
  // file is as the merge base holds it.
  function worktreeSides(repo: string, changed: Array<{path: string; id: string | null}>): AssetSides {
    return {base: blobId(repo, 'main'), after: {worktree: changed.map((change) => ({...change, mode: change.id ? 'regular' : null}))}, epoch: 0};
  }
  const hashOf = (repo: string, file: string) => git(repo, 'hash-object', file).trim();

  it('inlines a changed image from disk, an unchanged one as the base holds it, and an untracked one the review shows', async () => {
    const repo = initRepo();
    writeBytes(repo, 'kept.png', RED);
    writeBytes(repo, 'edited.png', RED);
    commitAll(repo, 'images');
    writeBytes(repo, 'edited.png', BLUE);
    writeBytes(repo, 'new.png', BLUE);
    const sides = worktreeSides(repo, [{path: 'edited.png', id: hashOf(repo, 'edited.png')}, {path: 'new.png', id: hashOf(repo, 'new.png')}]);
    const resolver = createAssetResolver({cwd: repo});
    const answer = async (file: string) => (await resolver.answer(sides, 'after', file)).answer;

    expect(await answer('kept.png')).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', RED)});
    expect(await answer('edited.png')).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', BLUE)});
    expect(await answer('new.png')).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', BLUE)});
    expect((await resolver.answer(sides, 'base', 'edited.png')).answer).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', RED)});
  });

  it('refuses a file deleted in the work tree, a symlink swapped in, and bytes that are not the ones the review read', async () => {
    const repo = initRepo();
    writeBytes(repo, 'gone.png', RED);
    writeBytes(repo, 'swapped.png', RED);
    writeBytes(repo, 'target.png', RED);
    commitAll(repo, 'images');
    fs.rmSync(path.join(repo, 'gone.png'));
    fs.rmSync(path.join(repo, 'swapped.png'));
    fs.symlinkSync('target.png', path.join(repo, 'swapped.png'));
    const staleId = hashOf(repo, 'target.png');
    writeBytes(repo, 'moving.png', BLUE);
    const sides = worktreeSides(repo, [{path: 'gone.png', id: null}, {path: 'moving.png', id: staleId}]);
    const resolver = createAssetResolver({cwd: repo});
    const answer = async (file: string) => (await resolver.answer(sides, 'after', file)).answer;

    expect(await answer('gone.png')).toEqual({kind: 'refused', reason: 'missing'});
    expect(await answer('swapped.png')).toEqual({kind: 'refused', reason: 'symlink'});
    expect(await answer('moving.png')).toMatchObject({kind: 'refused', reason: 'unreadable'});
  });

  it('shows an image nobody may read as a card that names no path from this machine', async () => {
    const repo = initRepo();
    writeBytes(repo, 'locked.png', BLUE);
    const sides = worktreeSides(repo, [{path: 'locked.png', id: hashOf(repo, 'locked.png')}]);
    fs.chmodSync(path.join(repo, 'locked.png'), 0o000);
    try {
      const resolver = createAssetResolver({cwd: repo});
      expect((await resolver.answer(sides, 'after', 'locked.png')).answer).toEqual({kind: 'refused', reason: 'unreadable', hint: "can't read the file"});
      const fragment = await renderPage(resolver, sides, '![Locked](locked.png)\n');
      expect(fragment.html).toContain("image not inlined · can't read the file · locked.png");
      for (const text of ['/Users/', '/home/', '/private/', '/var/', repo]) expect(fragment.html).not.toContain(text);
    } finally {
      fs.chmodSync(path.join(repo, 'locked.png'), 0o600);
    }
  });

  it('reads a pure rename from disk under the id its old path had', async () => {
    const repo = initRepo();
    writeBytes(repo, 'logo.png', RED);
    commitAll(repo, 'logo');
    git(repo, 'mv', 'logo.png', 'moved.png');
    const file = {path: 'moved.png', oldPath: 'logo.png', status: 'renamed', rawDiff: git(repo, 'diff', '-M', '--cached', 'main')} as ReviewFile;
    const sides = reviewAssetSides({files: [file]}, {diffArg: blobId(repo, 'main'), branch: 'HEAD', includeWorktree: true}, 0);
    expect(sides.after).toEqual({worktree: [{path: 'logo.png', id: null, mode: null}, {path: 'moved.png', id: null, mode: 'regular', from: 'logo.png'}]});
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(sides, 'after', 'moved.png')).answer).toMatchObject({kind: 'embed', dataUrl: dataUrl('image/png', RED)});
    expect((await resolver.answer(sides, 'after', 'logo.png')).answer).toEqual({kind: 'refused', reason: 'missing'});
  });

  it('refuses an image under a work tree folder that resolves outside the repo', async () => {
    const repo = initRepo();
    writeBytes(repo, 'assets/logo.png', RED);
    commitAll(repo, 'logo');
    const outside = makeTempDir('branch-review-outside-');
    writeBytes(outside, 'logo.png', RED);
    fs.rmSync(path.join(repo, 'assets'), {recursive: true});
    fs.symlinkSync(outside, path.join(repo, 'assets'));
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(worktreeSides(repo, []), 'after', 'assets/logo.png')).answer).toEqual({kind: 'refused', reason: 'outside'});
  });

  it('says an image written in other case than a file the review added is a case mismatch', async () => {
    const repo = initRepo();
    writeBytes(repo, 'Logo.png', RED);
    const sides = worktreeSides(repo, [{path: 'Logo.png', id: hashOf(repo, 'Logo.png')}]);
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(sides, 'after', 'logo.png')).answer).toEqual({kind: 'refused', reason: 'caseMismatch', hint: 'logo.png vs Logo.png'});
  });

  it('inlines work tree images a line-end filter rewrote, as git holds them, well within the budget', async () => {
    const repo = initRepo({'.gitattributes': '*.svg text eol=crlf\n'});
    const names = Array.from({length: 12}, (_, index) => `img/${index}.svg`);
    for (const name of names) writeBytes(repo, name, `${SVG}\n<!-- ${name} -->\n`);
    commitAll(repo, 'diagrams');
    // Checked out again, so the filter writes CRLF line ends.
    for (const name of names) fs.rmSync(path.join(repo, name));
    git(repo, 'checkout', '--', '.');
    expect(fs.readFileSync(path.join(repo, names[0]!), 'latin1')).toContain('\r\n');

    const resolver = createAssetResolver({cwd: repo});
    const started = Date.now();
    const fragment = await renderPage(resolver, worktreeSides(repo, []), names.map((name) => `![${name}](${name})`).join('\n\n'));
    // Well inside a fragment's 5 second deadline: no image waits to be read again.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(fragment.html.match(/data:image\/svg\+xml;base64,/g)).toHaveLength(12);
  });

  it('shows a checked-out LFS image as the LFS card GitHub shows for it', async () => {
    const repo = initRepo();
    writeBytes(repo, 'big.png', 'version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n');
    commitAll(repo, 'pointer');
    // As LFS's smudge filter writes it: the object, where git holds the pointer.
    writeBytes(repo, 'big.png', RED);
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(worktreeSides(repo, []), 'after', 'big.png')).answer).toEqual({kind: 'refused', reason: 'lfs'});
  });

  it('inlines an untracked image the review shows, saying it is not part of a push yet', async () => {
    const repo = initRepo();
    writeBytes(repo, 'draft.png', RED);
    const sides: AssetSides = {base: blobId(repo, 'main'), after: {worktree: [{path: 'draft.png', id: hashOf(repo, 'draft.png'), mode: 'regular', untracked: true}]}, epoch: 0};
    const fragment = await renderPage(createAssetResolver({cwd: repo}), sides, '![Draft](draft.png)\n');
    expect(fragment.html).toContain(dataUrl('image/png', RED));
    expect(fragment.html).toContain('<span class="br-image-note">untracked · not part of a push yet</span>');
  });

  it('reads each changed file\'s new mode from its patch, and a file whose diff failed to load as unreadable', async () => {
    const repo = initRepo();
    writeBytes(repo, 'was-file.png', RED);
    commitAll(repo, 'image');
    writeBytes(repo, 'new.png', BLUE);
    fs.symlinkSync('new.png', path.join(repo, 'link.png'));
    fs.rmSync(path.join(repo, 'was-file.png'));
    fs.symlinkSync('new.png', path.join(repo, 'was-file.png'));
    git(repo, 'add', '-A');
    git(repo, 'update-index', '--add', '--cacheinfo', `160000,${blobId(repo, 'HEAD')},vendor/lib`);
    writeBytes(repo, 'draft.png', RED);
    git(repo, 'add', '-N', 'draft.png');
    const patchOf = (file: string) => git(repo, 'diff', 'main', '--', file);
    const files = [
      {path: 'new.png', status: 'added', rawDiff: patchOf('new.png')},
      {path: 'link.png', status: 'added', rawDiff: patchOf('link.png')},
      {path: 'was-file.png', status: 'modified', rawDiff: patchOf('was-file.png')},
      // Only the index holds it: the work tree has no checkout of it.
      {path: 'vendor/lib', status: 'added', rawDiff: git(repo, 'diff', '--cached', 'main', '--', 'vendor/lib')},
      // Its diff failed to load, as for a file nobody may read.
      {path: 'locked.png', status: 'modified', rawDiff: ''},
      {path: 'draft.png', status: 'untracked', rawDiff: patchOf('draft.png')},
    ] as ReviewFile[];
    expect(files[2]!.rawDiff.match(/^diff --git /gm)).toHaveLength(2);
    const sides = reviewAssetSides({files}, {diffArg: blobId(repo, 'main'), branch: 'HEAD', includeWorktree: true}, 0);
    const changes = 'worktree' in sides.after ? sides.after.worktree : [];
    expect(changes.map((change) => [change.path, change.mode, change.untracked ?? false])).toEqual([
      ['new.png', 'regular', false],
      ['link.png', 'symlink', false],
      ['was-file.png', 'symlink', false],
      ['vendor/lib', 'submodule', false],
      ['locked.png', 'unreadable', false],
      ['draft.png', 'regular', true],
    ]);
    expect(hashOf(repo, 'new.png').startsWith(changes[0]!.id!)).toBe(true);
    const resolver = createAssetResolver({cwd: repo});
    expect((await resolver.answer(sides, 'after', 'locked.png')).answer).toEqual({kind: 'refused', reason: 'unreadable', hint: "can't read the file"});
    expect((await resolver.answer(sides, 'after', 'was-file.png')).answer).toEqual({kind: 'refused', reason: 'symlink'});
  });
});

describe('the search for markdown that shows a changed image', () => {
  // `main` holds markdown that shows the hero, a text file that only names
  // it, and a page the review changed; `feature` changes the hero and adds
  // a page of its own that names it too.
  function heroRepo(extra: Record<string, string> = {}) {
    const repo = initRepo({
      'README.md': '# Project\n\n![Hero](docs/hero.png)\n',
      'docs/guide.md': 'The [hero](hero.png) again.\n',
      'notes.txt': '![Hero](docs/hero.png)\n',
      'CHANGES.md': '![Hero](docs/hero.png)\n',
      ...extra,
    });
    writeBytes(repo, 'docs/hero.png', RED);
    commitAll(repo, 'hero');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'docs/hero.png', BLUE);
    writeFiles(repo, {'docs/extra.md': '![Hero](hero.png)\n'});
    commitAll(repo, 'a new hero');
    return repo;
  }
  const pathsOf = (found: Array<{path: string}>) => found.map((each) => each.path).sort();

  it('finds the markdown files that name the image, never another kind of file or one the review lists', async () => {
    const repo = heroRepo();
    const resolver = createAssetResolver({cwd: repo});
    const found = await resolver.embedders(refSides(), ['hero.png'], new Set(['docs/hero.png', 'CHANGES.md']));
    expect(pathsOf(found)).toEqual(['README.md', 'docs/extra.md', 'docs/guide.md']);
    expect(found.find((each) => each.path === 'README.md')!.oid).toBe(blobId(repo, 'feature:README.md'));
  });

  it('searches the base tree in a work tree review, leaving out what the work tree deleted or moved away', async () => {
    const repo = heroRepo();
    const resolver = createAssetResolver({cwd: repo});
    // On disk, an unchanged file is as the base holds it: `docs/extra.md`
    // is only on the branch.
    const sides: AssetSides = {base: 'main', after: {worktree: [{path: 'docs/hero.png', id: null, mode: 'regular'}, {path: 'docs/guide.md', id: null, mode: null}]}, epoch: 0};
    const found = await resolver.embedders(sides, ['hero.png'], new Set(['docs/hero.png']));
    expect(pathsOf(found)).toEqual(['CHANGES.md', 'README.md']);
    expect(found.find((each) => each.path === 'README.md')!.oid).toBe(blobId(repo, 'main:README.md'));
  });

  it('leaves out a markdown name that is a symlink, even when the search names it', async () => {
    const repo = heroRepo();
    fs.symlinkSync('../README.md', path.join(repo, 'docs/link.md'));
    commitAll(repo, 'a link');
    // git grep skips a symlink's blob today; the search's answer names one
    // here, as another git could, and the tree says what it is.
    const naming: RunOperation = (operation, scope) => (scope?.signal ? Promise.resolve(['docs/link.md', 'README.md'] as never) : runOperationAsync(operation));
    const found = await createAssetResolver({cwd: repo, run: naming}).embedders(refSides(), ['hero.png'], new Set(['docs/hero.png']));
    expect(pathsOf(found)).toEqual(['README.md']);
  });

  it('finds at most 40', async () => {
    const many = Object.fromEntries(Array.from({length: 45}, (_, index) => [`docs/page-${String(index).padStart(2, '0')}.md`, '![Hero](hero.png)\n']));
    const repo = heroRepo(many);
    const found = await createAssetResolver({cwd: repo}).embedders(refSides(), ['hero.png'], new Set());
    expect(found).toHaveLength(40);
  });

  it('finds nothing when the search runs past 2 seconds, or fails', async () => {
    const repo = heroRepo();
    // The search is the one git call with a signal: here it hangs until stopped.
    const hanging: RunOperation = (operation, scope) => (scope?.signal
      ? new Promise((_, reject) => scope.signal!.addEventListener('abort', () => reject(new Error('stopped'))))
      : runOperationAsync(operation));
    const started = Date.now();
    expect(await createAssetResolver({cwd: repo, run: hanging}).embedders(refSides(), ['hero.png'], new Set())).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    const failing: RunOperation = (operation, scope) => (scope?.signal ? Promise.reject(new Error('git failed')) : runOperationAsync(operation));
    expect(await createAssetResolver({cwd: repo, run: failing}).embedders(refSides(), ['hero.png'], new Set())).toEqual([]);
  }, 10_000);

  it('answers the worker\'s embedders job from the search', async () => {
    const repo = heroRepo();
    const result = await createRenderedHandler().handle({type: 'embedders', cwd: repo, assets: refSides(), names: ['hero.png'], skip: ['docs/hero.png', 'docs/extra.md', 'CHANGES.md']}) as EmbeddersResult;
    expect(result).toEqual({ok: true, files: [{path: 'README.md', oid: blobId(repo, 'feature:README.md')}, {path: 'docs/guide.md', oid: blobId(repo, 'feature:docs/guide.md')}]});
  });
});

describe('fragments in the rendered worker', () => {
  function readmeRepo() {
    const repo = initRepo({'README.md': '# Project\n\nIntro.\n'});
    writeBytes(repo, 'logo.png', RED);
    commitAll(repo, 'logo');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeFiles(repo, {'README.md': '# Project\n\nIntro, edited.\n\n![Logo](logo.png)\n\n![Escape](../../outside.png)\n'});
    commitAll(repo, 'readme');
    return repo;
  }

  function request(repo: string): FragmentRequest {
    return {
      cwd: repo,
      key: 'readme-key',
      path: 'README.md',
      status: 'modified',
      source: {kind: 'blob', id: blobId(repo, 'feature:README.md')},
      groups: [{id: 'g0', kind: 'modified', after: [3, 7], base: [3, 3], anchorLine: 3, removedLines: ['Intro.']}],
      links: {},
      assets: {base: 'main...feature', after: {tree: 'feature'}, epoch: 0},
    };
  }

  const title = {repo: 'repo', base: 'main', branch: 'feature', worktree: false, renderedAt: 0};

  it('renders a page with its images inlined and a card for a path that climbs out of the repo', async () => {
    const repo = readmeRepo();
    const handler = createRenderedHandler();
    const page = await handler.handle({type: 'page', key: 'p', title, file: {path: 'README.md', status: 'modified'}, rail: [], content: {fragment: request(repo)}}) as PageResult;
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.html).toContain(dataUrl('image/png', RED));
    expect(page.html).toContain("won't render on GitHub: outside the repo");
    // The edited paragraph and the two new image paragraphs.
    expect(page.summary).toMatchObject({kind: 'rendered', changes: {changed: 3, removed: 0}});
  });

  it('renders again when only an image the page embeds changed, and not otherwise', async () => {
    const repo = readmeRepo();
    let renders = 0;
    const handler = createRenderedHandler({render: (input) => {
      renders += 1;
      return renderMarkdown(input);
    }});
    const pageOf = async (epoch: number) => {
      const fragment = {...request(repo), assets: {...request(repo).assets, epoch}};
      return await handler.handle({type: 'page', key: `p${epoch}`, title, file: {path: 'README.md', status: 'modified'}, rail: [], content: {fragment}}) as PageResult;
    };

    expect(await handler.handle({type: 'fragment', ...request(repo)}) as FragmentResult).toMatchObject({ok: true});
    expect(renders).toBe(1);
    // The same key and the same images: the page comes from the fragment held.
    expect(await pageOf(0)).toMatchObject({ok: true});
    expect(renders).toBe(1);

    // Only the image moves on the branch: README.md's diff, and so its key, stay the same.
    writeBytes(repo, 'logo.png', BLUE);
    commitAll(repo, 'new logo');
    const page = await pageOf(1);
    expect(renders).toBe(2);
    expect(page.ok && page.html).toContain(dataUrl('image/png', BLUE));
    expect(page.ok && page.html).not.toContain(dataUrl('image/png', RED));
  });

  it('holds fragments within 32 MB, dropping the least recently used', async () => {
    const repo = readmeRepo();
    const rendered: string[] = [];
    // Each fragment weighs 12 MB: its HTML, two bytes a character.
    const handler = createRenderedHandler({render: async (input) => {
      rendered.push(input.path);
      return {...(await renderMarkdown({...input, source: 'x'})), html: 'x'.repeat(6 * 1024 * 1024)};
    }});
    const ask = (key: string) => handler.handle({type: 'fragment', ...request(repo), key, path: key});
    for (const key of ['a.md', 'b.md', 'c.md']) await ask(key);
    expect(rendered).toEqual(['a.md', 'b.md', 'c.md']);
    await ask('c.md');
    await ask('b.md');
    expect(rendered).toHaveLength(3);
    // The first one went to make room for the third.
    await ask('a.md');
    expect(rendered).toEqual(['a.md', 'b.md', 'c.md', 'a.md']);
  });

  it('renders again a file that failed because it was mid-write, once it reads as its diff', async () => {
    const repo = readmeRepo();
    const text = '# Project\n\nIntro, edited.\n';
    writeBytes(repo, 'README.md', text);
    const id = git(repo, 'hash-object', 'README.md').trim();
    writeBytes(repo, 'README.md', '# Proj');
    const handler = createRenderedHandler({sleep: async () => undefined});
    const ask = () => handler.handle({type: 'fragment', ...request(repo), key: 'mid-write', source: {kind: 'worktree', path: 'README.md', id}});
    expect(await ask()).toMatchObject({ok: true, summary: {kind: 'failed'}});
    writeBytes(repo, 'README.md', text);
    expect(await ask()).toMatchObject({ok: true, summary: {kind: 'rendered'}});
  });

  it('marks a block whose image changed on the branch though its text did not, with the old image as its before view', async () => {
    const before = '# Project\n\nIntro.\n\n![Logo](logo.png)\n\n![Kept](kept.png)\n';
    const after = '# Project\n\nIntro, edited.\n\n![Logo](logo.png)\n\n![Kept](kept.png)\n';
    const repo = initRepo({'README.md': before});
    writeBytes(repo, 'logo.png', RED);
    writeBytes(repo, 'kept.png', RED);
    commitAll(repo, 'logo');
    git(repo, 'checkout', '-q', '-b', 'feature');
    writeBytes(repo, 'logo.png', BLUE);
    writeFiles(repo, {'README.md': after});
    commitAll(repo, 'new logo');

    const fragment = await renderPage(createAssetResolver({cwd: repo}), refSides(), after, changeGroups(diffFile(before, after, 'README.md')));
    expect(fragment.changes).toEqual({changed: 2, removed: 0});
    expect(fragment.blocks.filter((block) => block.mark).map((block) => [block.lines, block.mark])).toEqual([[[3, 3], 'modified'], [[5, 5], 'modified']]);
    expect(fragment.html).toMatch(/<p data-block="[^"]+" data-lines="5-5" data-mark="modified"><img src="data:image\/png;base64,/);
    expect(fragment.html).toMatch(/<p data-block="[^"]+" data-lines="7-7"><img/);
    expect(beforeViews(fragment.html)[1]).toContain(dataUrl('image/png', RED));
  });

  it('marks only the edited block of a doc moved with its images, and shows the base images in its before views', async () => {
    const before = '# Guide\n\nIntro. ![Dot](dot.png)\n\n![Logo](logo.png)\n';
    const after = '# Guide\n\nIntro, edited. ![Dot](dot.png)\n\n![Logo](logo.png)\n';
    const repo = initRepo({'docs/guide.md': before});
    writeBytes(repo, 'docs/logo.png', RED);
    writeBytes(repo, 'docs/dot.png', BLUE);
    commitAll(repo, 'guide');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'mv', 'docs', 'guide');
    writeFiles(repo, {'guide/guide.md': after});
    commitAll(repo, 'move the guide');

    const moved: FragmentRequest = {
      cwd: repo,
      key: 'moved',
      path: 'guide/guide.md',
      oldPath: 'docs/guide.md',
      status: 'renamed',
      source: {kind: 'blob', id: blobId(repo, 'feature:guide/guide.md')},
      groups: changeGroups(diffFile(before, after, 'guide/guide.md')),
      links: {},
      assets: refSides(),
    };
    const page = await createRenderedHandler().handle({type: 'page', key: 'p', title, file: {path: 'guide/guide.md', status: 'renamed', oldPath: 'docs/guide.md'}, rail: [], content: {fragment: moved}}) as PageResult;
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.summary.blocks.filter((block) => block.mark).map((block) => [block.lines, block.mark])).toEqual([[[3, 3], 'modified']]);
    expect(page.summary.changes).toEqual({changed: 1, removed: 0});
    // The before view shows the base's image, found from the doc's old folder.
    expect(beforeViews(page.html)).toHaveLength(1);
    expect(beforeViews(page.html)[0]).toContain(dataUrl('image/png', BLUE));
    expect(page.html).not.toContain('file not found');
  });

  it('shows a deleted doc with the images the branch deleted with it, as the base holds them', async () => {
    const text = '# Old\n\n![Logo](logo.png)\n';
    const repo = initRepo({'docs/old.md': text});
    writeBytes(repo, 'docs/logo.png', RED);
    commitAll(repo, 'old doc');
    git(repo, 'checkout', '-q', '-b', 'feature');
    git(repo, 'rm', '-q', '-r', 'docs');
    commitAll(repo, 'drop the old docs');

    const deleted: FragmentRequest = {
      cwd: repo,
      key: 'deleted',
      path: 'docs/old.md',
      status: 'deleted',
      source: {kind: 'blob', id: blobId(repo, 'main:docs/old.md')},
      groups: changeGroups(diffFile(text, null, 'docs/old.md')),
      links: {},
      assets: refSides(),
    };
    const page = await createRenderedHandler().handle({type: 'page', key: 'p', title, file: {path: 'docs/old.md', status: 'deleted'}, rail: [], content: {fragment: deleted}}) as PageResult;
    expect(page.ok && page.html).toContain(dataUrl('image/png', RED));
    expect(page.ok && page.html).not.toContain('file not found');
  });

  it('renders again a fragment that showed an image it couldn\'t read, once the image reads', async () => {
    const repo = initRepo({'README.md': '# Project\n\n![Locked](locked.png)\n'});
    writeBytes(repo, 'locked.png', BLUE);
    const id = git(repo, 'hash-object', 'locked.png').trim();
    const sides: AssetSides = {base: blobId(repo, 'main'), after: {worktree: [{path: 'locked.png', id, mode: 'regular'}]}, epoch: 0};
    const handler = createRenderedHandler();
    // The same request both times: only the image's readability moves.
    const pageOf = async () => await handler.handle({
      type: 'page', key: 'p', title, file: {path: 'README.md', status: 'modified'}, rail: [],
      content: {fragment: {cwd: repo, key: 'locked', path: 'README.md', status: 'modified', source: {kind: 'blob', id: blobId(repo, 'HEAD:README.md')}, groups: [], links: {}, assets: sides}},
    }) as PageResult;

    fs.chmodSync(path.join(repo, 'locked.png'), 0o000);
    let first: PageResult;
    try {
      first = await pageOf();
    } finally {
      fs.chmodSync(path.join(repo, 'locked.png'), 0o600);
    }
    expect(first.ok && first.html).toContain("can't read the file");
    const page = await pageOf();
    expect(page.ok && page.html).toContain(dataUrl('image/png', BLUE));
    expect(page.ok && page.html).not.toContain("can't read the file");
  });

  it('names the same images the same way, whatever order their lookups finish in', async () => {
    const names = Array.from({length: 10}, (_, index) => `img/${index}.png`);
    const source = names.map((name) => `![${name}](${name})`).join('\n\n');
    // Each run answers the images in another order, as git's reads finish.
    const signatureWith = async (delayOf: (index: number) => number) => {
      const resolver = {
        answer: async (_sides: AssetSides, _side: string, repoPath: string) => {
          await new Promise((resolve) => setTimeout(resolve, delayOf(names.indexOf(repoPath))));
          return {answer: {kind: 'refused', reason: 'missing'}, identity: `no:missing:${repoPath}`};
        },
        identity: async () => 'never',
        compare: async () => ({changed: false, base: 'b', after: 'a'}),
      } as unknown as AssetResolver;
      const uses: AssetUse[] = [];
      const fragment = await renderMarkdown({path: 'README.md', source, groups: [], ...pageLookups(resolver, refSides(), false, uses), link: () => ({kind: 'outside'})});
      return summarize({kind: 'rendered', fragment}, uses).assets;
    };
    const forward = await signatureWith((index) => index * 3);
    const backward = await signatureWith((index) => (9 - index) * 3);
    expect(forward).not.toBe('');
    expect(backward).toBe(forward);
  });

  it('says when an image lookup ran out of time, so the render is worth asking for again', async () => {
    const slow = {
      answer: () => new Promise(() => {}),
      identity: async () => 'never',
      compare: () => new Promise(() => {}),
    } as unknown as AssetResolver;
    const uses: AssetUse[] = [];
    const before = 'Intro.\n\n![Logo](logo.png)\n';
    const after = 'Intro, edited.\n\n![Logo](logo.png)\n';
    const fragment = await renderMarkdown({path: 'README.md', source: after, groups: changeGroups(diffFile(before, after)), ...pageLookups(slow, refSides(), false, uses, {budgetMs: 10}), link: () => ({kind: 'outside'})});
    expect(uses.map((use) => use.identity)).toContain(LATE_IDENTITY);
    expect(summarize({kind: 'rendered', fragment}, uses)).toMatchObject({late: true});
    expect(summarize({kind: 'rendered', fragment}, [{side: 'after', path: 'logo.png', identity: 'blob:abc1234'}])).not.toHaveProperty('late');
  });

  it('says when a page rendered its fragment again rather than use the one held', async () => {
    const repo = readmeRepo();
    const handler = createRenderedHandler();
    const pageOf = async (epoch: number) => await handler.handle({type: 'page', key: `p${epoch}`, title, file: {path: 'README.md', status: 'modified'}, rail: [], content: {fragment: {...request(repo), assets: {...request(repo).assets, epoch}}}}) as PageResult;
    expect(await handler.handle({type: 'fragment', ...request(repo)}) as FragmentResult).toMatchObject({ok: true});
    expect(await pageOf(0)).not.toHaveProperty('rerendered');
    writeBytes(repo, 'logo.png', BLUE);
    commitAll(repo, 'new logo');
    expect(await pageOf(1)).toMatchObject({ok: true, rerendered: true});
  });

  it('answers a file that will not render with a page saying why, not a failed job', async () => {
    const repo = readmeRepo();
    const handler = createRenderedHandler({render: async () => {
      throw new Error('the parser gave up');
    }});
    const result = await handler.handle({type: 'fragment', ...request(repo)}) as FragmentResult;
    expect(result).toMatchObject({ok: true, summary: {kind: 'failed', reason: 'the parser gave up'}});
  });
});

describe('the page budget for inlined images', () => {
  const embedded = (dataUrlText: string) => async (): Promise<AssetAnswer> => ({kind: 'embed', mime: 'image/png', dataUrl: dataUrlText, oid: 'abc1234'});

  it('counts the images of a before view against the page budget', async () => {
    const big = `data:image/png;base64,${'A'.repeat(Math.floor(PAGE_INLINE_LIMIT / 3) - 100)}`;
    const before = '![a](a.png) old words\n\n![b](b.png)\n\n![c](c.png)\n';
    const after = '![a](a.png) new words\n\n![b](b.png)\n\n![c](c.png)\n';
    const fragment = await renderMarkdown({path: 'doc.md', source: after, groups: changeGroups(diffFile(before, after)), asset: embedded(big), baseAsset: embedded(big), link: () => ({kind: 'outside'})});
    expect(fragment.changes).toEqual({changed: 1, removed: 0});
    // The page's own three images fit; the before view's is past the limit.
    expect(fragment.html.split(big)).toHaveLength(4);
    expect(beforeViews(fragment.html)).toEqual([expect.stringContaining('image not inlined · page limit')]);
  });

  it('marks nothing where only trailing spaces changed, however large the images those blocks show', async () => {
    const big = `data:image/png;base64,${'A'.repeat(10 * 1024 * 1024)}`;
    const before = '![a](a.png)\n\n![b](b.png)\n';
    const after = '![a](a.png)  \n\n![b](b.png)  \n';
    const fragment = await renderMarkdown({path: 'doc.md', source: after, groups: changeGroups(diffFile(before, after)), asset: embedded(big), baseAsset: embedded(big), link: () => ({kind: 'outside'})});
    expect(fragment.changes).toEqual({changed: 0, removed: 0});
    expect(fragment.html.split(big)).toHaveLength(3);
    expect(fragment.html).not.toContain('page limit');
  });

  it('shows a card for an image past 32 MB of inlined bytes on one page, before views included', async () => {
    const big = `data:image/png;base64,${'A'.repeat(Math.floor(PAGE_INLINE_LIMIT / 3) - 100)}`;
    const asset = async (): Promise<AssetAnswer> => ({kind: 'embed', mime: 'image/png', dataUrl: big, oid: 'abc1234'});
    const source = ['![a](a.png)', '', '![b](b.png)', '', '![c](c.png) changed', '', '![d](d.png)', ''].join('\n');
    const fragment = await renderMarkdown({path: 'doc.md', source, groups: [], asset, link: () => ({kind: 'outside'})});
    expect(fragment.html.split(big)).toHaveLength(4);
    expect(fragment.html).toContain('image not inlined · page limit');
  });
});
