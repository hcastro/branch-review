export type DebouncedFunction = {
  (): void;
  cancel: () => void;
};

export type DebounceOptions = {
  /**
   * Longest a call may wait while new calls keep arriving. Without it a
   * steady stream of calls spaced closer than `waitMs` never fires.
   */
  maxWaitMs?: number;
};

export function debounce(callback: () => void, waitMs: number, {maxWaitMs}: DebounceOptions = {}): DebouncedFunction {
  let timeout: NodeJS.Timeout | null = null;
  let firstCallAt: number | null = null;

  const fire = () => {
    timeout = null;
    firstCallAt = null;
    callback();
  };

  const debounced = (() => {
    const now = Date.now();
    firstCallAt ??= now;
    if (timeout) {
      clearTimeout(timeout);
    }

    const delay = maxWaitMs === undefined
      ? waitMs
      : Math.max(0, Math.min(waitMs, firstCallAt + maxWaitMs - now));
    timeout = setTimeout(fire, delay);
  }) as DebouncedFunction;

  debounced.cancel = () => {
    firstCallAt = null;
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = null;
  };

  return debounced;
}
