export type CliOptions = {
  requestedBranch: string;
  requestedBase?: string;
  watch: boolean;
  watchPoll: boolean;
  animations: boolean;
  // Image previews: 'off' from --no-images, 'auto' from --images; unset
  // means auto. Set only when a flag was given.
  images?: 'auto' | 'off';
  // --export-html <dir>: write the pages that Review in browser opens there
  // and exit, with no UI. Set only when given, as is --json, which prints the report as JSON.
  renderOut?: string;
  json?: boolean;
  // --browser: build the Review in browser page, open it where `r` would,
  // and exit, with no UI. Set only when given.
  browser?: true;
};

const RENDER_OUT = '--export-html';
const NEEDS_DIRECTORY = '--export-html needs a directory, for example --export-html ./pages';

/**
 * The options in `argv`. Throws with a one-line usage message for a
 * `--export-html` with no directory, or a `--json` without one.
 */
export function parseCliArgs(argv: string[], {interactive}: {interactive: boolean}): CliOptions {
  const positional: string[] = [];
  let watchFlag = false;
  let noWatch = false;
  let watchPoll = false;
  let animations = true;
  let images: CliOptions['images'];
  let renderOut: string | undefined;
  let json = false;
  let browser = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === RENDER_OUT || arg.startsWith(`${RENDER_OUT}=`)) {
      const value = arg === RENDER_OUT ? argv[++index] : arg.slice(RENDER_OUT.length + 1);
      if (!value || value.startsWith('--')) throw new Error(NEEDS_DIRECTORY);
      renderOut = value;
      continue;
    }

    if (arg === '--browser') {
      browser = true;
      continue;
    }

    if (arg === '--json') {
      json = true;
      continue;
    }

    if (arg === '--watch') {
      watchFlag = true;
      continue;
    }

    if (arg === '--no-watch') {
      noWatch = true;
      continue;
    }

    if (arg === '--watch-poll') {
      watchFlag = true;
      watchPoll = true;
      continue;
    }

    if (arg === '--animations') {
      animations = true;
      continue;
    }

    if (arg === '--no-animations') {
      animations = false;
      continue;
    }

    if (arg === '--images') {
      images = 'auto';
      continue;
    }

    if (arg === '--no-images') {
      images = 'off';
      continue;
    }

    positional.push(arg);
  }

  if (json && renderOut === undefined) throw new Error('--json works only with --export-html');
  if (browser && renderOut !== undefined) throw new Error('--browser opens the page and --export-html writes it to a directory · pick one');
  if (browser && (watchFlag || watchPoll)) throw new Error('--browser opens one snapshot of the review · --watch works only in the terminal UI');

  return {
    requestedBranch: positional[0] ?? 'HEAD',
    requestedBase: positional[1],
    // Headless output is one snapshot.
    watch: noWatch || browser || renderOut !== undefined ? false : watchFlag || interactive,
    watchPoll,
    animations,
    ...(images ? {images} : {}),
    ...(renderOut === undefined ? {} : {renderOut}),
    ...(json ? {json} : {}),
    ...(browser ? {browser: true as const} : {}),
  };
}
