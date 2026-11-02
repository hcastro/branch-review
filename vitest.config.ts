import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Lets the worker's event loop turn between tests, and removes every
    // test's temp folders when its file ends: see each file.
    setupFiles: ['./tests/setup-yield.ts', './tests/setup-temp.ts'],
  },
});
