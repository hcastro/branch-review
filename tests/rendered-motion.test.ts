import {describe, expect, it} from 'vitest';
import {resolveMotion, type MotionLevels} from '../src/rendered/motion.js';
import type {RunResult, RunTool} from '../src/rendered/run.js';

// How much the TUI moves when it throws a page across: the flag, then the
// env override, then the macOS reduce motion setting, read once with a
// short timeout and never over SSH. With none of them a trip is quiet, and
// only `!` plays the full launch.

function recordingRun(answer: RunResult | (() => Promise<RunResult>)) {
  const calls: Array<{command: string; args: string[]; timeoutMs: number}> = [];
  const run: RunTool = async (command, args, options) => {
    calls.push({command, args, timeoutMs: options.timeoutMs});
    return typeof answer === 'function' ? answer() : answer;
  };
  return {run, calls};
}

const ON: RunResult = {ok: true, stdout: '1\n'};
const OFF: RunResult = {ok: true, stdout: '0\n'};
const both = (motion: MotionLevels['usual']): MotionLevels => ({usual: motion, loud: motion});
const QUIET: MotionLevels = {usual: 'reduced', loud: 'full'};

describe('resolveMotion', () => {
  it('is off under --no-animations, whatever else says, for `!` too', async () => {
    const {run, calls} = recordingRun(OFF);
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'full'}, animations: false, run, platform: 'darwin'})).toEqual(both('off'));
    expect(calls).toEqual([]);
  });

  it('takes BRANCH_REVIEW_MOTION over the system setting for every trip, and ignores a value it does not know', async () => {
    const {run, calls} = recordingRun(ON);
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'full'}, animations: true, run, platform: 'darwin'})).toEqual(both('full'));
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'reduce'}, animations: true, run, platform: 'darwin'})).toEqual(both('reduced'));
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: ' OFF '}, animations: true, run, platform: 'linux'})).toEqual(both('off'));
    expect(calls).toEqual([]);
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'sometimes'}, animations: true, run, platform: 'darwin'})).toEqual(both('reduced'));
    expect(calls).toHaveLength(1);
  });

  it('reads the macOS reduce motion setting with /usr/bin/defaults and a 300 ms timeout, and holds `!` to it', async () => {
    const reduced = recordingRun(ON);
    expect(await resolveMotion({env: {}, animations: true, run: reduced.run, platform: 'darwin'})).toEqual(both('reduced'));
    expect(reduced.calls).toEqual([{command: '/usr/bin/defaults', args: ['read', 'com.apple.universalaccess', 'reduceMotion'], timeoutMs: 300}]);

    const full = recordingRun(OFF);
    expect(await resolveMotion({env: {}, animations: true, run: full.run, platform: 'darwin'})).toEqual(QUIET);
  });

  it('is quiet, with the full launch on `!`, when the setting is unset, unreadable or slow to answer', async () => {
    // `defaults` exits 1 when the key was never written.
    const unset = recordingRun({ok: false, timedOut: false, reason: 'exit 1'});
    expect(await resolveMotion({env: {}, animations: true, run: unset.run, platform: 'darwin'})).toEqual(QUIET);
    const slow = recordingRun({ok: false, timedOut: true, reason: 'timed out'});
    expect(await resolveMotion({env: {}, animations: true, run: slow.run, platform: 'darwin'})).toEqual(QUIET);
    const odd = recordingRun({ok: true, stdout: 'yes please\n'});
    expect(await resolveMotion({env: {}, animations: true, run: odd.run, platform: 'darwin'})).toEqual(QUIET);
  });

  it('asks nothing over SSH or off macOS, where the setting is not the reader\'s', async () => {
    const {run, calls} = recordingRun(ON);
    expect(await resolveMotion({env: {SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, animations: true, run, platform: 'darwin'})).toEqual(QUIET);
    expect(await resolveMotion({env: {}, animations: true, run, platform: 'linux'})).toEqual(QUIET);
    expect(calls).toEqual([]);
  });
});
