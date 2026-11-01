import fs from 'node:fs';
import path from 'node:path';

// The headless Chromium the in-pane view draws pages with, found on disk and
// never installed: the core of branch-review stays git, delta and a
// clipboard, and only `v` on a markdown file needs this. In order:
// BRANCH_REVIEW_CHROME, the newest headless shell Playwright or Puppeteer
// installed, then Chrome or Chromium themselves. Only absolute paths to
// executable files outside the reviewed repo count, symlinks resolved, so a
// repo can never plant the browser we start.

export type ChromeBinary = {
  path: string;
  // The headless shell is headless already; Chrome needs the new mode.
  headless: '--headless' | '--headless=new';
};

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHELL_NAME = 'chrome-headless-shell';
const PLAYWRIGHT_SHELL = /^chromium_headless_shell-(\d+)$/;
// Puppeteer names an install `<platform>-<version>`.
const PUPPETEER_SHELL = /^[a-z0-9_]+-(\d+(?:\.\d+)*)$/;

// Whether `file` (resolved) is `root` or inside it.
function inside(file: string, root: string) {
  return file === root || file.startsWith(`${root}${path.sep}`);
}

// The program a path names, symlinks resolved, when it is an executable
// file outside the repo; else null.
function usable(candidate: string, repoRoot: string): string | null {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const resolved = fs.realpathSync.native(candidate);
    let root: string;
    try {
      root = fs.realpathSync.native(repoRoot);
    } catch {
      root = path.resolve(repoRoot);
    }
    if (inside(resolved, root)) return null;
    if (!fs.statSync(resolved).isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function children(dir: string) {
  try {
    return fs.readdirSync(dir, {withFileTypes: true}).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Versions compared part by part as numbers: 1234 after 999, 154.0 after 131.0.
function compareVersions(left: string, right: string) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const difference = (a[at] ?? 0) - (b[at] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// The headless shell in the newest install under `root` whose name
// `pattern` reads a version from, looking one folder down for the binary.
function newestShell(root: string, pattern: RegExp, repoRoot: string) {
  const installs = children(root).flatMap((name) => {
    const version = pattern.exec(name)?.[1];
    return version ? [{name, version}] : [];
  }).sort((left, right) => compareVersions(right.version, left.version));
  for (const install of installs) {
    const dir = path.join(root, install.name);
    for (const platformDir of children(dir).filter((name) => name.startsWith(`${SHELL_NAME}-`))) {
      const found = usable(path.join(dir, platformDir, SHELL_NAME), repoRoot);
      if (found) return found;
    }
  }
  return null;
}

export function findChrome({env, home, platform, findTool, repoRoot, macChrome = MAC_CHROME}: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
  /** An absolute path for a program on PATH, outside the repo, or null. */
  findTool: (name: string) => string | null;
  repoRoot: string;
  macChrome?: string;
}): ChromeBinary | null {
  const named = env.BRANCH_REVIEW_CHROME?.trim();
  if (named) {
    const found = usable(named, repoRoot);
    // A shell by its name; anything else as Chrome.
    if (found) return {path: found, headless: path.basename(found) === SHELL_NAME ? '--headless' : '--headless=new'};
    return null;
  }
  if (platform !== 'darwin' && platform !== 'linux') return null;
  const playwright = platform === 'darwin' ? path.join(home, 'Library', 'Caches', 'ms-playwright') : path.join(home, '.cache', 'ms-playwright');
  const shell = newestShell(playwright, PLAYWRIGHT_SHELL, repoRoot) ?? newestShell(path.join(home, '.cache', 'puppeteer', SHELL_NAME), PUPPETEER_SHELL, repoRoot);
  if (shell) return {path: shell, headless: '--headless'};
  if (platform === 'darwin') {
    const chrome = usable(macChrome, repoRoot);
    return chrome ? {path: chrome, headless: '--headless=new'} : null;
  }
  const onPath = findTool(SHELL_NAME);
  if (onPath) return {path: onPath, headless: '--headless'};
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    const found = findTool(name);
    if (found) return {path: found, headless: '--headless=new'};
  }
  return null;
}
