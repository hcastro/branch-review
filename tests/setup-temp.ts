import {afterAll} from 'vitest';
import {cleanupTempDirs} from './core-helpers.js';

// Every temp folder a test makes through makeTempDir is removed when its file
// finishes, so a file that forgets its own cleanup can't leave fixture repos
// and diff folders behind on every run. Files that clean up after each test
// still do; the list is empty by then.
afterAll(() => {
  cleanupTempDirs();
});
