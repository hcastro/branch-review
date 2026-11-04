import type {RunTool} from './run.js';

// How much the TUI moves when it throws a page across. A terminal has no
// reduced-motion query, but macOS keeps the setting, and reading it costs
// one short spawn per session. Over SSH the setting on this host isn't the
// reader's, so it is never asked.

export type Motion = 'full' | 'reduced' | 'off';

/**
 * The motion of a session's trips. `usual` is what `r`, `R`, the Review
 * in browser button and Preview play. `loud` is what `!` plays: the full
 * launch and the page's decode, for that one press.
 */
export type MotionLevels = {usual: Motion; loud: Motion};

const DEFAULTS = '/usr/bin/defaults';
const DEFAULTS_TIMEOUT_MS = 300;
const NAMED: Record<string, Motion | undefined> = {full: 'full', reduce: 'reduced', reduced: 'reduced', off: 'off'};

/**
 * `--no-animations` turns motion off. Then `BRANCH_REVIEW_MOTION`
 * (`full`, `reduce` or `off`) sets both levels, then the macOS Reduce
 * motion setting, which holds `!` to the reduced motion as well. With
 * none of them, trips are quiet (`reduced`) and `!` plays the full one.
 * A setting that is unset, unreadable or slower than 300 ms counts as off.
 */
export async function resolveMotion({env, animations, run, platform}: {
  env: NodeJS.ProcessEnv;
  animations: boolean;
  run: RunTool;
  platform: NodeJS.Platform;
}): Promise<MotionLevels> {
  if (!animations) return {usual: 'off', loud: 'off'};
  const named = NAMED[(env.BRANCH_REVIEW_MOTION ?? '').trim().toLowerCase()];
  if (named) return {usual: named, loud: named};
  const quiet: MotionLevels = {usual: 'reduced', loud: 'full'};
  if (platform !== 'darwin' || env.SSH_CONNECTION) return quiet;
  const answer = await run(DEFAULTS, ['read', 'com.apple.universalaccess', 'reduceMotion'], {timeoutMs: DEFAULTS_TIMEOUT_MS, env});
  return answer.ok && answer.stdout.trim() === '1' ? {usual: 'reduced', loud: 'reduced'} : quiet;
}
