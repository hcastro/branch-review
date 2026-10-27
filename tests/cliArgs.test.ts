import {describe, expect, it} from 'vitest';
import {parseCliArgs} from '../src/cliArgs.js';

describe('parseCliArgs', () => {
  it('enables watch mode by default in interactive terminals', () => {
    expect(parseCliArgs([], {interactive: true})).toEqual({
      requestedBranch: 'HEAD',
      requestedBase: undefined,
      watch: true,
      watchPoll: false,
      animations: true,
    });
  });

  it('keeps non-interactive runs static unless watch is explicit', () => {
    expect(parseCliArgs(['feature/demo', 'main'], {interactive: false})).toEqual({
      requestedBranch: 'feature/demo',
      requestedBase: 'main',
      watch: false,
      watchPoll: false,
      animations: true,
    });

    expect(parseCliArgs(['--watch', 'feature/demo', 'main'], {interactive: false}).watch).toBe(true);
  });

  it('supports no-watch and polling fallback flags', () => {
    expect(parseCliArgs(['--no-watch'], {interactive: true}).watch).toBe(false);
    expect(parseCliArgs(['--watch-poll'], {interactive: false})).toMatchObject({
      watch: true,
      watchPoll: true,
    });
  });

  it('supports disabling and re-enabling arrival animations', () => {
    expect(parseCliArgs(['--no-animations'], {interactive: true})).toMatchObject({
      animations: false,
    });
    expect(parseCliArgs(['--animations', '--no-animations'], {interactive: true})).toMatchObject({
      animations: false,
    });
    expect(parseCliArgs(['--no-animations', '--animations'], {interactive: true})).toMatchObject({
      animations: true,
    });
  });
});
