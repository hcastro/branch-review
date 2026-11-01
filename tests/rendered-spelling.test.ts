import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The rendered view's code is new, so its names and comments use American
// spelling. Older British spellings elsewhere in the code predate it.

const ROOT = path.join(import.meta.dirname, '..', 'src', 'rendered');
const BRITISH = /\b(?:travell\w*|colour\w*|behaviour\w*|cancell(?:ed|ing)|centre\w*|licence\w*|organis\w*|analys(?:e|ed|es|ing)|grey\w*)\b/gi;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'assets' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && entry.name !== 'assets.generated.ts' ? [full] : [];
  });
}

describe('spelling in the rendered view', () => {
  it('uses American spelling in every name and comment', () => {
    const found = sources(ROOT).flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(BRITISH)].map((match) => `${path.relative(ROOT, file)}: ${match[0]}`));
    expect(found).toEqual([]);
  });
});
