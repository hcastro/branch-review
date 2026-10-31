// Starts the real media worker through a worker backend, prints its pid,
// and sends it one inspect, then waits. A test kills this process to see
// the worker, orphaned, end its own process group.
import {createWorkerBackend} from '../../src/media/workerClient.js';

const [tempDir, cwd] = process.argv.slice(2) as [string, string];
const backend = createWorkerBackend({tempDir: () => tempDir, cwd, onSpawn: (pid) => process.stdout.write(`worker ${pid}\n`)});
const side = {side: 'after', source: 'blob', path: 'a.png', abbrevId: 'abcdef1', key: 'blob|a.png|abcdef1'} as const;
// Kept up the way Ink keeps the app up.
setInterval(() => undefined, 1_000);
void backend.inspect({cwd, side, kind: 'raster', format: 'png'}, new AbortController().signal).then((result) => {
  process.stdout.write(`answered ${JSON.stringify(result)}\n`);
});
