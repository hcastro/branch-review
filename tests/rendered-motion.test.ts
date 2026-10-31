import {describe, expect, it} from 'vitest';
import {resolveMotion} from '../src/rendered/motion.js';
import type {RunResult, RunTool} from '../src/rendered/run.js';

// How much the TUI moves when it throws a page across: the flag, then the
// env override, then the macOS reduce motion setting, read once with a
// short timeout and never over SSH.

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

describe('resolveMotion', () => {
  it('is off under --no-animations, whatever else says', async () => {
    const {run, calls} = recordingRun(OFF);
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'full'}, animations: false, run, platform: 'darwin'})).toBe('off');
    expect(calls).toEqual([]);
  });

  it('takes BRANCH_REVIEW_MOTION over the system setting, and ignores a value it does not know', async () => {
    const {run, calls} = recordingRun(ON);
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'full'}, animations: true, run, platform: 'darwin'})).toBe('full');
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'reduce'}, animations: true, run, platform: 'darwin'})).toBe('reduced');
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: ' OFF '}, animations: true, run, platform: 'linux'})).toBe('off');
    expect(calls).toEqual([]);
    expect(await resolveMotion({env: {BRANCH_REVIEW_MOTION: 'sometimes'}, animations: true, run, platform: 'darwin'})).toBe('reduced');
    expect(calls).toHaveLength(1);
  });

  it('reads the macOS reduce motion setting with /usr/bin/defaults and a 300 ms timeout', async () => {
    const reduced = recordingRun(ON);
    expect(await resolveMotion({env: {}, animations: true, run: reduced.run, platform: 'darwin'})).toBe('reduced');
    expect(reduced.calls).toEqual([{command: '/usr/bin/defaults', args: ['read', 'com.apple.universalaccess', 'reduceMotion'], timeoutMs: 300}]);

    const full = recordingRun(OFF);
    expect(await resolveMotion({env: {}, animations: true, run: full.run, platform: 'darwin'})).toBe('full');
  });

  it('moves fully when the setting is unset, unreadable or slow to answer', async () => {
    // `defaults` exits 1 when the key was never written.
    const unset = recordingRun({ok: false, timedOut: false, reason: 'exit 1'});
    expect(await resolveMotion({env: {}, animations: true, run: unset.run, platform: 'darwin'})).toBe('full');
    const slow = recordingRun({ok: false, timedOut: true, reason: 'timed out'});
    expect(await resolveMotion({env: {}, animations: true, run: slow.run, platform: 'darwin'})).toBe('full');
    const odd = recordingRun({ok: true, stdout: 'yes please\n'});
    expect(await resolveMotion({env: {}, animations: true, run: odd.run, platform: 'darwin'})).toBe('full');
  });

  it('asks nothing over SSH or off macOS, where the setting is not the reader\'s', async () => {
    const {run, calls} = recordingRun(ON);
    expect(await resolveMotion({env: {SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22'}, animations: true, run, platform: 'darwin'})).toBe('full');
    expect(await resolveMotion({env: {}, animations: true, run, platform: 'linux'})).toBe('full');
    expect(calls).toEqual([]);
  });
});
