import {readStore, STORE_KEYS} from '../review/store.js';

// The Review in browser page's first script, in <head> ahead of the
// stylesheet, so a theme the reader picked applies from the first frame
// rather than flashing the system's one first. With storage off the page
// follows the system.

const theme = readStore(STORE_KEYS.theme);
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
