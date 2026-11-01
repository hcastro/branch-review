import {describe, expect, it} from 'vitest';
import {footerHintText, RENDERED_KEY_HINT_ITEMS} from '../src/ui/App.js';

// The footer takes the key hints to show, so a media file can list its own
// keys; `q quit` leads and hints drop whole from the end.

const MEDIA_ITEMS = ['q quit', '↑/↓ jump file', 'o open', 'v text', 'j/k scroll', 'y d copy', 't tree'];

describe('footerHintText', () => {
  it('shows the hints it is given, dropping whole ones from the end', () => {
    expect(footerHintText(undefined, 200, MEDIA_ITEMS)).toBe(MEDIA_ITEMS.join(' • '));
    expect(footerHintText(undefined, 40, MEDIA_ITEMS)).toBe('q quit • ↑/↓ jump file • o open • v text');
    expect(footerHintText('updated now', 36, MEDIA_ITEMS)).toBe('updated now • q quit • ↑/↓ jump file');
  });

  it('keeps q quit and cuts the status when nothing else fits', () => {
    expect(footerHintText('a long watch status message', 20, MEDIA_ITEMS)).toBe('a long wat… • q quit');
  });

  it('uses the standard hints when given none', () => {
    expect(footerHintText(undefined, 200)).toBe('q quit • ↑/↓ jump file • j/k scroll • [/] block • ⏎ fold • y d f c p b copy • t tree');
  });

  it('names r and R in words right after the file keys on a file with a page in the browser', () => {
    expect(footerHintText(undefined, 200, RENDERED_KEY_HINT_ITEMS)).toBe('q quit • ↑/↓ jump file • r review in browser • R all files in browser • j/k scroll • [/] block • t tree');
    expect(footerHintText(undefined, 70, RENDERED_KEY_HINT_ITEMS)).toBe('q quit • ↑/↓ jump file • r review in browser • R all files in browser');
    expect(footerHintText('updated now', 60, RENDERED_KEY_HINT_ITEMS)).toBe('updated now • q quit • ↑/↓ jump file • r review in browser');
  });

  it('keeps a last hint after the others, dropping the ones before it first, and it only when q quit alone is left', () => {
    expect(footerHintText(undefined, 200, MEDIA_ITEMS, '? keys')).toBe(`${MEDIA_ITEMS.join(' • ')} • ? keys`);
    expect(footerHintText(undefined, 49, MEDIA_ITEMS, '? keys')).toBe('q quit • ↑/↓ jump file • o open • v text • ? keys');
    expect(footerHintText(undefined, 15, MEDIA_ITEMS, '? keys')).toBe('q quit • ? keys');
    expect(footerHintText(undefined, 12, MEDIA_ITEMS, '? keys')).toBe('q quit');
  });
});
