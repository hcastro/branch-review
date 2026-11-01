import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    // Lets the worker's event loop turn between tests: see the file.
    setupFiles: ['./tests/setup-yield.ts'],
  },
});
