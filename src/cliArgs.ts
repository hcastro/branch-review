export type CliOptions = {
  requestedBranch: string;
  requestedBase?: string;
  watch: boolean;
  watchPoll: boolean;
  animations: boolean;
  // Image previews: 'off' from --no-images, 'auto' from --images; unset
  // means auto. Set only when a flag was given.
  images?: 'auto' | 'off';
};

export function parseCliArgs(argv: string[], {interactive}: {interactive: boolean}): CliOptions {
  const positional: string[] = [];
  let watchFlag = false;
  let noWatch = false;
  let watchPoll = false;
  let animations = true;
  let images: CliOptions['images'];

  for (const arg of argv) {
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

  return {
    requestedBranch: positional[0] ?? 'HEAD',
    requestedBase: positional[1],
    watch: noWatch ? false : watchFlag || interactive,
    watchPoll,
    animations,
    ...(images ? {images} : {}),
  };
}
