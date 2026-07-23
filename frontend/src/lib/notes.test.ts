import { describe, it, expect } from "vitest";
import {
  saveNote,
  getNotes,
  markNoteSpent,
  getActiveNotes,
  generateRandomField,
  serializeNote,
  serializeNotes,
  parseNote,
  saveNoteIfNew,
  generateNoteLink,
  type ShieldedNote,
} from "./notes";

function makeNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    nullifier: "00aabbcc",
    secret: "00ddeeff",
    commitment: "abcd1234",
    leafIndex: 0,
    amount: "1000000",
    spent: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("generateRandomField", () => {
  it("produces a 64-char hex string starting with 00", () => {
    const field = generateRandomField();
    expect(field).toHaveLength(64);
    expect(field.slice(0, 2)).toBe("00");
    expect(/^[0-9a-f]{64}$/.test(field)).toBe(true);
  });

  it("produces different values on successive calls", () => {
    const a = generateRandomField();
    const b = generateRandomField();
    expect(a).not.toBe(b);
  });
});

describe("serializeNote / parseNote", () => {
  it("round-trips a note's withdrawable fields", () => {
    const note = makeNote({
      poolId: "CABC123",
      leafIndex: 7,
      amount: "10000000",
      commitment: "deadbeef",
      nullifier: "00aa",
      secret: "00bb",
    });
    const restored = parseNote(serializeNote(note));
    expect(restored).not.toBeNull();
    expect(restored!.poolId).toBe("CABC123");
    expect(restored!.leafIndex).toBe(7);
    expect(restored!.amount).toBe("10000000");
    expect(restored!.commitment).toBe("deadbeef");
    expect(restored!.nullifier).toBe("00aa");
    expect(restored!.secret).toBe("00bb");
    expect(restored!.spent).toBe(false);
  });

  it("produces a dshield-v1 prefixed string", () => {
    expect(serializeNote(makeNote())).toMatch(/^dshield-v1-/);
  });

  it("returns null for malformed or foreign strings", () => {
    expect(parseNote("not-a-note")).toBeNull();
    expect(parseNote("tornado-eth-0.1-1-0xabc")).toBeNull();
    expect(parseNote("dshield-v2-a-0-1-c-n-s")).toBeNull();
    expect(parseNote("")).toBeNull();
  });
});

describe("serializeNotes", () => {
  it("joins one dshield-v1 line per note, newline-terminated", () => {
    const notes = [
      makeNote({ commitment: "aaa" }),
      makeNote({ commitment: "bbb" }),
      makeNote({ commitment: "ccc" }),
    ];
    const body = serializeNotes(notes);
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/^dshield-v1-/);
  });

  it("round-trips every note's withdrawable fields through parseNote", () => {
    const notes = [
      makeNote({ commitment: "aaa", leafIndex: 1, amount: "1000" }),
      makeNote({ commitment: "bbb", leafIndex: 2, amount: "2000" }),
    ];
    const restored = serializeNotes(notes)
      .trim()
      .split("\n")
      .map(parseNote);
    expect(restored.map((n) => n?.commitment)).toEqual(["aaa", "bbb"]);
    expect(restored.map((n) => n?.leafIndex)).toEqual([1, 2]);
    expect(restored.map((n) => n?.amount)).toEqual(["1000", "2000"]);
  });

  it("produces output that NoteImport's whitespace-split parsing recovers cleanly", () => {
    // NoteImport splits pasted/uploaded text on /[\n\r\s]+/ and keeps only
    // tokens starting with "dshield-v1-" — mirror that here without
    // importing a React component into a lib-level test.
    const notes = [makeNote({ commitment: "aaa" }), makeNote({ commitment: "bbb" })];
    const tokens = serializeNotes(notes)
      .split(/[\n\r\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("dshield-v1-"));
    expect(tokens).toHaveLength(2);
    expect(tokens.map(parseNote).map((n) => n?.commitment)).toEqual(["aaa", "bbb"]);
  });

  it("returns an empty backup as a single trailing newline", () => {
    expect(serializeNotes([])).toBe("\n");
  });
});

