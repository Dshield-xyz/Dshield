import { describe, it, expect } from "vitest";
import {
  serializeNote,
  serializeNotes,
  parseNote,
  parseNotes,
  encodeNoteCompact,
  generateRandomField,
  PENDING_LEAF_INDEX,
  type ShieldedNote,
} from "./notes";

const POOL = "CCPH4ECWWCOE2MN52QSMXJEVKRDLZVJIEQ4BXMHSSKMPP27BHGSKXABV";

function sampleNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    nullifier: "00".repeat(31) + "0a",
    secret: "00".repeat(31) + "0b",
    commitment: "11".repeat(32),
    leafIndex: 3,
    amount: "1000000",
    spent: false,
    createdAt: 1_700_000_000_000,
    poolId: POOL,
    ...overrides,
  };
}

describe("serializeNote / parseNote (v1 dash format)", () => {
  it("round-trips a note through the backup string", () => {
    const note = sampleNote();
    const parsed = parseNote(serializeNote(note));
    expect(parsed).not.toBeNull();
    expect(parsed!.nullifier).toBe(note.nullifier);
    expect(parsed!.secret).toBe(note.secret);
    expect(parsed!.commitment).toBe(note.commitment);
    expect(parsed!.amount).toBe(note.amount);
    expect(parsed!.leafIndex).toBe(note.leafIndex);
    expect(parsed!.poolId).toBe(note.poolId);
  });

  it("encodes a pending leaf index as the token and restores the sentinel", () => {
    const note = sampleNote({ leafIndex: PENDING_LEAF_INDEX });
    expect(serializeNote(note)).toContain("-p-");
    expect(parseNote(serializeNote(note))!.leafIndex).toBe(PENDING_LEAF_INDEX);
  });

  it("rejects strings that are not valid notes", () => {
    expect(parseNote("not-a-note")).toBeNull();
    expect(parseNote("dshield-v2-a-b-c-d-e-f")).toBeNull();
  });
});

describe("compact link format", () => {
  it("round-trips through the compact encoding", () => {
    const note = sampleNote();
    const compact = encodeNoteCompact(note);
    expect(compact).not.toBeNull();
    const parsed = parseNote(compact!);
    expect(parsed!.commitment).toBe(note.commitment);
    expect(parsed!.nullifier).toBe(note.nullifier);
    expect(parsed!.secret).toBe(note.secret);
    expect(parsed!.amount).toBe(note.amount);
    expect(parsed!.leafIndex).toBe(note.leafIndex);
    expect(parsed!.poolId).toBe(note.poolId);
  });
});

describe("serializeNotes / parseNotes (backup blobs)", () => {
  it("round-trips many notes and skips junk lines", () => {
    const notes = [sampleNote({ leafIndex: 1 }), sampleNote({ leafIndex: 2 })];
    const blob = serializeNotes(notes) + "\ngarbage line\n";
    const parsed = parseNotes(blob);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((n) => n.leafIndex).sort()).toEqual([1, 2]);
  });
});

describe("generateRandomField", () => {
  it("returns 32-byte bare hex with a zeroed top byte (stays in field)", () => {
    const f = generateRandomField();
    expect(f).toMatch(/^00[0-9a-f]{62}$/);
    expect(f.length).toBe(64);
  });

  it("is unlikely to collide", () => {
    expect(generateRandomField()).not.toBe(generateRandomField());
  });
});
