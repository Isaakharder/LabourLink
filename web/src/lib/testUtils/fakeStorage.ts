// Minimal in-memory Storage implementation for unit tests — avoids relying
// on Node's flag-gated --experimental-webstorage global (which needs a real
// backing file and isn't available without extra flags) or pulling in
// jsdom just to get a working `localStorage`. Good enough for anything that
// only calls getItem/setItem/removeItem, which is everything device.ts uses.
export function createFakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
}
