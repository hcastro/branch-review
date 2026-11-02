// What the Review in browser page keeps in the reader's browser, and only
// there: the theme, the diff layout, a dismissed note, and each review's
// viewed marks; and for the tab alone, where the reader was on the page
// and what they did to its cards, which a live refresh in watch mode lands
// at, and the cards' signatures, by which it tells what changed. Each read and write is
// wrapped, since storage can be off (a private window, blocked site data)
// and the page must work without it. Pure apart from Web Storage: both
// page scripts share it.

export const STORE_KEYS = {
  theme: 'branch-review:theme',
  layout: 'branch-review:layout',
  note: 'branch-review:note',
  // Followed by the review's id: a hash of the repo's path and its refs.
  viewed: 'branch-review:viewed:',
  // In this tab's session storage, followed by the review's id.
  place: 'branch-review:place:',
  // In this tab's session storage, followed by the review's id: each card's
  // diff signature on the last page this tab showed, and what the reader
  // did to each card (its view, folded, loaded), which a live refresh keeps.
  signatures: 'branch-review:signatures:',
  cards: 'branch-review:cards:',
} as const;

export function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStore(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is off: the choice lasts as long as the page.
  }
}

export function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // Storage is off: a live refresh lands at the card the press opened.
  }
}
