import path from 'node:path';
import React from 'react';
import {parseCliArgs, type CliOptions} from './cliArgs.js';
import {AbortedError, InterruptedError, getRepoRoot, inferBaseRefAsync, removePrivateIndexDirs, resolveRefs} from './git.js';
import {refreshReview} from './review/build.js';
import {escapeHiddenCharacters} from './controlChars.js';
import {ReviewController, getModelWidth} from './ui/ReviewController.js';
import {INK_RENDER_OPTIONS, createTerminalSession, runInkApp} from './terminalSession.js';
import {queryTmuxClient, startGraphicsDetection, type TmuxClient, type TtyInput} from './media/detect.js';
import type {GraphicsCaps} from './media/types.js';
import {tmuxPassthrough} from './media/kitty.js';
import {createMediaService, type MediaService} from './media/service.js';
import {createImageRegistry, type ImageRegistry} from './media/imageRegistry.js';
import {createWorkerBackend} from './media/workerClient.js';
import {claimKittyTmux, createMediaTempDir, sweepStaleMediaDirs} from './media/tempDir.js';
import {defaultOpener, type Opener} from './media/openExternal.js';

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
  // The terminal's input, read once before the UI mounts to ask what it can
  // draw. Without it the app draws no media.
  stdin?: TtyInput;
  stdout: {isTTY?: boolean; columns?: number; rows?: number; write(text: string, done?: () => void): unknown};
  stderr: {write(text: string): unknown};
  render: (tree: React.ReactElement, options: typeof INK_RENDER_OPTIONS) => InkInstance;
  env?: NodeJS.ProcessEnv;
  // Under tmux, which terminal the attached client runs in. By default tmux
  // is asked; tests answer in its place.
  queryTmuxClient?: () => Promise<TmuxClient | null>;
  // What opens a file or page outside the terminal: a player, a viewer, the
  // default browser. Tests record it in place of opening anything.
  opener?: Opener;
};

const SIGNAL_EXIT_CODES: Record<string, number> = {SIGHUP: 129, SIGINT: 130, SIGTERM: 143};

type SessionLike = ReturnType<typeof createTerminalSession>;

const TMUX_SHARED_NOTICE = 'another branch-review draws images in this tmux server · block previews here';

/**
 * The media service for a terminal that draws Kitty images or block
 * previews, with its exit work in place: the restore write deletes every
 * image sent (none for blocks), before the alt screen is left, and the exit
 * hooks kill the media worker and remove the session's temp dir. Nothing is
 * sent before the UI enters the alt screen.
 */
function startMedia({caps: detected, cwd, env, proc, session, tempDir, watching, animations, opener}: {caps: GraphicsCaps; cwd: string; env: NodeJS.ProcessEnv; proc: CliProcess; session: SessionLike; tempDir: SessionDir; watching: boolean; animations: boolean; opener: Opener}): {media: MediaService; caps: GraphicsCaps; registry: ImageRegistry} {
  // Every pane of a tmux server draws on the one outer terminal and its one
  // table of image ids, so only the first session there draws Kitty images.
  let caps = detected;
  const notices: string[] = [];
  if (caps.tmux && caps.protocol === 'kitty' && env.TMUX) {
    let claimed = false;
    try {
      claimed = claimKittyTmux(tempDir.get(), env.TMUX, {env});
    } catch {
      // No session dir to claim from: blocks, which need none.
    }
    if (!claimed) {
      caps = {...caps, protocol: 'blocks'};
      notices.push(TMUX_SHARED_NOTICE);
    }
  }
  const backend = createWorkerBackend({tempDir: tempDir.get, env, cwd});
  // Inside tmux every graphics command, the exit deletes too, goes through
  // passthrough to the outer terminal.
  const forTerminal = (sequence: string) => (caps.tmux ? tmuxPassthrough(sequence) : sequence);
  // One table of image ids for media previews and the in-pane rendered
  // view, so the exit write below deletes both.
  const registry = createImageRegistry({write: (sequence) => session.writeGraphics(forTerminal(sequence))});
  const media = createMediaService({
    caps,
    backend,
    sink: {write: (sequence) => session.writeGraphics(forTerminal(sequence))},
    imageRegistry: registry,
    tempDir: tempDir.get,
    opener,
    env,
    watching,
    animations,
    notices,
  });
  session.setRestorePrefix(() => forTerminal(media.restoreSequence()));
  proc.on('exit', () => media.dispose());
  return {media, caps, registry};
}

type SessionDir = ReturnType<typeof createMediaTempDir>;

async function writeRenderedPages({cwd, startDir, range, review, outLabel, json, stdout, stderr, proc}: {
  cwd: string;
  startDir: string;
  range: Awaited<ReturnType<typeof prepareStartup>>['range'];
  review: Awaited<ReturnType<typeof prepareStartup>>['review'];
  outLabel: string;
  json: boolean;
  stdout: CliIo['stdout'];
  stderr: CliIo['stderr'];
  proc: CliProcess;
}) {
  // Relative to where the command was typed, as any path argument is.
  const outDir = path.resolve(startDir, outLabel);
  try {
    // Loaded only here: the renderer and its parsers stay out of the UI's
    // startup.
    const {formatRenderOutJson, formatRenderOutSummary, renderToDirectory} = await import('./rendered/renderOut.js');
    const report = await renderToDirectory({cwd, range, review, outDir, outLabel, now: Date.now});
    const text = json ? formatRenderOutJson(report) : formatRenderOutSummary(report, outLabel);
    // A pipe on macOS takes a large write in pieces, after the call returns;
    // exiting before the last piece is out would cut the report short.
    await new Promise<void>((resolve) => {
      stdout.write(text, () => resolve());
    });
    proc.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`branch-review: ${escapeHiddenCharacters(message.split('\n')[0] || 'unknown error')}\n`);
    proc.exit(1);
  }
}

