import fs from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {findChrome} from '../src/rendered/worker/chrome.js';
import {cleanupTempDirs, makeTempDir, writeExecutable} from './core-helpers.js';

// Finding a headless Chromium on disk for the in-pane view, never
// installing one: the env var first, then the newest Playwright and
// Puppeteer headless shells, then Chrome itself. A binary inside the repo
// under review is never used, whatever names it.

afterEach(() => cleanupTempDirs());

const SCRIPT = '#!/bin/sh\nexit 0\n';

function setup() {
  const home = makeTempDir('branch-review-chrome-home-');
  const repo = makeTempDir('branch-review-chrome-repo-');
  return {home, repo};
}

function shell(dir: string) {
  fs.mkdirSync(dir, {recursive: true});
  return writeExecutable(path.join(dir, 'chrome-headless-shell'), SCRIPT);
}

const none = () => null;

describe('findChrome', () => {
  it('takes BRANCH_REVIEW_CHROME when it names an executable file outside the repo', () => {
    const {home, repo} = setup();
    const binary = shell(makeTempDir('branch-review-chrome-bin-'));
    expect(findChrome({env: {BRANCH_REVIEW_CHROME: binary}, home, platform: 'darwin', findTool: none, repoRoot: repo})).toEqual({path: fs.realpathSync(binary), headless: '--headless'});
  });

  it('never takes a binary inside the repo, a relative path or something that is not a program', () => {
    const {home, repo} = setup();
    const planted = shell(path.join(repo, 'tools'));
    // A symlink outside the repo that leads into it counts as inside.
    const outside = makeTempDir('branch-review-chrome-link-');
    fs.symlinkSync(planted, path.join(outside, 'chrome'));
    const notExecutable = path.join(outside, 'plain');
    fs.writeFileSync(notExecutable, SCRIPT, {mode: 0o644});
    for (const value of [planted, path.join(outside, 'chrome'), 'chrome-headless-shell', notExecutable, outside]) {
      expect(findChrome({env: {BRANCH_REVIEW_CHROME: value}, home, platform: 'linux', findTool: none, repoRoot: repo}), value).toBeNull();
    }
  });

  it('never takes a relative path, even one that leads from the working folder to a program', () => {
    const {home, repo} = setup();
    const binary = shell(makeTempDir('branch-review-chrome-relative-'));
    const relative = path.relative(process.cwd(), binary);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(fs.statSync(path.resolve(relative)).isFile()).toBe(true);
    expect(findChrome({env: {BRANCH_REVIEW_CHROME: relative}, home, platform: 'linux', findTool: none, repoRoot: repo})).toBeNull();
  });

  it('answers null when BRANCH_REVIEW_CHROME names nothing it can use, rather than searching the disk', () => {
    const {home, repo} = setup();
    shell(path.join(home, 'Library', 'Caches', 'ms-playwright', 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64'));
    expect(findChrome({env: {}, home, platform: 'darwin', findTool: none, repoRoot: repo})).not.toBeNull();
    expect(findChrome({env: {BRANCH_REVIEW_CHROME: path.join(home, 'missing')}, home, platform: 'darwin', findTool: none, repoRoot: repo})).toBeNull();
  });

  it('runs Chrome.app on macOS in its new headless mode when no headless shell is installed', () => {
    const {home, repo} = setup();
    const chrome = writeExecutable(path.join(makeTempDir('branch-review-chrome-app-'), 'Google Chrome'), SCRIPT);
    expect(findChrome({env: {}, home, platform: 'darwin', findTool: none, repoRoot: repo, macChrome: chrome})).toEqual({path: fs.realpathSync(chrome), headless: '--headless=new'});
    const shellPath = shell(path.join(home, 'Library', 'Caches', 'ms-playwright', 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64'));
    expect(findChrome({env: {}, home, platform: 'darwin', findTool: none, repoRoot: repo, macChrome: chrome})).toEqual({path: fs.realpathSync(shellPath), headless: '--headless'});
  });

  it('takes the newest Playwright headless shell by its version number, not its date', () => {
    const {home, repo} = setup();
    const cache = path.join(home, 'Library', 'Caches', 'ms-playwright');
    const older = shell(path.join(cache, 'chromium_headless_shell-1223', 'chrome-headless-shell-mac-arm64'));
    const newest = shell(path.join(cache, 'chromium_headless_shell-1234', 'chrome-headless-shell-mac-arm64'));
    shell(path.join(cache, 'chromium_headless_shell-999', 'chrome-headless-shell-mac-arm64'));
    // An install without its binary is passed over.
    fs.mkdirSync(path.join(cache, 'chromium_headless_shell-1300', 'chrome-headless-shell-mac-arm64'), {recursive: true});
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.dirname(path.dirname(older)), later, later);
    expect(findChrome({env: {}, home, platform: 'darwin', findTool: none, repoRoot: repo})?.path).toBe(fs.realpathSync(newest));
  });

  it('looks in ~/.cache/ms-playwright on Linux, then Puppeteer, then the PATH', () => {
    const {home, repo} = setup();
    const puppeteer = shell(path.join(home, '.cache', 'puppeteer', 'chrome-headless-shell', 'linux-131.0.6778.204', 'chrome-headless-shell-linux64'));
    const puppeteerNewer = shell(path.join(home, '.cache', 'puppeteer', 'chrome-headless-shell', 'linux-154.0.8037.57', 'chrome-headless-shell-linux64'));
    expect(findChrome({env: {}, home, platform: 'linux', findTool: none, repoRoot: repo})?.path).toBe(fs.realpathSync(puppeteerNewer));
    const playwright = shell(path.join(home, '.cache', 'ms-playwright', 'chromium_headless_shell-1234', 'chrome-headless-shell-linux64'));
    expect(findChrome({env: {}, home, platform: 'linux', findTool: none, repoRoot: repo})?.path).toBe(fs.realpathSync(playwright));
    expect(puppeteer).toBeTruthy();
  });

  it('runs Chrome itself or Chromium in its new headless mode', () => {
    const {home, repo} = setup();
    const bin = makeTempDir('branch-review-chrome-path-');
    const chromium = writeExecutable(path.join(bin, 'chromium'), SCRIPT);
    const found = findChrome({env: {}, home, platform: 'linux', findTool: (name) => (name === 'chromium' ? chromium : null), repoRoot: repo});
    expect(found).toEqual({path: chromium, headless: '--headless=new'});
    const shellOnPath = writeExecutable(path.join(bin, 'chrome-headless-shell'), SCRIPT);
    expect(findChrome({env: {}, home, platform: 'linux', findTool: (name) => (name === 'chrome-headless-shell' ? shellOnPath : name === 'chromium' ? chromium : null), repoRoot: repo})).toEqual({path: shellOnPath, headless: '--headless'});
  });

  it('answers null, never an error, when nothing is found', () => {
    const {home, repo} = setup();
    expect(findChrome({env: {}, home, platform: 'linux', findTool: none, repoRoot: repo})).toBeNull();
    expect(findChrome({env: {}, home: path.join(home, 'missing'), platform: 'win32', findTool: none, repoRoot: repo})).toBeNull();
  });
});
