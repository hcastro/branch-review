import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

// The asset and report tests wait on real git and real timers. A per-test
// timeout written into them would override the one the run sets
// (--testTimeout), and fail them on a loaded machine.

const FILES = ['core-rendered-assets.test.ts', 'rendered-report.test.ts'];

describe('per-test timeouts in the asset and report tests', () => {
  it('leaves the timeout to the run', () => {
    const found = FILES.flatMap((name) => fs.readFileSync(path.join(import.meta.dirname, name), 'utf8').split('\n')
      .flatMap((line, at) => (/^\s*\}, 10_000\);\s*$/.test(line) ? [`${name}:${at + 1}`] : [])));
    expect(found).toEqual([]);
  });
});

// A surface on the real runner whose fake cmux is meant to answer gets
// ANSWERS_MS: at cmux's own 1500 ms a slow fork on a loaded machine sends
// the page to the browser instead. Only a test of the timeout itself, whose
// fake cmux sleeps, keeps the 1500 ms.
describe('the time a fake cmux on the real runner has to answer', () => {
  it('is ANSWERS_MS in every test whose fake cmux is meant to answer', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'rendered-surface.test.ts'), 'utf8');
    const tests = source.split(/\n(?=\s*it\()/).slice(1);
    const hasty = tests.filter((body) => body.includes('run: runTool') && !body.includes('timeoutMs: ANSWERS_MS') && !/\bsleep\b/.test(body))
      .map((body) => /it\('((?:[^'\\]|\\.)*)'/.exec(body)?.[1]);
    expect(hasty).toEqual([]);
  });
});
