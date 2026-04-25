export type DebouncedFunction = {
  (): void;
  cancel: () => void;
};

export function debounce(callback: () => void, waitMs: number): DebouncedFunction {
  let timeout: NodeJS.Timeout | null = null;

  const debounced = (() => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      timeout = null;
      callback();
    }, waitMs);
  }) as DebouncedFunction;

  debounced.cancel = () => {
    if (!timeout) return;
    clearTimeout(timeout);
    timeout = null;
  };

  return debounced;
}
