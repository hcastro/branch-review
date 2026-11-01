import type {Readable, Writable} from 'node:stream';

// The DevTools protocol over Chromium's --remote-debugging-pipe: we write
// commands to its fd 3 and read answers and events from its fd 4, each
// message one JSON object ended by a NUL. No port, no websocket, no
// dependency. Every command has a deadline, so a browser that stops
// answering fails the call instead of holding the job until the worker's
// own deadline kills the worker.

const DEFAULT_TIMEOUT_MS = 5_000;
// The largest message we take: a screenshot of a tall tile is a few MB of
// base64. A peer that sends more without a NUL is not a browser we trust.
const MAX_MESSAGE_CHARS = 64 * 1024 * 1024;

export type CdpFailure = 'timeout' | 'closed' | 'protocol';

export class CdpError extends Error {
  constructor(readonly kind: CdpFailure, message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

type Waiting = {resolve: (result: unknown) => void; reject: (error: Error) => void; cancel: () => void};
type Listener = (params: Record<string, unknown>, sessionId: string | undefined) => void;

export type CdpPipe = {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, options?: {sessionId?: string; timeoutMs?: number}): Promise<T>;
  /** Calls `listener` for each `method` event; returns the call that stops it. */
  on(method: string, listener: Listener): () => void;
  /** Fails every call still waiting and stops reading. */
  close(reason?: string): void;
  /** Settles, with why, once the pipe is closed by either side. */
  closed: Promise<string>;
};

/**
 * `onEnd`: called instead of closing when the peer's side of the pipe ends,
 * for an owner that can say better why (the peer's exit), and closes it.
 */
export function createCdpPipe(readable: Readable, writable: Writable, {timeoutMs = DEFAULT_TIMEOUT_MS, onEnd}: {timeoutMs?: number; onEnd?: () => void} = {}): CdpPipe {
  let buffer = '';
  let next = 0;
  let ended: string | null = null;
  const waiting = new Map<number, Waiting>();
  const listeners = new Map<string, Set<Listener>>();
  let markClosed: (reason: string) => void = () => {};
  const closed = new Promise<string>((resolve) => {
    markClosed = resolve;
  });

  const close = (reason = 'the browser closed its pipe') => {
    if (ended !== null) return;
    ended = reason;
    for (const pending of waiting.values()) {
      pending.cancel();
      pending.reject(new CdpError('closed', reason));
    }
    waiting.clear();
    readable.removeAllListeners('data');
    readable.destroy();
    writable.destroy();
    markClosed(reason);
  };

  const dispatch = (text: string) => {
    let message: {id?: unknown; method?: unknown; params?: unknown; sessionId?: unknown; result?: unknown; error?: {message?: unknown}};
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      close('the browser sent a message that is not JSON');
      return;
    }
    if (typeof message.id === 'number') {
      const pending = waiting.get(message.id);
      if (!pending) return;
      waiting.delete(message.id);
      pending.cancel();
      if (message.error) pending.reject(new CdpError('protocol', String(message.error.message ?? 'the browser refused a command').split('\n')[0]!));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
    const sessionId = typeof message.sessionId === 'string' ? message.sessionId : undefined;
    for (const listener of [...(listeners.get(message.method) ?? [])]) listener(params, sessionId);
  };

  readable.setEncoding('utf8');
  readable.on('data', (chunk: string) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\0'); at >= 0 && ended === null; at = buffer.indexOf('\0')) {
      const text = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      dispatch(text);
    }
    if (buffer.length > MAX_MESSAGE_CHARS) close('the browser sent a message too large to read');
  });
  const end = () => {
    if (ended !== null) return;
    if (onEnd) onEnd();
    else close();
  };
  readable.on('end', end);
  readable.on('error', end);
  writable.on('error', () => close());

  return {
    send<T>(method: string, params: Record<string, unknown> = {}, options: {sessionId?: string; timeoutMs?: number} = {}) {
      return new Promise<T>((resolve, reject) => {
        if (ended !== null) {
          reject(new CdpError('closed', ended));
          return;
        }
        next += 1;
        const id = next;
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new CdpError('timeout', `the browser didn't answer ${method} in time`));
        }, options.timeoutMs ?? timeoutMs);
        timer.unref?.();
        waiting.set(id, {resolve: resolve as (result: unknown) => void, reject, cancel: () => clearTimeout(timer)});
        writable.write(`${JSON.stringify({id, method, params, ...(options.sessionId ? {sessionId: options.sessionId} : {})})}\0`);
      });
    },
    on(method, listener) {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(listener);
      return () => {
        set!.delete(listener);
      };
    },
    close,
    closed,
  };
}
