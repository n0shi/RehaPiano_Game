// localStorage v pamäti pre testy bežiace v Node (bez prehliadača). installMemoryStorage() volať v beforeEach: každý test začne s prázdnym úložiskom.
export function installMemoryStorage() {
  const store = new Map<string, string>();
  const storage = {
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  };
  (globalThis as any).localStorage = storage;
  return store;
}
