import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {createMediaTempDir, sweepStaleMediaDirs} from '../src/media/tempDir.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';

// The session's media temp dir: made on first use, private, removed at exit,
// and swept at the next start when a session died without removing it.

afterEach(cleanupTempDirs);

describe('media temp dir', () => {
  it('is made only when first asked for, private, with its owner pid and the worker dir', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    const tempDir = createMediaTempDir({env, pid: 4242});
    expect(fs.readdirSync(parent)).toEqual([]);

    const dir = tempDir.get();
    expect(tempDir.get()).toBe(dir);
    expect(path.dirname(dir)).toBe(parent);
    expect(path.basename(dir)).toMatch(/^branch-review-media-/);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readFileSync(path.join(dir, 'owner.pid'), 'utf8')).toBe('4242\n');
    expect(fs.statSync(path.join(dir, 'worker')).isDirectory()).toBe(true);

    tempDir.remove();
    expect(fs.existsSync(dir)).toBe(false);
    tempDir.remove();
  });

  it('removing a dir never made does nothing', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    createMediaTempDir({env: {BRANCH_REVIEW_TMPDIR: parent}}).remove();
    expect(fs.readdirSync(parent)).toEqual([]);
  });

  it('sweeps dirs whose owner process is gone and keeps live ones and anything else', () => {
    const parent = makeTempDir('branch-review-tmp-parent-');
    const env = {BRANCH_REVIEW_TMPDIR: parent};
    const dead = createMediaTempDir({env, pid: 999_001}).get();
    const alive = createMediaTempDir({env, pid: 999_002}).get();
    const mine = createMediaTempDir({env}).get();
    const unrelated = path.join(parent, 'branch-review-refresh-x');
    fs.mkdirSync(unrelated);
    const noOwner = path.join(parent, 'branch-review-media-noowner');
    fs.mkdirSync(noOwner);
    const target = makeTempDir('branch-review-link-target-');
    fs.writeFileSync(path.join(target, 'owner.pid'), '999001\n');
    const link = path.join(parent, 'branch-review-media-link');
    fs.symlinkSync(target, link);

    sweepStaleMediaDirs({env, isGone: (pid) => pid === 999_001});

    expect(fs.existsSync(dead)).toBe(false);
    for (const kept of [alive, mine, unrelated, noOwner, link, target]) expect(fs.existsSync(kept), kept).toBe(true);
  });
});
