import * as StellarSdk from "@stellar/stellar-sdk";

export interface ShieldedNote {
  nullifier: string;
  secret: string;
  commitment: string;
  leafIndex: number;
  amount: string;
  spent: boolean;
  createdAt: number;
  poolId?: string;
}

const STORAGE_KEY = "dshield_notes";

export function saveNote(note: ShieldedNote): void {
  const notes = getNotes();
  notes.push(note);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
}

/**
 * Save a note only if no note with the same commitment is already stored.
 * Used when importing a pasted note so re-importing doesn't create duplicates.
 * Returns true if the note was newly added.
 */
export function saveNoteIfNew(note: ShieldedNote): boolean {
  const notes = getNotes();
  if (notes.some((n) => n.commitment === note.commitment)) return false;
  notes.push(note);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
  return true;
}

export function getNotes(): ShieldedNote[] {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return JSON.parse(raw);
}

export function markNoteSpent(commitment: string): void {
  const notes = getNotes();
  const updated = notes.map((n) =>
    n.commitment === commitment ? { ...n, spent: true } : n,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function getActiveNotes(): ShieldedNote[] {
  return getNotes().filter((n) => !n.spent);
}

const NOTE_PREFIX = "dshield";
const NOTE_VERSION = "v1";

/**
 * Serialize a note into a single self-contained backup string. This is the
 * secret a user must keep to withdraw — analogous to a Tornado "note". Every
 * field is dash-free (hex, integers, or a Stellar C-address), so a simple
 * dash join round-trips cleanly:
 *   dshield-v1-<poolId>-<leafIndex>-<amount>-<commitment>-<nullifier>-<secret>
 */
export function serializeNote(note: ShieldedNote): string {
  return [
    NOTE_PREFIX,
    NOTE_VERSION,
    note.poolId ?? "",
    note.leafIndex,
    note.amount,
    note.commitment,
    note.nullifier,
    note.secret,
  ].join("-");
}

/** Serializes many notes into one backup file — {@link serializeNote} lines, newline-joined. */
export function serializeNotes(notes: ShieldedNote[]): string {
  return notes.map(serializeNote).join("\n") + "\n";
}

/** Inverse of {@link serializeNote}. Returns null if the string isn't a valid v1 note. */
function parseNoteV1(serialized: string): ShieldedNote | null {
  const parts = serialized.split("-");
  if (parts.length !== 8) return null;
  const [prefix, version, poolId, leafIndex, amount, commitment, nullifier, secret] =
    parts;
  if (prefix !== NOTE_PREFIX || version !== NOTE_VERSION) return null;
  if (!commitment || !nullifier || !secret) return null;
  return {
    nullifier,
    secret,
    commitment,
    leafIndex: Number(leafIndex),
    amount,
    spent: false,
    createdAt: Date.now(),
    poolId: poolId || undefined,
  };
}

// Compact binary encoding used only for shareable links (generateNoteLink) —
// the same information as serializeNote's dash-joined hex fields, packed
// into a fixed-width buffer and base64url-encoded instead. Roughly a third
// shorter, which matters when a note is pasted somewhere with a practical
// length limit (a social post, a QR code). serializeNote's format is left
// alone for the copy/paste backup textarea, where readability matters more
// than length. All bytes here are already URL/fragment-safe (base64url +
// the "." prefix separator), so no percent-encoding inflation occurs.
//
// Deliberately built on plain Uint8Array/DataView/btoa/atob rather than
// Node's Buffer: this file (and the notes it builds) run in the browser,
// where `Buffer` only exists via a bundler polyfill that other code in this
// codebase only ever exercises through `Buffer.from(hex).toString("hex")`.
// Buffer.alloc/writeUInt32BE/writeBigUInt64BE/copy/equals/base64url are
// untested surface on that polyfill and threw during render the first time
// this ran in a real browser — a render-time throw here unmounts the whole
// page. Uint8Array/DataView/btoa/atob are native browser globals, no
// polyfill involved.
const COMPACT_PREFIX = "dS2.";
const COMPACT_VERSION = 2;
// version(1) + poolId(32) + leafIndex(4) + amount(8) + commitment(32) +
// nullifier(32) + secret(32)
const COMPACT_LENGTH = 1 + 32 + 4 + 8 + 32 + 32 + 32;
const ZERO_POOL_ID = new Uint8Array(32);

function hexToBytes32(hex: string): Uint8Array | null {
  const clean = hex.replace(/^0x/, "");
  if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(payload: string): Uint8Array | null {
  try {
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Packs a note into the compact link format. Returns null (caller falls
 * back to the dash-joined format) if any field doesn't fit the fixed
 * widths chosen here — leafIndex up to 2^32-1 (pool trees cap at 2^20
 * leaves) and amount up to 2^64-1 (far beyond any realistic USDC tier) —
 * so a future edge case degrades to a longer link instead of breaking.
 */
function encodeNoteCompact(note: ShieldedNote): string | null {
  if (!Number.isInteger(note.leafIndex) || note.leafIndex < 0 || note.leafIndex > 0xffffffff) {
    return null;
  }
  let amountBig: bigint;
  try {
    amountBig = BigInt(note.amount);
  } catch {
    return null;
  }
  if (amountBig < BigInt(0) || amountBig > BigInt("0xffffffffffffffff")) return null;
  const commitmentBytes = hexToBytes32(note.commitment);
  const nullifierBytes = hexToBytes32(note.nullifier);
  const secretBytes = hexToBytes32(note.secret);
  if (!commitmentBytes || !nullifierBytes || !secretBytes) return null;

  let poolIdBytes: Uint8Array;
  if (note.poolId) {
    try {
      poolIdBytes = new Uint8Array(StellarSdk.StrKey.decodeContract(note.poolId));
    } catch {
      return null;
    }
    if (poolIdBytes.length !== 32) return null;
  } else {
    poolIdBytes = ZERO_POOL_ID;
  }

  const bytes = new Uint8Array(COMPACT_LENGTH);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint8(offset, COMPACT_VERSION);
  offset += 1;
  bytes.set(poolIdBytes, offset);
  offset += 32;
  view.setUint32(offset, note.leafIndex, false);
  offset += 4;
  view.setBigUint64(offset, amountBig, false);
  offset += 8;
  bytes.set(commitmentBytes, offset);
  offset += 32;
  bytes.set(nullifierBytes, offset);
  offset += 32;
  bytes.set(secretBytes, offset);

  return COMPACT_PREFIX + base64UrlEncode(bytes);
}

function decodeNoteCompact(payload: string): ShieldedNote | null {
  const bytes = base64UrlDecode(payload);
  if (!bytes || bytes.length !== COMPACT_LENGTH) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== COMPACT_VERSION) return null;

  let offset = 1;
  const poolIdBytes = bytes.subarray(offset, offset + 32);
  offset += 32;
  const leafIndex = view.getUint32(offset, false);
  offset += 4;
  const amount = view.getBigUint64(offset, false).toString();
  offset += 8;
  const commitment = bytesToHex(bytes.subarray(offset, offset + 32));
  offset += 32;
  const nullifier = bytesToHex(bytes.subarray(offset, offset + 32));
  offset += 32;
  const secret = bytesToHex(bytes.subarray(offset, offset + 32));

  let poolId: string | undefined;
  if (!bytesEqual(poolIdBytes, ZERO_POOL_ID)) {
    try {
      poolId = StellarSdk.StrKey.encodeContract(Buffer.from(poolIdBytes));
    } catch {
      return null;
    }
  }

  return {
    nullifier,
    secret,
    commitment,
    leafIndex,
    amount,
    spent: false,
    createdAt: Date.now(),
    poolId,
  };
}

/** Inverse of both {@link serializeNote} and the compact link format. Returns null if the string is neither. */
export function parseNote(serialized: string): ShieldedNote | null {
  const trimmed = serialized.trim();
  if (trimmed.startsWith(COMPACT_PREFIX)) {
    return decodeNoteCompact(trimmed.slice(COMPACT_PREFIX.length));
  }
  return parseNoteV1(trimmed);
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

export function generateRandomField(): string {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "00" + hex;
}