describe("generateNoteLink (compact link encoding)", () => {
  const HEX32_A = "1234567890abcdef".repeat(4);
  const HEX32_B = "00aabbcc".repeat(8);
  const HEX32_C = "deadbeef".repeat(8);
  const VALID_POOL = "CBQ3EPNIMGLS53U4HHLT4V3HAGJJCLONVXAN2QEREGQZMFQOLK7VF6C7";

  function fullNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
    return {
      nullifier: HEX32_A,
      secret: HEX32_B,
      commitment: HEX32_C,
      leafIndex: 42,
      amount: "100000000",
      spent: false,
      createdAt: Date.now(),
      poolId: VALID_POOL,
      ...overrides,
    };
  }

  function hashPayload(link: string): string {
    return decodeURIComponent(link.split("#note=")[1]);
  }

  it("round-trips every withdrawable field through the compact format", () => {
    const note = fullNote();
    const link = generateNoteLink(note);
    expect(hashPayload(link)).toMatch(/^dS2\./);

    const restored = parseNote(hashPayload(link));
    expect(restored).not.toBeNull();
    expect(restored!.poolId).toBe(VALID_POOL);
    expect(restored!.leafIndex).toBe(42);
    expect(restored!.amount).toBe("100000000");
    expect(restored!.commitment).toBe(HEX32_C);
    expect(restored!.nullifier).toBe(HEX32_A);
    expect(restored!.secret).toBe(HEX32_B);
  });

  it("round-trips a note with no poolId", () => {
    const note = fullNote({ poolId: undefined });
    const restored = parseNote(hashPayload(generateNoteLink(note)));
    expect(restored!.poolId).toBeUndefined();
  });

  it("produces a materially shorter payload than the dash-joined backup format", () => {
    const note = fullNote();
    const compactLen = hashPayload(generateNoteLink(note)).length;
    const legacyLen = serializeNote(note).length;
    expect(compactLen).toBeLessThan(legacyLen * 0.75);
  });

  it("still parses a pre-existing dshield-v1 link (backward compatibility)", () => {
    const note = fullNote();
    const legacyPayload = serializeNote(note);
    const restored = parseNote(legacyPayload);
    expect(restored).not.toBeNull();
    expect(restored!.commitment).toBe(HEX32_C);
  });

  it("falls back to the legacy format for fields that don't fit the compact encoding", () => {
    // The default short fixture (8-char hex) isn't a valid 32-byte field,
    // so encodeNoteCompact should decline and generateNoteLink should fall
    // back to serializeNote rather than produce a broken link.
    const shortNote: ShieldedNote = {
      nullifier: "00aabbcc",
      secret: "00ddeeff",
      commitment: "abcd1234",
      leafIndex: 0,
      amount: "1000000",
      spent: false,
      createdAt: Date.now(),
    };
    const payload = hashPayload(generateNoteLink(shortNote));
    expect(payload).toMatch(/^dshield-v1-/);
    const restored = parseNote(payload);
    expect(restored).not.toBeNull();
    expect(restored!.commitment).toBe("abcd1234");
  });
});

describe("saveNote / getNotes", () => {
  it("returns empty array when nothing saved", () => {
    expect(getNotes()).toEqual([]);
  });

  it("saves and retrieves a note", () => {
    const note = makeNote();
    saveNote(note);
    const notes = getNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].commitment).toBe("abcd1234");
    expect(notes[0].amount).toBe("1000000");
  });

  it("appends multiple notes", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    saveNote(makeNote({ commitment: "bbb" }));
    expect(getNotes()).toHaveLength(2);
  });
});

describe("saveNoteIfNew", () => {
  it("adds a note that isn't already stored", () => {
    expect(saveNoteIfNew(makeNote({ commitment: "aaa" }))).toBe(true);
    expect(getNotes()).toHaveLength(1);
  });

  it("does not duplicate a note with an existing commitment", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    expect(saveNoteIfNew(makeNote({ commitment: "aaa", secret: "00ff" }))).toBe(
      false,
    );
    expect(getNotes()).toHaveLength(1);
  });
});

