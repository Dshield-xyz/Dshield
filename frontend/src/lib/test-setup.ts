import { beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

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

beforeEach(() => {
  storage.clear();
});
