// Runs one job through a real worker backend and then simply returns, the
// way runCli returns after q. The process must end on its own soon after,
// long before the worker's idle stop: nothing of the worker may hold it up.
import {createWorkerBackend} from '../../src/media/workerClient.js';

const [tempDir, modulePath] = process.argv.slice(2) as [string, string];
const backend = createWorkerBackend({tempDir: () => tempDir, modulePath, idleMs: 30_000});
const side = {side: 'after', source: 'blob', path: 'answer.png', abbrevId: 'abcdef1', key: 'blob|answer.png|abcdef1'} as const;
// The worker holds nothing open, so something must keep this process up
// while it waits, as Ink and the terminal do in the app.
const waiting = setInterval(() => undefined, 1_000);
const result = await backend.inspect({cwd: process.cwd(), side, kind: 'raster', format: 'png'}, new AbortController().signal);
clearInterval(waiting);
process.stdout.write(`answered ${JSON.stringify(result)}\n`);
