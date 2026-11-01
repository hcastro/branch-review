import {afterEach} from 'vitest';

// Captured when this file loads, before any test fakes timers.
const realSetTimeout = globalThis.setTimeout;

// The vitest worker reports each test to the main process over an RPC that
// fails with `Timeout calling "onTaskUpdate"` when no answer is read within
// 60 s, and the answer is read only when the worker's event loop polls. The
// runner moves from one test to the next on promises alone, so a file of
// synchronous tests (spawnSync of git, delta or the CLI) runs as one long
// turn of the loop, and on a slow machine the report sent at its start times
// out. Two timeouts after every test make the loop poll between them, and
// the next test still starts from a timer, as the UI tests' flushes expect.
afterEach(async () => {
  for (let turn = 0; turn < 2; turn += 1) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 0);
    });
  }
});
