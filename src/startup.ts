import React from 'react';
import {parseCliArgs, type CliOptions} from './cliArgs.js';
import {AbortedError, InterruptedError, getRepoRoot, inferBaseRefAsync, removePrivateIndexDirs, resolveRefs} from './git.js';
import {refreshReview} from './review/build.js';
import {escapeHiddenCharacters} from './controlChars.js';
import {ReviewController, getModelWidth} from './ui/ReviewController.js';
import {INK_RENDER_OPTIONS, createTerminalSession, runInkApp} from './terminalSession.js';

type PrepareStartupOptions = {
  /** Where the CLI was started; any directory inside the work tree. */
  cwd: string;
  options: CliOptions;
  width: number;
  /** Aborting kills the git or delta the build is running and rejects with AbortedError. */
  signal?: AbortSignal;
};

/**
 * Resolves the repo and range and builds the first review, with
 * asynchronous git and delta calls so signal handlers can run during the
 * build. Throws with a one-line message when there is no repo, no git, or no
 * such ref.
 */
export async function prepareStartup({cwd: startDir, options, width, signal}: PrepareStartupOptions) {
  // git reports paths relative to the work tree root, so every git call, file
  // read, watcher and worker runs there, whichever subdirectory we started in.
  const cwd = getRepoRoot(startDir);
  const requestedBranch = options.requestedBranch;
  const requestedBase = options.requestedBase ?? await inferBaseRefAsync(cwd, {signal});
  const resolveRange = () => resolveRefs(cwd, requestedBranch, requestedBase);

  // The fingerprint is taken before the build reads any diff: a write that
  // lands during the build then makes the first watch refresh see a changed
  // fingerprint and rebuild, instead of skipping as unchanged while the view
  // misses the write.
  const {range, fingerprint, review} = await refreshReview({
    cwd,
    requestedBranch,
    requestedBase,
    width,
    previousFingerprint: null,
    signal,
  });

  return {
    cwd,
    range,
    resolveRange,
    // Always built: no fingerprint equals null.
    review: review!,
    initialFingerprint: options.watch ? fingerprint : undefined,
    requestedBranch,
    requestedBase,
  };
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
 * The restore and cleanup handlers go in before the startup build, and the
 * build leaves the event loop free, so a signal during it exits at once: the
 * exit hooks kill the git or delta the build is running, remove the private
 * index copy, and the UI is never mounted.
 */
export async function runCli({argv, cwd: startDir, proc, stdout, stderr, render}: CliIo) {
  const options = parseCliArgs(argv, {interactive: Boolean(stdout.isTTY)});
  const terminalWidth = stdout.columns ?? 160;

  const session = createTerminalSession({stdout, stderr, proc});
  session.install();
  const startupBuild = new AbortController();
  // Before the index cleanup, so git is killed before its index copy goes.
  proc.on('exit', () => startupBuild.abort());
  proc.on('exit', removePrivateIndexDirs);

  let startup: Awaited<ReturnType<typeof prepareStartup>>;
  try {
    startup = await prepareStartup({cwd: startDir, options, width: getModelWidth(terminalWidth), signal: startupBuild.signal});
  } catch (error) {
    // A signal handler has already exited; nothing is left to report.
    if (error instanceof AbortedError || startupBuild.signal.aborted) return;
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
    // Ref names come from the repo.
    stdout.write(`No file changes between ${escapeHiddenCharacters(range.base)} and ${escapeHiddenCharacters(range.branch)}.\n`);
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
