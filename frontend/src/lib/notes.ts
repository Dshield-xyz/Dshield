// Note storage for the browser app. The note *codec* (serialize/parse, compact
// link encoding, the ShieldedNote shape and PENDING_LEAF_INDEX) lives in the
// shared @dshield/core package so the app and the `dshield` CLI produce and read
// byte-identical notes. This module keeps only what is browser-specific: the
// localStorage-backed store and the origin-aware share link.
import {
  encodeNoteCompact,
  serializeNote,
  type ShieldedNote,
} from "@dshield/core/notes";

export {
  serializeNote,
  serializeNotes,
  parseNote,
  parseNotes,
  generateRandomField,
  PENDING_LEAF_INDEX,
} from "@dshield/core/notes";
export type { ShieldedNote } from "@dshield/core/notes";

const STORAGE_KEY = "dshield_notes";
const STORAGE_LOCK_KEY = "dshield_notes_lock";
const LOCK_TIMEOUT_MS = 5000;

/**
 * Acquire a simple advisory lock to serialize cross-tab writes.
 * This prevents two tabs from concurrently performing read-modify-write
 * on the note store and silently clobbering each other's updates.
 *
 * Not cryptographically secure, but sufficient to prevent accidental
 * data loss from concurrent operations in different tabs/windows.
 */
async function acquireLock(): Promise<() => void> {
  const lockId = Date.now().toString() + Math.random().toString(36);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const currentLock = localStorage.getItem(STORAGE_LOCK_KEY);
    if (!currentLock) {
      // No lock exists, try to acquire it
      const lockData = JSON.stringify({ id: lockId, timestamp: Date.now() });
      localStorage.setItem(STORAGE_LOCK_KEY, lockData);
      // Verify we actually got the lock (another tab might have written simultaneously)
      const verifyLock = localStorage.getItem(STORAGE_LOCK_KEY);
      if (verifyLock) {
        try {
          const parsed = JSON.parse(verifyLock);
          if (parsed.id === lockId) {
            // Successfully acquired lock
            return () => {
              const currentData = localStorage.getItem(STORAGE_LOCK_KEY);
              if (currentData) {
                try {
                  const current = JSON.parse(currentData);
                  if (current.id === lockId) {
                    localStorage.removeItem(STORAGE_LOCK_KEY);
                  }
                } catch {
                  // Corrupted lock data, safe to remove
                  localStorage.removeItem(STORAGE_LOCK_KEY);
                }
              }
            };
          }
        } catch {
          // Invalid JSON, try again
        }
      }
    } else {
      // Check if the lock is stale (holder crashed or never released)
      try {
        const lockData = JSON.parse(currentLock);
        if (lockData.timestamp && Date.now() - lockData.timestamp > LOCK_TIMEOUT_MS) {
          // Stale lock, try to clear it
          localStorage.removeItem(STORAGE_LOCK_KEY);
        }
      } catch {
        // Invalid lock data without timestamp, assume it's not a proper lock from our system
        // Don't clear it immediately - it might be from a test
      }
    }
    // Wait a bit before retrying
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Failed to acquire storage lock after timeout");
}

/**
 * Execute a function with the storage lock held.
 * Ensures only one tab can modify the note store at a time.
 */
async function withLock<T>(fn: () => T): Promise<T> {
  const release = await acquireLock();
  try {
    return fn();
  } finally {
    release();
  }
}

export async function saveNote(note: ShieldedNote): Promise<void> {
  return withLock(() => {
    const notes = getNotes();
    notes.push(note);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  });
}

/**
 * Save a note only if no note with the same commitment is already stored.
 * Used when importing a pasted note so re-importing doesn't create duplicates.
 * Returns true if the note was newly added.
 */
export async function saveNoteIfNew(note: ShieldedNote): Promise<boolean> {
  return withLock(() => {
    const notes = getNotes();
    if (notes.some((n) => n.commitment === note.commitment)) return false;
    notes.push(note);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
    return true;
  });
}

export function getNotes(): ShieldedNote[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

/**
 * Records the leaf index a note actually landed on. Used to settle a change
 * note once its withdrawal has confirmed; until then the note is unspendable,
 * because a Merkle proof needs the real index.
 */
export function setNoteLeafIndex(commitment: string, leafIndex: number): void {
  const notes = getNotes();
  const updated = notes.map((n) =>
    n.commitment === commitment ? { ...n, leafIndex } : n,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

/** Notes saved but not yet tied to a leaf index — see {@link PENDING_LEAF_INDEX}. */
export function getPendingNotes(): ShieldedNote[] {
  return getNotes().filter((n) => !n.spent && n.leafIndex < 0);
}

export function markNoteSpent(commitment: string): void {
  const notes = getNotes();
  const updated = notes.map((n) =>
    n.commitment === commitment ? { ...n, spent: true } : n,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

/**
 * Notes that can be spent right now: unspent, worth something, and with a
 * known leaf index. A zero-value change note (what a full withdrawal leaves
 * behind) is deliberately excluded — it exists only so that full and partial
 * withdrawals look identical on-chain, and has nothing left to withdraw.
 */
export function getActiveNotes(): ShieldedNote[] {
  return getNotes().filter(
    (n) => !n.spent && n.leafIndex >= 0 && BigInt(n.amount || "0") > BigInt(0),
  );
}

export function generateNoteLink(note: ShieldedNote): string {
  const base =
    typeof window !== "undefined"
      ? window.location.origin
      : "https://dshield.vercel.app";
  const compact = encodeNoteCompact(note);
  const payload = compact ?? serializeNote(note);
  return `${base}/withdraw#note=${encodeURIComponent(payload)}`;
}
