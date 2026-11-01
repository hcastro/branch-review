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

  it('turns image previews off with --no-images and back on with --images, the last one winning', () => {
    expect(parseCliArgs([], {interactive: true}).images).toBeUndefined();
    expect(parseCliArgs(['--no-images'], {interactive: true}).images).toBe('off');
    expect(parseCliArgs(['--no-images', '--images'], {interactive: true}).images).toBe('auto');
    expect(parseCliArgs(['--images', '--no-images', 'feature', 'main'], {interactive: false})).toMatchObject({
      images: 'off',
      requestedBranch: 'feature',
      requestedBase: 'main',
    });
  });

  it('reads --export-html with its directory, as a separate argument or after =, and --json with it', () => {
    expect(parseCliArgs(['--export-html', 'out'], {interactive: true})).toMatchObject({renderOut: 'out', requestedBranch: 'HEAD'});
    expect(parseCliArgs(['feature', '--export-html=./pages', '--json', 'main'], {interactive: false})).toMatchObject({
      renderOut: './pages',
      json: true,
      requestedBranch: 'feature',
      requestedBase: 'main',
    });
    // Headless output never watches, even in a terminal.
    expect(parseCliArgs(['--export-html', 'out', '--watch'], {interactive: true}).watch).toBe(false);
    expect(parseCliArgs([], {interactive: true})).not.toHaveProperty('renderOut');
    expect(parseCliArgs([], {interactive: true})).not.toHaveProperty('json');
  });

  it('refuses --export-html with no directory, and --json without --export-html', () => {
    expect(() => parseCliArgs(['--export-html'], {interactive: true})).toThrow('--export-html needs a directory, for example --export-html ./pages');
    expect(() => parseCliArgs(['--export-html', '--json'], {interactive: true})).toThrow('--export-html needs a directory');
    expect(() => parseCliArgs(['--export-html='], {interactive: true})).toThrow('--export-html needs a directory');
    expect(() => parseCliArgs(['--json'], {interactive: true})).toThrow('--json works only with --export-html');
  });

  it('has no --render-out: the flag is --export-html, with no alias', () => {
    expect(parseCliArgs(['--render-out', 'out'], {interactive: true})).not.toHaveProperty('renderOut');
    expect(parseCliArgs(['--render-out=out'], {interactive: true})).not.toHaveProperty('renderOut');
  });
});
