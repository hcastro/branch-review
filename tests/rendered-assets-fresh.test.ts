import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {describe, expect, it} from 'vitest';

const script = fileURLToPath(new URL('../scripts/inline-assets.mjs', import.meta.url));

describe('src/rendered/assets.generated.ts', () => {
  it('matches what scripts/inline-assets.mjs makes from src/rendered/assets', () => {
    // --check compares without writing, so a stale checkout fails here
    // rather than shipping CSS whose CSP hash doesn't match.
    const result = spawnSync(process.execPath, [script, '--check'], {encoding: 'utf8'});
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('is checked, never rewritten, before the tests run, and regenerated before every build', () => {
    const {scripts} = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {scripts: Record<string, string>};
    // A pretest that rewrote the file would make the check above pass on a
    // stale checkout.
    expect(scripts.pretest).toBe('node scripts/inline-assets.mjs --check');
    expect(scripts.prebuild).toBe('node scripts/inline-assets.mjs');
    // prepare runs bare on an install from git, without prebuild.
    expect(scripts.prepare).toBe('node scripts/inline-assets.mjs && tsup');
  });
});

