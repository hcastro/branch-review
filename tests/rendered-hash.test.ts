import {describe, expect, it} from 'vitest';
import {formatReviewHash, readReviewHash} from '../src/rendered/hash.js';

// What rides in a page URL's hash: the card to open at, how to arrive, and
// a counter. Only our own values, so nothing from the repo ever reaches a
// URL or a cmux argument.

describe('the Review in browser page hash', () => {
  it('names the card to open, motion and the trip counter, and reads them back', () => {
    const text = formatReviewHash({file: 3, m: false, n: 7});
    expect(text).toBe('file-3&m=0&n=7');
    expect(readReviewHash(`#${text}`)).toEqual({file: 3, m: false, n: 7});
    // No card: the page opens at its top.
    expect(formatReviewHash({m: true, n: 1})).toBe('top&m=1&n=1');
    expect(readReviewHash('#top&m=1&n=1')).toEqual({m: true, n: 1});
  });

  it('drops anything that isn\'t one of our values', () => {
    expect(readReviewHash('#file-x&file--1&m=2&n=<b>')).toEqual({});
    expect(readReviewHash('#user-content-install')).toEqual({});
    expect(formatReviewHash({file: -1, n: Number.NaN})).toBe('top');
  });
});
