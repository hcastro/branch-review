import type {DevelopMode} from './develop.js';

// A page URL's hash: where the page opens and how it arrives, written by the
// UI side for each trip and read by the page script. The page's file stays
// the same for every trip, so a prerendered page serves them all, and a
// later trip to an open split is only a new hash. Every value is ours (an
// integer, a hex color, one of our block ids), checked on the way in and on
// the way out, so no repo text reaches a URL, a cmux argument or the page.
// Pure, with no Node imports: the page script uses it too.

export type PageHash = {
  /** The source line to open at. */
  at?: number;
  /** Where that line's block sits in the viewport, from 0 (top) to 1. */
  f?: number;
  /** How the page arrives: the full develop, a short revisit, or none (a live refresh). */
  d?: DevelopMode;
  /** Motion on (`--no-animations` sends it off). */
  m?: boolean;
  /** The terminal's background and text colors, `rrggbb`. */
  bg?: string;
  fg?: string;
  /** Blocks new since the last page of this file, which a live refresh pulses. */
  g?: readonly string[];
  /** A counter, so every trip's URL differs and the page hears each one. */
  n?: number;
};

const MAX_LINE = 10_000_000;
const MAX_PULSE = 64;
const HEX = /^[0-9a-f]{6}$/;
const BLOCK_ID = /^b-[0-9a-f]{8}-\d{1,6}$/;
const MODES: readonly DevelopMode[] = ['full', 'short', 'none'];

const line = (value: number | undefined) => (value !== undefined && Number.isInteger(value) && value >= 1 && value <= MAX_LINE ? value : undefined);
const counter = (value: number | undefined) => (value !== undefined && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined);
const color = (value: string | undefined) => {
  const hex = value?.replace(/^#/, '').toLowerCase();
  return hex !== undefined && HEX.test(hex) ? hex : undefined;
};
const ids = (values: readonly string[] | undefined) => {
  const valid = (values ?? []).filter((id) => BLOCK_ID.test(id)).slice(0, MAX_PULSE);
  return valid.length > 0 ? valid : undefined;
};

/** The hash for `hash`, without the `#`, leaving out every field that isn't ours. */
export function formatPageHash(hash: PageHash): string {
  const parts: string[] = [];
  const at = line(hash.at);
  if (at !== undefined) parts.push(`at=L${at}`);
  if (hash.f !== undefined && Number.isFinite(hash.f)) parts.push(`f=${Math.round(Math.min(1, Math.max(0, hash.f)) * 100) / 100}`);
  if (hash.d && MODES.includes(hash.d)) parts.push(`d=${hash.d}`);
  if (hash.m !== undefined) parts.push(`m=${hash.m ? 1 : 0}`);
  const bg = color(hash.bg);
  if (bg) parts.push(`bg=${bg}`);
  const fg = color(hash.fg);
  if (fg) parts.push(`fg=${fg}`);
  const pulse = ids(hash.g);
  if (pulse) parts.push(`g=${pulse.join(',')}`);
  const n = counter(hash.n);
  if (n !== undefined) parts.push(`n=${n}`);
  return parts.join('&');
}

/** The fields of a page hash that are ours. A hash that is a heading's anchor reads as none. */
export function readPageHash(text: string): PageHash {
  const hash: PageHash = {};
  for (const pair of text.replace(/^#/, '').split('&')) {
    const [key, value = ''] = pair.split('=', 2);
    if (key === 'at' && /^L\d{1,8}$/.test(value)) {
      const at = line(Number(value.slice(1)));
      if (at !== undefined) hash.at = at;
    } else if (key === 'f' && /^(?:0(?:\.\d{1,2})?|1)$/.test(value)) {
      hash.f = Number(value);
    } else if (key === 'd' && (MODES as readonly string[]).includes(value)) {
      hash.d = value as DevelopMode;
    } else if (key === 'm' && (value === '0' || value === '1')) {
      hash.m = value === '1';
    } else if ((key === 'bg' || key === 'fg') && HEX.test(value)) {
      hash[key] = value;
    } else if (key === 'g') {
      const pulse = ids(value.split(','));
      if (pulse) hash.g = pulse;
    } else if (key === 'n' && /^\d{1,15}$/.test(value)) {
      hash.n = Number(value);
    }
  }
  return hash;
}
