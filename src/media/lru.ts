// A least-recently-used map bounded by the total weight of its values (bytes,
// usually), so caches of image bytes stay within a memory budget whatever the
// sizes of the images in them.

export type Lru<V> = {
  get(key: string): V | undefined;
  set(key: string, value: V): void;
  delete(key: string): void;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  readonly weight: number;
};

export function createLru<V>(maxWeight: number, weigh: (value: V) => number): Lru<V> {
  // A Map keeps insertion order, so re-inserting on use keeps the least
  // recently used entry first.
  const entries = new Map<string, {value: V; weight: number}>();
  let total = 0;

  const remove = (key: string) => {
    const entry = entries.get(key);
    if (!entry) return;
    entries.delete(key);
    total -= entry.weight;
  };

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    set(key, value) {
      remove(key);
      const weight = weigh(value);
      // A value larger than the whole budget is not kept at all.
      if (weight > maxWeight) return;
      entries.set(key, {value, weight});
      total += weight;
      for (const oldest of entries.keys()) {
        if (total <= maxWeight) break;
        remove(oldest);
      }
    },
    delete: remove,
    has: (key) => entries.has(key),
    keys: () => entries.keys(),
    get weight() {
      return total;
    },
  };
}
