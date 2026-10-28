const ENTER_SEQUENCE = '\x1B[?1049h\x1B[H';

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

type TerminalSessionOptions = {
  stdout: {isTTY?: boolean; write(text: string): unknown};
  stderr: {write(text: string): unknown};
  proc?: ProcessLike;
};

export type TerminalSession = ReturnType<typeof createTerminalSession>;

function oneLine(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] || 'unknown error';
}

/**
 * Owns the alt screen. `restore` is synchronous and idempotent, and runs on
 * normal exit, SIGINT, SIGTERM and fatal errors, so the terminal is never left
 * in the alt screen with mouse tracking on. Ink is unmounted first, so its
 * final frame lands on the alt screen instead of the user's main screen.
 */
export function createTerminalSession({stdout, stderr, proc = process}: TerminalSessionOptions) {
  let active = false;
  let unmount: (() => void) | null = null;

  const restore = () => {
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
  };

  const report = (error: unknown) => {
    restore();
    stderr.write(`branch-review: ${oneLine(error)}\n`);
  };

  return {
    enter() {
      if (stdout.isTTY && !active) {
        stdout.write(ENTER_SEQUENCE);
        active = true;
      }
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

/**
 * Enters the alt screen, mounts the app and waits for it to exit. A throw on
 * first mount or a render error after it restores the terminal, prints one
 * line and sets exit code 1.
 */
export async function runInkApp(session: TerminalSession, mount: () => InkInstance) {
  session.enter();

  let instance: InkInstance;
  try {
    instance = mount();
  } catch (error) {
    session.fail(error);
    return;
  }

  session.setUnmount(() => instance.unmount());
  try {
    await instance.waitUntilExit();
    session.restore();
  } catch (error) {
    session.fail(error);
  }
}
