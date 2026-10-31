import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {createRenderedSite} from '../src/rendered/site.js';
import {cleanupTempDirs, makeTempDir} from './core-helpers.js';

// The session's pages on disk: content-addressed files nobody can rewrite,
// a stable name per file that always shows its newest page, and a prune that
// keeps what a reader may still have open.

afterEach(cleanupTempDirs);

const KEY_A = 'a'.repeat(20);
const KEY_B = 'b'.repeat(20);
const KEY_C = 'c'.repeat(20);
const ALIAS = `f-${'1'.repeat(20)}`;

function siteIn(options: {now?: () => number; maxBytes?: number} = {}) {
  const session = makeTempDir('branch-review-media-site-');
  fs.chmodSync(session, 0o700);
  return {session, dir: path.join(session, 'rendered'), site: createRenderedSite({tempDir: () => session, ...options})};
}

describe('the rendered site', () => {
  it('writes each page once, read-only, in a private dir, and never leaves a temp file', () => {
    const {dir, site} = siteIn();
    site.write(KEY_A, '<p>one</p>');
    // The same key names the same content: a second write changes nothing.
    site.write(KEY_A, '<p>other</p>');

    const file = path.join(dir, `${KEY_A}.html`);
    expect(fs.readFileSync(file, 'utf8')).toBe('<p>one</p>');
    expect(fs.statSync(file).mode & 0o777).toBe(0o400);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(dir)).toEqual([`${KEY_A}.html`]);
  });

  it('refuses any name that is not one of its own keys', () => {
    const {site} = siteIn();
    expect(() => site.write('../escape', 'x')).toThrow('not a page key');
    expect(() => site.write('README', 'x')).toThrow('not a page key');
    expect(() => site.alias('f-../../x', KEY_A)).toThrow('not a page name');
  });

  it('points a file\'s stable name at its newest page without copying it', () => {
    const {dir, site} = siteIn();
    site.write(KEY_A, '<p>first</p>');
    site.alias(ALIAS, KEY_A);
    site.write(KEY_B, '<p>second</p>');
    site.alias(ALIAS, KEY_B);

    const alias = path.join(dir, `${ALIAS}.html`);
    expect(fs.readFileSync(alias, 'utf8')).toBe('<p>second</p>');
    expect(fs.statSync(alias).ino).toBe(fs.statSync(path.join(dir, `${KEY_B}.html`)).ino);
    expect(fs.readdirSync(dir).sort()).toEqual([`${KEY_A}.html`, `${KEY_B}.html`, `${ALIAS}.html`].sort());
  });

  it('gives a file URL with the hash, and remembers the page was shown', () => {
    const {dir, site} = siteIn();
    site.write(KEY_A, '<p>x</p>');
    expect(site.url(KEY_A, 'at=L4')).toBe(`${pathToFileURL(path.join(dir, `${KEY_A}.html`)).href}#at=L4`);
    expect(site.url(KEY_A)).toBe(pathToFileURL(path.join(dir, `${KEY_A}.html`)).href);
  });

  it('keeps current and previous pages, and anything shown in the last two minutes', () => {
    let now = 0;
    const {dir, site} = siteIn({now: () => now});
    for (const key of [KEY_A, KEY_B, KEY_C]) site.write(key, `<p>${key}</p>`);
    site.alias(ALIAS, KEY_C);
    site.url(KEY_A);

    now = 60_000;
    site.prune({current: new Map([[ALIAS, KEY_C]]), previous: new Set()});
    // A was shown a minute ago: a reader may still have it open.
    expect(fs.readdirSync(dir).sort()).toEqual([`${KEY_A}.html`, `${KEY_C}.html`, `${ALIAS}.html`].sort());

    now = 180_000;
    site.prune({current: new Map([[ALIAS, KEY_C]]), previous: new Set()});
    expect(fs.readdirSync(dir).sort()).toEqual([`${KEY_C}.html`, `${ALIAS}.html`].sort());

    // A file that left the review loses its stable name too.
    site.prune({current: new Map(), previous: new Set()});
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('drops previous pages, oldest first, to stay inside its disk budget, and never a current one', () => {
    let now = 0;
    const {dir, site} = siteIn({now: () => now, maxBytes: 2500});
    site.write(KEY_A, 'a'.repeat(1000));
    now = 1;
    site.write(KEY_B, 'b'.repeat(1000));
    now = 2;
    site.write(KEY_C, 'c'.repeat(1000));
    site.alias(ALIAS, KEY_C);

    site.prune({current: new Map([[ALIAS, KEY_C]]), previous: new Set([KEY_A, KEY_B])});
    // The stable name shares its page's bytes, so it costs nothing.
    expect(fs.readdirSync(dir).sort()).toEqual([`${KEY_B}.html`, `${KEY_C}.html`, `${ALIAS}.html`].sort());

    const tight = siteIn({maxBytes: 10});
    tight.site.write(KEY_A, 'a'.repeat(1000));
    tight.site.prune({current: new Map([[ALIAS, KEY_A]]), previous: new Set()});
    expect(fs.readdirSync(tight.dir)).toEqual([`${KEY_A}.html`]);
  });

  it('says the disk is full in a line a toast can show', () => {
    const {session, site} = siteIn();
    // A file where the dir would go fails every write the same way a full disk does: at the write.
    fs.writeFileSync(path.join(session, 'rendered'), '');
    expect(() => site.write(KEY_A, 'x')).toThrow(/^can't write the page: /);
  });
});
