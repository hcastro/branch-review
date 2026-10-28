import {useEffect, useState} from 'react';

// `value` once it has held still for `delayMs`. The first value is returned
// at once; a burst of changes (a drag-resize sends one per column) costs one
// update after the last of them.
export function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (Object.is(settled, value)) return undefined;
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs, settled, value]);

  return settled;
}
