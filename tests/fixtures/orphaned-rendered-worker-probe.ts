// Starts the real rendered worker through its backend, prints its pid, lays
// out a page with the browser `chrome` names (a fake that hangs on every
// screenshot) and sends a tile of it, then waits. A test kills this process
// to see the worker, orphaned, end its own process group, the browser in it
// included.
import type {TileSource} from '../../src/rendered/backend.js';
import {tileGeometry} from '../../src/rendered/tileGeometry.js';
import {createRenderedBackend} from '../../src/rendered/workerClient.js';

const [tempDir, cwd, chrome] = process.argv.slice(2) as [string, string, string];
const backend = createRenderedBackend({tempDir: () => tempDir, cwd, onSpawn: (pid) => process.stdout.write(`worker ${pid}\n`)});
// Kept up the way Ink keeps the app up.
setInterval(() => undefined, 1_000);
const signal = new AbortController().signal;
const source: TileSource = {
  fragment: {cwd, key: 'probe-1', path: 'page.md', status: 'added', source: {kind: 'worktree', path: 'page.md'}, groups: [], links: {}, assets: {base: null, after: {tree: 'HEAD'}, epoch: 0}},
  scheme: 'dark',
  bg: '#101418',
  base: 'main',
  geometry: tileGeometry(220, {w: 13, h: 29})!,
  chrome: {path: chrome, headless: '--headless'},
};
void backend.layout!({source}, signal).then((laid) => {
  process.stdout.write(`laid ${laid.ok}\n`);
  if (laid.ok) void backend.tile!({source, document: laid.document, index: 0, rows: 40, mosaic: false}, signal, 0);
});
