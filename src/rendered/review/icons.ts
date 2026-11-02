// The Review in browser page's icons: our own 16 px line drawings, inline
// SVG so the page loads nothing. Pure: the page and its script draw them
// alike.

const PATHS = {
  chevD: '<path d="M4 6l4 4 4-4"/>',
  file: '<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/>',
  folder: '<path d="M1.75 3.25h4.5l1.5 1.5h6.5v8H1.75z"/>',
  kebab: '<circle cx="3" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.25" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r="1.25" fill="currentColor" stroke="none"/>',
  sidebar: '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5"/><path d="M6 2.75v10.5"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"/>',
  moon: '<path d="M13.25 9.75A5.5 5.5 0 0 1 6.25 2.75a5.5 5.5 0 1 0 7 7z"/>',
  monitor: '<rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 14h5M8 11v3"/>',
  up: '<path d="M8 12.5V4M4.5 7.5L8 4l3.5 3.5M3 1.75h10"/>',
  down: '<path d="M8 3.5V12M4.5 8.5L8 12l3.5-3.5M3 14.25h10"/>',
  unfold: '<path d="M8 1.5v4.5M5.5 3.75L8 1.25l2.5 2.5M8 14.5V10M5.5 12.25L8 14.75l2.5-2.5M2.5 8h1.5M6.5 8h3M12 8h1.5"/>',
  fold: '<path d="M8 1v4.5M5.5 3L8 5.5 10.5 3M8 15v-4.5M5.5 13L8 10.5l2.5 2.5M2.5 8h11"/>',
  copy: '<rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5"/><path d="M2.25 10.25v-7a1 1 0 0 1 1-1h7"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  code: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
  eye: '<path d="M1.25 8S3.75 3.5 8 3.5 14.75 8 14.75 8 12.25 12.5 8 12.5 1.25 8 1.25 8z"/><circle cx="8" cy="8" r="2"/>',
  keyboard: '<rect x="1.25" y="3.75" width="13.5" height="8.5" rx="1.5"/><path d="M4 6.5h.01M6.67 6.5h.01M9.33 6.5h.01M12 6.5h.01M5 9.5h6"/>',
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4M8 4.75h.01"/>',
  shield: '<path d="M8 1.5l5.5 2v4.25c0 3.25-2.4 5.6-5.5 6.75-3.1-1.15-5.5-3.5-5.5-6.75V3.5z"/><path d="M5.75 8.25l1.5 1.5 3-3.25"/>',
  commit: '<circle cx="8" cy="8" r="2.75"/><path d="M1 8h4.25M10.75 8H15"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.75"/><circle cx="4.5" cy="12.5" r="1.75"/><circle cx="11.5" cy="5" r="1.75"/><path d="M4.5 5.25v5.5M11.5 6.75c0 2.75-2.25 3.25-7 4"/>',
  repo: '<path d="M3 13.5V3a1.25 1.25 0 0 1 1.25-1.25h8.5v10H4.25A1.25 1.25 0 0 0 3 13a1.25 1.25 0 0 0 1.25 1.25h8.5"/>',
  fileDiff: '<path d="M4 1.75h5l3 3v9.5H4z"/><path d="M8 5.5v3.5M6.25 7.25h3.5M6.25 11.25h3.5"/>',
  search: '<circle cx="7" cy="7" r="4.75"/><path d="M10.5 10.5l3.75 3.75"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  plusSq: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5 8h6M8 5v6"/>',
  minusSq: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5 8h6"/>',
  dotSq: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none"/>',
  arrowSq: '<rect x="2" y="2" width="12" height="12" rx="2.5"/><path d="M5 8h6M8.75 5.75L11 8l-2.25 2.25"/>',
  binary: '<rect x="2.75" y="1.75" width="10.5" height="12.5" rx="1.5"/><path d="M6 5v2.5M10 8.5V11M5.25 9.25h1.5v2h-1.5zM9.25 5h1.5v2h-1.5z"/>',
  submodule: '<path d="M1.75 3.25h4.5l1.5 1.5h6.5v8H1.75z"/><path d="M6.5 9h4M9 7.25L10.75 9 9 10.75"/>',
  lfs: '<path d="M8 1.75l5.75 3v6.5L8 14.25l-5.75-3v-6.5z"/><path d="M2.25 4.75L8 7.75l5.75-3M8 7.75v6.5"/>',
  mode: '<circle cx="5.5" cy="10.5" r="3"/><path d="M7.6 8.4l5.65-5.65M10.5 5.5l1.75 1.75M12 4l1.25 1.25"/>',
  alert: '<path d="M8 1.75l6.5 11.5h-13z"/><path d="M8 6v3.5M8 11.5h.01"/>',
  grip: '<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** An icon as markup; `extra` adds classes. Decorative: whatever holds it carries the words. */
export function icon(name: IconName, extra = '') {
  return `<svg class="ic${extra ? ` ${extra}` : ''}" viewBox="0 0 16 16" aria-hidden="true">${PATHS[name]}</svg>`;
}
