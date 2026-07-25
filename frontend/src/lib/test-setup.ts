import { beforeEach } from "vitest";

const storage = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
  writable: true,
});

// Define window so typeof window !== "undefined" guards pass in tests
if (typeof globalThis.window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}
if (typeof (globalThis.window as { location?: unknown }).location === "undefined") {
  (globalThis.window as unknown as Record<string, unknown>).location = {
    origin: "https://dshield.test",
    hash: "",
    pathname: "/",
    search: "",
  };
}

if (typeof (globalThis.window as unknown as Record<string, unknown>).addEventListener === "undefined") {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  (globalThis.window as unknown as Record<string, unknown>).addEventListener = (
    type: string,
    cb: (e: unknown) => void,
  ) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  };
  (globalThis.window as unknown as Record<string, unknown>).removeEventListener = (
    type: string,
    cb: (e: unknown) => void,
  ) => {
    listeners.get(type)?.delete(cb);
  };
  (globalThis.window as unknown as Record<string, unknown>).dispatchEvent = (
    event: { type: string },
  ) => {
    const set = listeners.get(event.type);
    if (set) {
      for (const cb of Array.from(set)) cb(event);
    }
    return true;
  };
}

if (typeof (globalThis as unknown as Record<string, unknown>).StorageEvent === "undefined") {
  (globalThis as unknown as Record<string, unknown>).StorageEvent = class StorageEvent {
    type: string;
    key: string | null;
    newValue: string | null;
    oldValue: string | null;
    constructor(
      type: string,
      dict?: { key?: string; newValue?: string; oldValue?: string },
    ) {
      this.type = type;
      this.key = dict?.key ?? null;
      this.newValue = dict?.newValue ?? null;
      this.oldValue = dict?.oldValue ?? null;
    }
  };
}

beforeEach(() => {
  storage.clear();
});