/**
 * The whole CLI run: parse arguments, build the first review and run the UI.
 * The restore and cleanup handlers go in before the startup build, and the
 * build leaves the event loop free, so a signal during it exits at once: the
 * exit hooks kill the git or delta the build is running, remove the private
 * index copy, and the UI is never mounted.
 */
export async function runCli(io: CliIo) {
  const {argv, cwd: startDir, proc, stdin, stdout, stderr, render, env = process.env, opener = defaultOpener} = io;
  let options: CliOptions;
  try {
    options = parseCliArgs(argv, {interactive: Boolean(stdout.isTTY)});
  } catch (error) {
    stderr.write(`branch-review: ${error instanceof Error ? error.message : String(error)}\n`);
    proc.exit(1);
    return;
  }
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

  // Headless: the pages and the report, then exit. The terminal is never
  // asked anything and never drawn on, so stdout carries only the report.
  if (options.renderOut !== undefined) {
    await writeRenderedPages({cwd, startDir, range, review, outLabel: options.renderOut, json: options.json ?? false, stdout, stderr, proc});
    return;
  }

  if (!options.watch && review.files.length === 0) {
    // Ref names come from the repo.
    stdout.write(`No file changes between ${escapeHiddenCharacters(range.base)} and ${escapeHiddenCharacters(range.branch)}.\n`);
    proc.exit(0);
    return;
  }

  // Loaded while the terminal answers, so it adds nothing to startup: the
  // service is small, and its renderer loads only in its own worker. A
  // module that fails to load leaves the app as it is without the view.
  const loadingRendered = import('./rendered/service.js').catch(() => null);

  // Asks the terminal what it can draw once the UI is sure to mount. Raw
  // mode moves keys typed ahead out of the terminal into this process, so
  // asking during the build would swallow them on the exits above, which
  // leave them to the shell. Raw mode also turns Ctrl-C into a byte, so the
  // window handles it the way SIGINT would.
  const detection = startGraphicsDetection({
    stdin,
    stdout,
    env,
    options: {images: options.images ?? 'auto'},
    queryTmuxClient: io.queryTmuxClient ?? (() => queryTmuxClient(env, cwd)),
    onInterrupt: () => {
      session.restore();
      proc.exit(130);
    },
  });
  proc.on('exit', detection.cancel);

  // Settles at the terminal's last reply, usually within milliseconds, or a
  // short timeout. The answer also lets the UI tell late replies from keys.
  const caps = await detection.result;
  // Ctrl-C during the window, or a signal, has already exited.
  if (startupBuild.signal.aborted) return;
  const {keys, replyHead} = detection.handOff();
  // One session dir for media and the rendered view, made when either first
  // needs it and removed at exit. Dirs that dead sessions left behind are
  // swept first: at once when media starts, else when the dir is first made.
  const tempDir = createMediaTempDir({env});
  let swept = false;
  const sweepOnce = () => {
    if (swept) return;
    swept = true;
    sweepStaleMediaDirs({env});
  };
  // Kitty terminals draw pictures and other color terminals block previews;
  // with no graphics the app is exactly as it is without media.
  if (caps.protocol !== 'none') sweepOnce();
  const started = caps.protocol !== 'none' ? startMedia({caps, cwd, env, proc, session, tempDir, watching: options.watch, animations: options.animations, opener}) : undefined;
  // The rendered view needs no graphics: its pages open in a browser.
  const renderedModule = await loadingRendered;
  // Pages in the diff pane are Kitty images, from the media previews' ids.
  const pane = started && started.caps.protocol === 'kitty' ? {registry: started.registry, caps: started.caps} : undefined;
  const rendered = renderedModule?.startRenderedService({tempDir: () => {
    sweepOnce();
    return tempDir.get();
  }, env, cwd, animations: options.animations, opener, colors: {...(caps.fg ? {fg: caps.fg} : {}), ...(caps.bg ? {bg: caps.bg} : {})}, ...(pane ? {pane} : {})});
  proc.on('exit', () => rendered?.dispose());
  proc.on('exit', tempDir.remove);
  const media = started?.media;
  const drawCaps = started?.caps ?? caps;
  const graphics = replyHead ? {...drawCaps, replyHead, ...(keys ? {keysBeforeReply: keys} : {})} : drawCaps;

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
      graphics,
      ...(media ? {media} : {}),
      ...(rendered ? {rendered} : {}),
      requestedBranch,
      requestedBase,
    }),
  ), INK_RENDER_OPTIONS));
  // The UI is gone and the terminal restored. On q nothing calls exit: the
  // process ends once its event loop drains, so the worker is stopped here
  // rather than left to its idle timer.
  media?.dispose();
  rendered?.dispose();
}
