import {spawn} from 'node:child_process';

// Running a short helper program and reading its answer: cmux to place a
// page, `defaults` to read a system setting. Always an absolute program with
// an argument array, never a shell, and never the terminal's stdin. A call
// that outlives its timeout is killed and answers as timed out at once, so
// a hung helper can never hold up a key press. One whose `signal` aborts
// is killed the same way, so nothing it was asked to do happens after the
// app has gone.

export type RunResult = {ok: true; stdout: string} | {ok: false; timedOut: boolean; reason: string};

export type RunTool = (command: string, args: string[], options: {timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal}) => Promise<RunResult>;

// More than any answer these helpers give; past it the call fails.
const MAX_OUTPUT = 64 * 1024;

export const runTool: RunTool = (command, args, {timeoutMs, env, signal}) => new Promise((resolve) => {
  if (signal?.aborted) {
    resolve({ok: false, timedOut: false, reason: 'stopped'});
    return;
  }
  let settled = false;
  const settle = (result: RunResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    resolve(result);
  };

  let child;
  try {
    child = spawn(command, args, {stdio: ['ignore', 'pipe', 'ignore'], ...(env ? {env} : {})});
  } catch (error) {
    resolve({ok: false, timedOut: false, reason: error instanceof Error ? error.message : String(error)});
    return;
  }
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    settle({ok: false, timedOut: true, reason: 'timed out'});
  }, timeoutMs);
  timer.unref();
  const stop = () => {
    child.kill('SIGKILL');
    settle({ok: false, timedOut: false, reason: 'stopped'});
  };
  signal?.addEventListener('abort', stop, {once: true});

  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_OUTPUT) {
      child.kill('SIGKILL');
      settle({ok: false, timedOut: false, reason: 'answer too long'});
    }
  });
  child.on('error', (error) => settle({ok: false, timedOut: false, reason: error.message}));
  child.on('close', (code, signal) => {
    settle(code === 0 ? {ok: true, stdout} : {ok: false, timedOut: false, reason: signal ? `killed by ${signal}` : `exit ${code}`});
  });
});
