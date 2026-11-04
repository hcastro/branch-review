// A page URL's hash: where the Review in browser page opens and how it
// arrives, written by the UI side for each trip and read by the page
// script. The page's file stays the same for every trip, so a prerendered
// page serves them all, and a later trip to an open split is only a new
// hash. Every value is ours (a card's place, a counter, a flag), checked on
// the way in and on the way out, so no repo text reaches a URL, a cmux
// argument or the page. Pure, with no Node imports: the page script uses
// it too.

const counter = (value: number | undefined) => (value !== undefined && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined);

/**
 * The Review in browser page's hash: the card to open at (`file-<n>`, the
 * file's place in the review), or `top`, then motion and the trip counter,
 * which makes every trip's URL differ, so an open split hears a press on
 * the same file again. `l`: a live refresh in watch mode, which lands at
 * the card the reader was on, with no glow. `a`: a trip with full motion,
 * whose page decodes in; without it the page shows at once.
 */
export type ReviewHash = {file?: number; m?: boolean; n?: number; l?: true; a?: true};

const CARD = /^file-(\d{1,6})$/;

export function formatReviewHash(hash: ReviewHash): string {
  const file = hash.file !== undefined && Number.isInteger(hash.file) && hash.file >= 0 && hash.file < 1_000_000 ? hash.file : undefined;
  const parts = [file === undefined ? 'top' : `file-${file}`];
  if (hash.m !== undefined) parts.push(`m=${hash.m ? 1 : 0}`);
  const n = counter(hash.n);
  if (n !== undefined) parts.push(`n=${n}`);
  if (hash.l) parts.push('l=1');
  if (hash.a) parts.push('a=1');
  return parts.join('&');
}

/** The fields of a Review in browser hash that are ours. */
export function readReviewHash(text: string): ReviewHash {
  const hash: ReviewHash = {};
  for (const part of text.replace(/^#/, '').split('&')) {
    const card = CARD.exec(part);
    const [key, value = ''] = part.split('=', 2);
    if (card) hash.file = Number(card[1]);
    else if (key === 'm' && (value === '0' || value === '1')) hash.m = value === '1';
    else if (key === 'n' && /^\d{1,15}$/.test(value)) hash.n = Number(value);
    else if (key === 'l' && value === '1') hash.l = true;
    else if (key === 'a' && value === '1') hash.a = true;
  }
  return hash;
}
