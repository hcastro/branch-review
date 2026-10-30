import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createSideReader} from '../src/media/worker/read.js';
import type {SideRef} from '../src/media/types.js';
import {cleanupTempDirs, commitAll, git, gitSpy, initRepo, makeTempDir, snapshotTree, withEnvAsync} from './core-helpers.js';
import {pngFixture} from './media-helpers.js';

// Reading one side of a media file: a blob by the id in the diff's `index`
// line, or the work tree file, always hashed and checked against that id.

afterEach(cleanupTempDirs);

function side(source: SideRef['source'], filePath: string, abbrevId: string, which: SideRef['side'] = 'after'): SideRef {
  return {side: which, source, path: filePath, abbrevId, key: `${source}|${filePath}|${abbrevId}`};
}

const shortId = (cwd: string, spec: string) => git(cwd, 'rev-parse', '--short', spec).trim();
const hashObject = (cwd: string, file: string) => git(cwd, 'hash-object', file).trim();

function writeBytes(cwd: string, file: string, bytes: Uint8Array) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), {recursive: true});
  fs.writeFileSync(path.join(cwd, file), bytes);
}

describe('media side reads', () => {
  it('reads a blob side by its abbreviated id and verifies it', async () => {
    const cwd = initRepo();
    const png = pngFixture(4, 3);
    writeBytes(cwd, 'img/logo.png', png);
    commitAll(cwd, 'add logo');

    const id = shortId(cwd, 'HEAD:img/logo.png');
    const result = await createSideReader().read(cwd, side('blob', 'img/logo.png', id), 'raster');
    expect(result).toMatchObject({ok: true});
    if (!result.ok) return;
    expect(Buffer.compare(result.bytes, png)).toBe(0);
    expect(result.oid).toBe(git(cwd, 'rev-parse', 'HEAD:img/logo.png').trim());
    expect(result.oid.startsWith(id)).toBe(true);
  });

  it('reads a work tree side and verifies it', async () => {
    const cwd = initRepo();
    const png = pngFixture(5, 5, [0, 0, 255, 255]);
    writeBytes(cwd, 'shot.png', png);

    const id = hashObject(cwd, 'shot.png').slice(0, 9);
    const result = await createSideReader().read(cwd, side('worktree', 'shot.png', id), 'raster');
    expect(result).toMatchObject({ok: true});
    if (result.ok) expect(Buffer.compare(result.bytes, png)).toBe(0);
  });

  it('fails a blob id that names no object with git\'s reason', async () => {
    const cwd = initRepo();
    const result = await createSideReader().read(cwd, side('blob', 'gone.png', 'abcdef1'), 'raster');
    expect(result).toMatchObject({ok: false, state: 'error'});
    if (!result.ok) expect(result.reason).toMatch(/abcdef1/);
  });

  it('calls a work tree file that is still changing stale', async () => {
    const cwd = initRepo();
    const first = pngFixture(4, 4, [1, 2, 3, 255]);
    writeBytes(cwd, 'live.png', first);
    const id = hashObject(cwd, 'live.png').slice(0, 7);
    // Rewritten after the review was built, and again while the reader waits.
    writeBytes(cwd, 'live.png', pngFixture(4, 4, [9, 9, 9, 255]));
    const waits: number[] = [];
    const reader = createSideReader({
      sleep: async (ms) => {
        waits.push(ms);
        writeBytes(cwd, 'live.png', pngFixture(4, 4, [7, 7, 7, 255]));
      },
    });

    const result = await reader.read(cwd, side('worktree', 'live.png', id), 'raster');
    expect(result).toEqual({ok: false, state: 'stale', reason: 'changed on disk · refreshing', disk: true});
    expect(waits).toEqual([500]);
  });

  it('accepts a work tree file that settles back on the id during the wait', async () => {
    const cwd = initRepo();
    const good = pngFixture(4, 4, [1, 2, 3, 255]);
    writeBytes(cwd, 'live.png', good);
    const id = hashObject(cwd, 'live.png').slice(0, 7);
    writeBytes(cwd, 'live.png', pngFixture(4, 4, [9, 9, 9, 255]));
    const reader = createSideReader({sleep: async () => writeBytes(cwd, 'live.png', good)});

    const result = await reader.read(cwd, side('worktree', 'live.png', id), 'raster');
    expect(result).toMatchObject({ok: true});
  });

  it('names a git filter when the work tree bytes never match the id', async () => {
    const cwd = initRepo({'.gitattributes': '*.svg text eol=crlf\n'});
    writeBytes(cwd, 'icon.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">\n<rect/>\n</svg>\n'));
    commitAll(cwd, 'add icon');
    // A checkout writes CRLF; git hashes the LF content it would store.
    fs.rmSync(path.join(cwd, 'icon.svg'));
    git(cwd, 'checkout', '--', 'icon.svg');
    expect(fs.readFileSync(path.join(cwd, 'icon.svg'), 'utf8')).toContain('\r\n');
    const id = hashObject(cwd, 'icon.svg').slice(0, 7);

    const result = await createSideReader({sleep: async () => undefined}).read(cwd, side('worktree', 'icon.svg', id), 'svg');
    expect(result).toEqual({ok: false, state: 'error', reason: 'preview unavailable: a git filter changes this file (shown as text)'});
  });

  it('refuses a symlink in the work tree', async () => {
    const cwd = initRepo();
    const outside = makeTempDir('branch-review-outside-');
    writeBytes(outside, 'secret.png', pngFixture(2, 2));
    fs.symlinkSync(path.join(outside, 'secret.png'), path.join(cwd, 'link.png'));

    const result = await createSideReader().read(cwd, side('worktree', 'link.png', 'abcdef1'), 'raster');
    expect(result).toEqual({ok: false, state: 'error', reason: 'symlink, not previewed', disk: true});
  });

  it('refuses a file under a symlinked directory that leaves the repo', async () => {
    const cwd = initRepo();
    const outside = makeTempDir('branch-review-outside-');
    writeBytes(outside, 'secret.png', pngFixture(2, 2));
    fs.symlinkSync(outside, path.join(cwd, 'linked'));

    const result = await createSideReader().read(cwd, side('worktree', 'linked/secret.png', 'abcdef1'), 'raster');
    expect(result).toEqual({ok: false, state: 'error', reason: 'linked/secret.png is outside the repository', disk: true});
  });

  it('says a work tree file that went away no longer exists', async () => {
    const cwd = initRepo();
    const result = await createSideReader().read(cwd, side('worktree', 'gone.png', 'abcdef1'), 'raster');
    expect(result).toEqual({ok: false, state: 'error', reason: 'gone.png no longer exists', disk: true});
  });

  it('caps a raster at 16 MB on both sides', async () => {
    const cwd = initRepo();
    const big = Buffer.alloc(16 * 1024 * 1024 + 1, 7);
    writeBytes(cwd, 'huge.png', big);
    commitAll(cwd, 'add huge');
    const reader = createSideReader();

    const blob = await reader.read(cwd, side('blob', 'huge.png', shortId(cwd, 'HEAD:huge.png')), 'raster');
    expect(blob).toEqual({ok: false, state: 'error', reason: 'huge.png is larger than 16 MB'});
    const worktree = await reader.read(cwd, side('worktree', 'huge.png', hashObject(cwd, 'huge.png').slice(0, 7)), 'raster');
    expect(worktree).toEqual({ok: false, state: 'error', reason: 'huge.png is larger than 16 MB'});
  });

  it('runs only cat-file and rev-parse, and leaves .git and the work tree byte-identical', async () => {
    const cwd = initRepo();
    writeBytes(cwd, 'a.png', pngFixture(3, 3));
    commitAll(cwd, 'add a');
    writeBytes(cwd, 'a.png', pngFixture(3, 3, [0, 255, 0, 255]));
    writeBytes(cwd, 'b.png', pngFixture(6, 2));
    const sides = [
      side('blob', 'a.png', shortId(cwd, 'HEAD:a.png'), 'before'),
      side('worktree', 'a.png', hashObject(cwd, 'a.png').slice(0, 7)),
      side('worktree', 'b.png', hashObject(cwd, 'b.png').slice(0, 7)),
    ];
    const before = snapshotTree(cwd);
    const spy = gitSpy();

    await withEnvAsync({PATH: spy.pathValue}, async () => {
      const reader = createSideReader();
      const results = await Promise.all(sides.map((entry) => reader.read(cwd, entry, 'raster')));
      expect(results.every((result) => result.ok)).toBe(true);
    });

    const subcommands = spy.calls().map((call) => call.args.split(' ').find((arg, index, all) => !arg.startsWith('-') && all[index - 1] !== '-c'));
    expect(subcommands.length).toBeGreaterThan(0);
    expect(new Set(subcommands)).toEqual(new Set(['cat-file', 'rev-parse']));
    expect(spy.calls().every((call) => call.optionalLocks === '0' && call.terminalPrompt === '0')).toBe(true);
    expect(snapshotTree(cwd)).toEqual(before);
  });

  it('verifies against sha256 ids in a sha256 repo', async () => {
    const cwd = makeTempDir('branch-review-sha256-');
    git(cwd, 'init', '-q', '--object-format=sha256', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Test User');
    git(cwd, 'config', 'user.email', 'test@example.com');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    const png = pngFixture(2, 7);
    writeBytes(cwd, 'deep.png', png);
    commitAll(cwd, 'add deep');
    const full = git(cwd, 'rev-parse', 'HEAD:deep.png').trim();
    expect(full).toHaveLength(64);

    const reader = createSideReader();
    const blob = await reader.read(cwd, side('blob', 'deep.png', full.slice(0, 12)), 'raster');
    expect(blob).toMatchObject({ok: true, oid: full});
    const worktree = await reader.read(cwd, side('worktree', 'deep.png', full.slice(0, 12)), 'raster');
    expect(worktree).toMatchObject({ok: true, oid: full});
  });

  it('reads the blob when its abbreviated id is shared with a tree', async () => {
    const cwd = initRepo();
    // Find a blob and a tree whose ids share their first 7 hex digits, by
    // hashing candidates here, then store just those two objects.
    const objectId = (type: string, body: Buffer) => createHash('sha1').update(`${type} ${body.length}\0`).update(body).digest('hex');
    const emptyBlob = Buffer.from('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'hex');
    const trees = new Map<string, Buffer>();
    for (let index = 0; index < 20_000; index += 1) {
      const body = Buffer.concat([Buffer.from(`100644 f${index}\0`), emptyBlob]);
      trees.set(objectId('tree', body).slice(0, 7), body);
    }
    let blob: Buffer | undefined;
    let prefix = '';
    for (let index = 0; !blob; index += 1) {
      const body = Buffer.from(`blob ${index}\n`);
      const id = objectId('blob', body).slice(0, 7);
      if (trees.has(id)) {
        blob = body;
        prefix = id;
      }
    }
    const store = (type: string, body: Buffer) => execFileSync('git', ['hash-object', '-w', '-t', type, '--stdin'], {cwd, input: body, encoding: 'utf8'}).trim();
    expect(store('blob', blob).startsWith(prefix)).toBe(true);
    expect(store('tree', trees.get(prefix)!).startsWith(prefix)).toBe(true);
    // Plain git cannot tell which one the prefix means.
    expect(() => git(cwd, 'cat-file', 'blob', prefix)).toThrow(/ambiguous/);

    const result = await createSideReader().read(cwd, side('blob', 'icon.png', prefix), 'raster');
    expect(result).toMatchObject({ok: true});
    if (result.ok) expect(Buffer.compare(result.bytes, blob)).toBe(0);
  });

  it('keeps verified bytes so a second read of the same side runs no git', async () => {
    const cwd = initRepo();
    writeBytes(cwd, 'a.png', pngFixture(3, 3));
    commitAll(cwd, 'add a');
    const id = shortId(cwd, 'HEAD:a.png');
    const reader = createSideReader();
    await reader.read(cwd, side('blob', 'a.png', id), 'raster');

    const spy = gitSpy();
    await withEnvAsync({PATH: spy.pathValue}, () => reader.read(cwd, side('blob', 'a.png', id), 'raster'));
    expect(spy.calls()).toEqual([]);
  });
});
