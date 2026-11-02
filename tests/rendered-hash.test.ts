import {describe, expect, it} from 'vitest';
import {formatPageHash, formatReviewHash, readPageHash, readReviewHash} from '../src/rendered/hash.js';

// What rides in a page URL's hash: where to open, how to arrive, and the
// terminal's colors. Only our own values: integers, hex colors and our
// block ids, so nothing from the repo ever reaches a URL or a cmux argument.

describe('the page hash', () => {
  it('writes the fields in one order, and reads them back', () => {
    const hash = {at: 42, f: 0.35, d: 'full', m: true, bg: '111318', fg: 'e6e6e6', g: ['b-0a1b2c3d-0', 'b-ffffffff-12'], n: 3} as const;
    const text = formatPageHash(hash);
    expect(text).toBe('at=L42&f=0.35&d=full&m=1&bg=111318&fg=e6e6e6&g=b-0a1b2c3d-0,b-ffffffff-12&n=3');
    expect(readPageHash(`#${text}`)).toEqual(hash);
    expect(formatPageHash({d: 'short', m: false})).toBe('d=short&m=0');
  });

  it('rounds the fraction to hundredths and keeps it in [0, 1]', () => {
    expect(formatPageHash({f: 0.333333})).toBe('f=0.33');
    expect(formatPageHash({f: 1.7})).toBe('f=1');
    expect(formatPageHash({f: -0.2})).toBe('f=0');
  });

  it('drops anything that isn\'t one of our values, whoever wrote it', () => {
    expect(readPageHash('#at=L0&at=L-4&f=2&d=wild&m=2&bg=red&fg=11131&g=<b>,b-123-0&n=x')).toEqual({});
    expect(readPageHash('#at=Lx&bg=GGGGGG&g=b-0a1b2c3d-0,javascript:1')).toEqual({g: ['b-0a1b2c3d-0']});
    expect(readPageHash('')).toEqual({});
    expect(readPageHash('#user-content-install')).toEqual({});
  });

  it('never writes a value it would refuse to read', () => {
    expect(formatPageHash({at: 0, bg: '#111318', fg: 'nope', g: ['x', 'b-0a1b2c3d-0'], n: -1})).toBe('bg=111318&g=b-0a1b2c3d-0');
  });

  it('caps the new block ids at 64, so a large refresh keeps the URL short', () => {
    const ids = Array.from({length: 100}, (_, index) => `b-0a1b2c3d-${index}`);
    expect(readPageHash(`#${formatPageHash({g: ids})}`).g).toHaveLength(64);
  });
});

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
