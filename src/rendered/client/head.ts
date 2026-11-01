import {readPageHash} from '../hash.js';

// The page's first script, in <head> ahead of the stylesheet, so it runs
// before anything paints. A trip that plays the full develop starts from
// the terminal's own background, and a split cmux has just opened would
// otherwise show one white frame (the browser's default) before the raw
// frame does. This marks the root to paint that background from the first
// frame; the page script takes the mark off once its raw frame covers the
// page, or at once when it plays nothing. With reduced motion the raw frame
// still shows, for one short fade, so it is marked the same.

const hash = readPageHash(location.hash);
if (hash.d === 'full' && hash.m !== false) {
  const root = document.documentElement;
  if (hash.bg) root.style.setProperty('--br-first-bg', `#${hash.bg}`);
  root.setAttribute('data-br-first', '');
}