describe("markNoteSpent", () => {
  it("marks the correct note as spent", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    saveNote(makeNote({ commitment: "bbb" }));
    markNoteSpent("aaa");
    const notes = getNotes();
    expect(notes[0].spent).toBe(true);
    expect(notes[1].spent).toBe(false);
  });

  it("does not modify notes with different commitment", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    markNoteSpent("zzz");
    expect(getNotes()[0].spent).toBe(false);
  });
});

describe("getActiveNotes", () => {
  it("filters out spent notes", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    saveNote(makeNote({ commitment: "bbb" }));
    markNoteSpent("aaa");
    const active = getActiveNotes();
    expect(active).toHaveLength(1);
    expect(active[0].commitment).toBe("bbb");
  });

  it("returns all notes when none are spent", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    saveNote(makeNote({ commitment: "bbb" }));
    expect(getActiveNotes()).toHaveLength(2);
  });

  it("returns empty array when all are spent", () => {
    saveNote(makeNote({ commitment: "aaa" }));
    markNoteSpent("aaa");
    expect(getActiveNotes()).toHaveLength(0);
  });
});

describe("generateNoteLink without a Buffer global", () => {
  // Regression test for a real crash: the browser's `Buffer` only exists via
  // a bundler polyfill. An earlier version of the compact link encoder used
  // Buffer.alloc/writeUInt32BE/writeBigUInt64BE/copy/equals/
  // toString("base64url") to pack the note — surface nothing else in this
  // codebase exercises. That threw during render on the deposit
  // success screen (a render-time throw unmounts the whole React tree,
  // which is what actually crashed). Trying to fake a spec-compliant Buffer
  // here to test the old behavior isn't safe either: swapping in anything
  // that fails `instanceof Buffer` can crash unrelated code that assumes a
  // real Buffer constructor exists (this was verified directly — even
  // vitest's own error serializer does `instanceof Buffer` and hard-crashes
  // the test worker on a fake one). So instead this removes `Buffer`
  // entirely and asserts generateNoteLink degrades gracefully rather than
  // throwing, and that the core packing (Uint8Array/DataView/btoa) needs no
  // Buffer at all when no pool StrKey en/decoding is involved.
  function withoutBuffer<T>(fn: () => T): T {
    const RealBuffer = globalThis.Buffer;
    // @ts-expect-error -- intentionally removing the global for this test
    delete globalThis.Buffer;
    try {
      return fn();
    } finally {
      globalThis.Buffer = RealBuffer;
    }
  }

  const note: ShieldedNote = {
    nullifier: "1234567890abcdef".repeat(4),
    secret: "00aabbcc".repeat(8),
    commitment: "deadbeef".repeat(8),
    leafIndex: 42,
    amount: "100000000",
    spent: false,
    createdAt: Date.now(),
  };

  it("uses the compact format and round-trips with no poolId involved", () => {
    const link = withoutBuffer(() => generateNoteLink(note));
    const payload = decodeURIComponent(link.split("#note=")[1]);
    expect(payload.startsWith("dS2.")).toBe(true);

    const restored = withoutBuffer(() => parseNote(payload));
    expect(restored).not.toBeNull();
    expect(restored!.commitment).toBe(note.commitment);
    expect(restored!.nullifier).toBe(note.nullifier);
    expect(restored!.secret).toBe(note.secret);
    expect(restored!.leafIndex).toBe(note.leafIndex);
    expect(restored!.amount).toBe(note.amount);
  });

  it("degrades to the legacy format instead of throwing when poolId needs StrKey", () => {
    const withPool = { ...note, poolId: "CBQ3EPNIMGLS53U4HHLT4V3HAGJJCLONVXAN2QEREGQZMFQOLK7VF6C7" };
    let link = "";
    expect(() => {
      link = withoutBuffer(() => generateNoteLink(withPool));
    }).not.toThrow();

    const payload = decodeURIComponent(link.split("#note=")[1]);
    expect(payload.startsWith("dshield-v1-")).toBe(true);
    const restored = parseNote(payload);
    expect(restored!.poolId).toBe(withPool.poolId);
  });
});
