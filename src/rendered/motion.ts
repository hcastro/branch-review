import type {RunTool} from './run.js';

// How much the TUI moves when it throws a page across. A terminal has no
// reduced-motion query, but macOS keeps the setting, and reading it costs
// one short spawn per session. Over SSH the setting on this host isn't the
// reader's, so it is never asked.

export type Motion = 'full' | 'reduced' | 'off';

const DEFAULTS = '/usr/bin/defaults';
const DEFAULTS_TIMEOUT_MS = 300;
const NAMED: Record<string, Motion | undefined> = {full: 'full', reduce: 'reduced', reduced: 'reduced', off: 'off'};

/**
 * `--no-animations` turns motion off. Then `BRANCH_REVIEW_MOTION`
 * (`full`, `reduce` or `off`) decides, then the macOS setting. A setting
 * that is unset, unreadable or slower than 300 ms means full motion.
 */
export async function resolveMotion({env, animations, run, platform}: {
  env: NodeJS.ProcessEnv;
  animations: boolean;
  run: RunTool;
  platform: NodeJS.Platform;
}): Promise<Motion> {
  if (!animations) return 'off';
  const named = NAMED[(env.BRANCH_REVIEW_MOTION ?? '').trim().toLowerCase()];
  if (named) return named;
  if (platform !== 'darwin' || env.SSH_CONNECTION) return 'full';
  const answer = await run(DEFAULTS, ['read', 'com.apple.universalaccess', 'reduceMotion'], {timeoutMs: DEFAULTS_TIMEOUT_MS, env});
  return answer.ok && answer.stdout.trim() === '1' ? 'reduced' : 'full';
}
