import React from 'react';
import {parseCliArgs, type CliOptions} from './cliArgs.js';
import {InterruptedError, getRepoRoot, getReviewFingerprint, inferBaseRef, removePrivateIndexDirs, resolveRefs} from './git.js';
import {buildReviewModel} from './review/build.js';
import {escapeHiddenCharacters} from './controlChars.js';
import {ReviewController, getModelWidth} from './ui/ReviewController.js';
import {INK_RENDER_OPTIONS, createTerminalSession, runInkApp} from './terminalSession.js';

type PrepareStartupOptions = {
  /** Where the CLI was started; any directory inside the work tree. */
  cwd: string;
  options: CliOptions;
  width: number;
  buildReview?: typeof buildReviewModel;
};

/**
 * Resolves the repo and range and builds the first review. Throws with a
 * one-line message when there is no repo, no git, or no such ref.
 */
export function prepareStartup({cwd: startDir, options, width, buildReview = buildReviewModel}: PrepareStartupOptions) {
  // git reports paths relative to the work tree root, so every git call, file
  // read, watcher and worker runs there, whichever subdirectory we started in.
  const cwd = getRepoRoot(startDir);
  const requestedBranch = options.requestedBranch;
  const requestedBase = options.requestedBase ?? inferBaseRef(cwd);
  const resolveRange = () => resolveRefs(cwd, requestedBranch, requestedBase);
  const range = resolveRange();

  // Taken before the build: a write that lands during the build then makes the
  // first watch refresh see a changed fingerprint and rebuild, instead of
  // skipping as unchanged while the view misses the write.
  const initialFingerprint = options.watch ? getReviewFingerprint(cwd, range) : undefined;
  const review = buildReview({cwd, range, width});

  return {cwd, range, resolveRange, review, initialFingerprint, requestedBranch, requestedBase};
}

type CliProcess = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
  exitCode?: number | string | undefined;
};

type InkInstance = {waitUntilExit(): Promise<unknown>; unmount(): void};

export type CliIo = {
  argv: string[];
  /** Where the CLI was started. */
  cwd: string;
  proc: CliProcess;
  stdout: {isTTY?: boolean; columns?: number; write(text: string): unknown};
  stderr: {write(text: string): unknown};
  render: (tree: React.ReactElement, options: typeof INK_RENDER_OPTIONS) => InkInstance;
};

const SIGNAL_EXIT_CODES: Record<string, number> = {SIGHUP: 129, SIGINT: 130, SIGTERM: 143};

/**
 * The whole CLI run: parse arguments, build the first review and run the UI.
 * The restore and cleanup handlers go in before the startup build, so a
 * signal during it still restores the terminal and removes the private index
 * copy.
 */
export async function runCli({argv, cwd: startDir, proc, stdout, stderr, render}: CliIo) {
  const options = parseCliArgs(argv, {interactive: Boolean(stdout.isTTY)});
  const terminalWidth = stdout.columns ?? 160;

  const session = createTerminalSession({stdout, stderr, proc});
  session.install();
  proc.on('exit', removePrivateIndexDirs);

  let startup: ReturnType<typeof prepareStartup>;
  try {
    startup = prepareStartup({cwd: startDir, options, width: getModelWidth(terminalWidth)});
  } catch (error) {
    // Ctrl-C or a closed terminal stopped git mid-build: exit the way the
    // signal would have, without an error line.
    if (error instanceof InterruptedError) {
      proc.exit(SIGNAL_EXIT_CODES[error.signal] ?? 1);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    // Ref names and paths in the message come from the repo.
    stderr.write(`branch-review: ${escapeHiddenCharacters(message.split('\n')[0] || 'unknown error')}\n`);
    proc.exit(1);
    return;
  }

  const {cwd, range, resolveRange, review, initialFingerprint, requestedBranch, requestedBase} = startup;

  if (!options.watch && review.files.length === 0) {
    stdout.write(`No file changes between ${range.base} and ${range.branch}.\n`);
    proc.exit(0);
    return;
  }

  await runInkApp(session, (guard) => render(guard(
    React.createElement(ReviewController, {
      cwd,
      range,
      resolveRange,
      initialReview: review,
      initialFingerprint,
      watch: options.watch,
      watchPoll: options.watchPoll,
      animations: options.animations,
      requestedBranch,
      requestedBase,
    }),
  ), INK_RENDER_OPTIONS));
}
