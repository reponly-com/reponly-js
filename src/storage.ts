/** Where the SDK keeps the customer token and automatic-message state. */
export type TokenStorage = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
};

export const memoryStorage = (): TokenStorage => {
  const map = new Map<string, string>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    remove: (k) => void map.delete(k),
  };
};

function localStorageOrMemory(): TokenStorage {
  try {
    const probe = "__reponly_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return {
      get: (k) => window.localStorage.getItem(k),
      set: (k, v) => window.localStorage.setItem(k, v),
      remove: (k) => window.localStorage.removeItem(k),
    };
  } catch {
    return memoryStorage();
  }
}

/** localStorage in a browser (in-memory if it's blocked), in-memory elsewhere. */
export const defaultStorage = (): TokenStorage =>
  typeof window !== "undefined" ? localStorageOrMemory() : memoryStorage();
