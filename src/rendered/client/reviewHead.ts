import {readReviewHash} from '../hash.js';
import {readStore, STORE_KEYS} from '../review/store.js';

// The Review in browser page's first script, in <head> ahead of the
// stylesheet, so a theme the reader picked applies from the first frame
// rather than flashing the system's one first. With storage off the page
// follows the system.

const theme = readStore(STORE_KEYS.theme);
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

// A press in the TUI arrives here under a teal to violet scanline that
// sweeps down once, the other half of its launch. It is armed before the
// first frame, so the page never shows before its arrival; the page script
// clears it once it has played. A live refresh, motion off (`m=0`), a page
// opened by hand (no `n`) and reduced motion all show the page at once.
const arrival = readReviewHash(location.hash);
if (arrival.m === true && arrival.n !== undefined && !arrival.l && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.documentElement.classList.add('rv-arriving');
