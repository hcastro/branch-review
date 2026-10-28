import React from 'react';
import {format} from 'node:util';
import {escapeHiddenCharactersInLines} from './controlChars.js';

const ENTER_SEQUENCE = '\x1B[?1049h\x1B[H';

/**
 * Options for Ink's render. Ink's console patch would write console output
 * into the frame stream raw; the session captures the console instead.
 */
export const INK_RENDER_OPTIONS = {patchConsole: false} as const;

/**
 * Turns off every mouse tracking mode a mouse library may have enabled
 * (X10/normal, button, any-motion, SGR, urxvt), shows the cursor, and leaves
 * the alt screen, in that order.
 */
export const TERMINAL_RESTORE_SEQUENCE = [
  '\x1B[?1000l',
  '\x1B[?1002l',
  '\x1B[?1003l',
  '\x1B[?1006l',
  '\x1B[?1015l',
  '\x1B[?25h',
  '\x1B[?1049l',
].join('');

type ProcessLike = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): unknown;
  exitCode?: number | string | undefined;
};

type ConsoleLike = Pick<Console, 'log' | 'info' | 'debug' | 'warn' | 'error'>;

type TerminalSessionOptions = {
  stdout: {isTTY?: boolean; write(text: string): unknown};
  stderr: {write(text: string): unknown};
  proc?: ProcessLike;
  console?: ConsoleLike;
};

const CAPTURED_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;
// Enough to keep a burst of warnings without letting a logging loop grow
// memory for the whole session.
const MAX_CAPTURED_MESSAGES = 200;

export type TerminalSession = ReturnType<typeof createTerminalSession>;

function oneLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return escapeHiddenCharactersInLines(message.split('\n')[0] || 'unknown error');
}

// React reports each error a boundary catches with this text (the error
// itself is reported separately in production builds). Ink drops it too.
function isReactBoundaryReport(args: unknown[]) {
  return typeof args[0] === 'string' && args[0].startsWith('The above error occurred');
}

/**
 * Owns the alt screen. `restore` is synchronous and idempotent, and runs on
 * normal exit, SIGINT, SIGTERM, SIGHUP and fatal errors, so the terminal is
 * never left in the alt screen with mouse tracking on. Ink is unmounted first,
 * so its final frame lands on the alt screen instead of the user's main
 * screen.
 *
 * While the session runs, console output never reaches the terminal: it would
 * land in the middle of the UI with any control characters it holds. It is
 * kept and written to stderr, escaped, once the terminal is restored.
 */
export function createTerminalSession({stdout, stderr, proc = process, console: target = console}: TerminalSessionOptions) {
  let active = false;
  let unmount: (() => void) | null = null;
  let captured: Array<{args: unknown[]}> = [];
  let dropped = 0;
  let originals: Partial<ConsoleLike> | null = null;

  const captureConsole = () => {
    if (originals) return;
    originals = {};
    for (const method of CAPTURED_METHODS) {
      originals[method] = target[method];
      target[method] = (...args: unknown[]) => {
        if (isReactBoundaryReport(args)) return;
        if (captured.length >= MAX_CAPTURED_MESSAGES) dropped += 1;
        else captured.push({args});
      };
    }
  };

  // Puts the console back and writes what it captured, skipping the error
  // the session itself is about to report.
  const releaseConsole = (reported?: unknown) => {
    if (!originals) return;
    Object.assign(target, originals);
    originals = null;
    const messages = captured.filter(({args}) => !(reported !== undefined && args.length === 1 && args[0] === reported));
    captured = [];
    for (const {args} of messages) {
      stderr.write(`${escapeHiddenCharactersInLines(format(...args)).replace(/\n?$/, '\n')}`);
    }
    if (dropped > 0) stderr.write(`(${dropped} more console messages dropped)\n`);
    dropped = 0;
  };

  const restoreTerminal = (reported?: unknown) => {
    const pendingUnmount = unmount;
    unmount = null;
    if (pendingUnmount) {
      try {
        pendingUnmount();
      } catch {
        // The terminal still has to be restored.
      }
    }

    if (active) {
      active = false;
      stdout.write(TERMINAL_RESTORE_SEQUENCE);
    }
    releaseConsole(reported);
  };

  const restore = () => restoreTerminal();

  const report = (error: unknown) => {
    restoreTerminal(error);
    stderr.write(`branch-review: ${oneLine(error)}\n`);
  };

  return {
    enter() {
      if (stdout.isTTY && !active) {
        stdout.write(ENTER_SEQUENCE);
        active = true;
      }
      captureConsole();
    },
    setUnmount(next: () => void) {
      unmount = next;
    },
    restore,
    /** Restores the terminal, prints one line, and sets exit code 1. */
    fail(error: unknown) {
      report(error);
      proc.exitCode = 1;
    },
    install() {
      proc.on('exit', restore);
      proc.on('SIGINT', () => {
        restore();
        proc.exit(130);
      });
      proc.on('SIGTERM', () => {
        restore();
        proc.exit(143);
      });
      // Closing the terminal window. Without a handler Node dies without an
      // `exit` event, so exit hooks (child kill, temp cleanup) would not run.
      proc.on('SIGHUP', () => {
        restore();
        proc.exit(129);
      });
      const fatal = (error: unknown) => {
        report(error);
        proc.exit(1);
      };
      proc.on('uncaughtException', fatal);
      proc.on('unhandledRejection', fatal);
    },
  };
}

type InkInstance = {waitUntilExit(): Promise<unknown>; unmount(): void};

/** Wraps the app's root element so a render error reaches the session. */
export type RenderGuard = (node: React.ReactNode) => React.ReactElement;

type RootBoundaryProps = {onError: (error: unknown) => void; children?: React.ReactNode};

// Catches a render error anywhere below the root. Ink's own boundary would
// end the app through a promise that, on the first render, nobody is waiting
// on yet, so the process would exit 0 with nothing on stderr.
class RootErrorBoundary extends React.Component<RootBoundaryProps, {failed: boolean}> {
  override state = {failed: false};

  static getDerivedStateFromError() {
    return {failed: true};
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Enters the alt screen, mounts the app and waits for it to exit. A throw on
 * first mount, or a render error during or after it, restores the terminal,
 * prints one line and sets exit code 1.
 */
export async function runInkApp(session: TerminalSession, mount: (guard: RenderGuard) => InkInstance) {
  session.enter();

  let instance: InkInstance | null = null;
  let firstRenderError: {error: unknown} | null = null;
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    session.fail(error);
  };
  const onRenderError = (error: unknown) => {
    // After mount the boundary reports from inside React's commit; unmounting
    // there would leave part of Ink's teardown until after the restore.
    if (instance) queueMicrotask(() => fail(error));
    else firstRenderError ??= {error};
  };
  const guard: RenderGuard = (node) => React.createElement(RootErrorBoundary, {onError: onRenderError}, node);

  try {
    instance = mount(guard);
  } catch (error) {
    fail(error);
    return;
  }

  const mounted = instance;
  session.setUnmount(() => mounted.unmount());
  // Set by the boundary during mount(), which TypeScript can't see.
  const pending = firstRenderError as {error: unknown} | null;
  if (pending) {
    fail(pending.error);
    return;
  }

  try {
    await mounted.waitUntilExit();
    session.restore();
  } catch (error) {
    fail(error);
  }
}
