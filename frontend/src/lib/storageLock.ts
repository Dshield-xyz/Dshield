/**
 * Lightweight cross-tab synchronization and locking mechanism for localStorage.
 */

const LOCK_TIMEOUT_MS = 2000;
const MAX_SPIN_WAIT_MS = 500;

function acquireLock(lockKey: string): boolean {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return true;
  }
  try {
    const now = Date.now();
    const existing = localStorage.getItem(lockKey);
    if (existing) {
      const lockTime = parseInt(existing, 10);
      if (!isNaN(lockTime) && now - lockTime < LOCK_TIMEOUT_MS) {
        return false;
      }
    }
    localStorage.setItem(lockKey, String(now));
    return true;
  } catch {
    return true;
  }
}

function releaseLock(lockKey: string): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return;
  }
  try {
    localStorage.removeItem(lockKey);
  } catch {
    // Ignore error in restricted browser contexts
  }
}

/**
 * Synchronously acquires a lock for `lockKey` in localStorage, executes `fn`,
 * and guarantees lock release. Prevents cross-tab read-modify-write race conditions.
 */
export function withStorageLock<T>(lockKey: string, fn: () => T): T {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return fn();
  }

  const start = Date.now();
  while (!acquireLock(lockKey)) {
    if (Date.now() - start > MAX_SPIN_WAIT_MS) {
      break;
    }
    const waitUntil = Date.now() + 2;
    while (Date.now() < waitUntil) {
      // Busy spin wait
    }
  }

  try {
    return fn();
  } finally {
    releaseLock(lockKey);
  }
}

/**
 * Subscribes to window `storage` events for a specific key across tabs/windows.
 */
export function onStorageChange(
  key: string,
  callback: (newValue: string | null) => void,
): () => void {
  if (
    typeof window === "undefined" ||
    typeof window.addEventListener !== "function"
  ) {
    return () => {};
  }

  const handler = (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key === key) {
      callback(storageEvent.newValue);
    }
  };

  window.addEventListener("storage", handler);
  return () => {
    if (typeof window.removeEventListener === "function") {
      window.removeEventListener("storage", handler);
    }
  };
}
