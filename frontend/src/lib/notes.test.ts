import { describe, it, expect } from "vitest";
import {
  saveNote,
  getNotes,
  markNoteSpent,
  getActiveNotes,
  generateRandomField,
  deriveViewingKey,
  serializeNote,
  serializeNotes,
  parseNote,
  saveNoteIfNew,
  generateNoteLink,
  getPendingNotes,
  setNoteLeafIndex,
  PENDING_LEAF_INDEX,
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

describe("deriveViewingKey", () => {
  it("is deterministic for the same secret", async () => {
    const a = await deriveViewingKey("00aabbcc");
    const b = await deriveViewingKey("00aabbcc");
    expect(a).toBe(b);
  });

  it("differs for different secrets", async () => {
    const a = await deriveViewingKey("00aabbcc");
    const b = await deriveViewingKey("00ddeeff");
    expect(a).not.toBe(b);
  });

  it("does not depend on nullifier: a viewing key is a pure function of secret", async () => {
    // The whole point of the view/spend separation is that the viewing key
    // can be computed (and independently verified) from `secret` alone. If
    // it were a function of both, handing it out would start to leak
    // spend-adjacent information.
    const note = makeNote({ secret: "00112233" });
    const viewKeyA = await deriveViewingKey(note.secret);
    const viewKeyB = await deriveViewingKey(
      makeNote({ secret: "00112233", nullifier: "ffffffff" }).secret,
    );
    expect(viewKeyA).toBe(viewKeyB);
  });

  it("is not the identity function: the viewing key never equals the secret or nullifier", async () => {
    // A cheap but real regression guard: if this ever degenerated into
    // returning its input unchanged, a viewing key would literally BE the
    // secret, destroying the entire key-separation guarantee.
    const note = makeNote();
    const viewKey = await deriveViewingKey(note.secret);
    expect(viewKey.replace(/^0x/, "").replace(/^0+/, "")).not.toBe(
      note.secret.replace(/^0x/, "").replace(/^0+/, ""),
    );
    expect(viewKey.replace(/^0x/, "").replace(/^0+/, "")).not.toBe(
      note.nullifier.replace(/^0x/, "").replace(/^0+/, ""),
    );
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

  it("saves and retrieves a note", async () => {
    const note = makeNote();
    await saveNote(note);
    const notes = getNotes();
    expect(notes).toHaveLength(1);
    expect(notes[0].commitment).toBe("abcd1234");
    expect(notes[0].amount).toBe("1000000");
  });

  it("appends multiple notes", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    await saveNote(makeNote({ commitment: "bbb" }));
    expect(getNotes()).toHaveLength(2);
  });
});

describe("saveNoteIfNew", () => {
  it("adds a note that isn't already stored", async () => {
    expect(await saveNoteIfNew(makeNote({ commitment: "aaa" }))).toBe(true);
    expect(getNotes()).toHaveLength(1);
  });

  it("does not duplicate a note with an existing commitment", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    expect(await saveNoteIfNew(makeNote({ commitment: "aaa", secret: "00ff" }))).toBe(
      false,
    );
    expect(getNotes()).toHaveLength(1);
  });
});

describe("markNoteSpent", () => {
  it("marks the correct note as spent", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    await saveNote(makeNote({ commitment: "bbb" }));
    await markNoteSpent("aaa");
    const notes = getNotes();
    expect(notes[0].spent).toBe(true);
    expect(notes[1].spent).toBe(false);
  });

  it("does not modify notes with different commitment", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    await markNoteSpent("zzz");
    expect(getNotes()[0].spent).toBe(false);
  });
});

describe("getActiveNotes", () => {
  it("filters out spent notes", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    await saveNote(makeNote({ commitment: "bbb" }));
    await markNoteSpent("aaa");
    const active = getActiveNotes();
    expect(active).toHaveLength(1);
    expect(active[0].commitment).toBe("bbb");
  });

  it("returns all notes when none are spent", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    await saveNote(makeNote({ commitment: "bbb" }));
    expect(getActiveNotes()).toHaveLength(2);
  });

  it("returns empty array when all are spent", async () => {
    await saveNote(makeNote({ commitment: "aaa" }));
    await markNoteSpent("aaa");
    expect(getActiveNotes()).toHaveLength(0);
  });
});

describe("pending change notes", () => {
  it("hides a note with no resolved leaf index from the spendable set", async () => {
    // A change note is saved before its withdrawal confirms, so its leaf slot
    // isn't known yet. Offering it for withdrawal would build a Merkle proof
    // against the wrong index and fail after a minute of proving.
    await saveNote(makeNote({ commitment: "aaa" }));
    await saveNote(makeNote({ commitment: "bbb", leafIndex: PENDING_LEAF_INDEX }));

    expect(getActiveNotes().map((n) => n.commitment)).toEqual(["aaa"]);
    expect(getPendingNotes().map((n) => n.commitment)).toEqual(["bbb"]);
  });

  it("makes a note spendable once its index is recorded", async () => {
    await saveNote(makeNote({ commitment: "bbb", leafIndex: PENDING_LEAF_INDEX }));
    setNoteLeafIndex("bbb", 7);

    expect(getPendingNotes()).toHaveLength(0);
    const active = getActiveNotes();
    expect(active).toHaveLength(1);
    expect(active[0].leafIndex).toBe(7);
  });

  it("leaves a spent note out of the pending set", async () => {
    await saveNote(makeNote({ commitment: "bbb", leafIndex: PENDING_LEAF_INDEX }));
    markNoteSpent("bbb");
    expect(getPendingNotes()).toHaveLength(0);
  });

  it("round-trips a pending note through the backup format", () => {
    // The dash-joined format would gain a ninth field if -1 were written out
    // literally, so the sentinel has to survive as something dash-free.
    const note = makeNote({ leafIndex: PENDING_LEAF_INDEX });
    const parsed = parseNote(serializeNote(note));
    expect(parsed?.leafIndex).toBe(PENDING_LEAF_INDEX);
    expect(parsed?.amount).toBe(note.amount);
  });

  it("round-trips a pending note through the compact link format", () => {
    const note = makeNote({
      leafIndex: PENDING_LEAF_INDEX,
      commitment: "ab".repeat(32),
      nullifier: "cd".repeat(32),
      secret: "ef".repeat(32),
    });
    const link = generateNoteLink(note);
    const payload = decodeURIComponent(link.split("#note=")[1]);
    expect(payload.startsWith("dS2.")).toBe(true);
    expect(parseNote(payload)?.leafIndex).toBe(PENDING_LEAF_INDEX);
  });
});

describe("zero-value notes", () => {
  it("keeps the empty note a full withdrawal leaves behind out of the way", async () => {
    // Every spend appends a change note so that full and partial withdrawals
    // look identical on-chain. When the spend took everything, that note is
    // worth nothing and there is nothing to offer the user.
    await saveNote(makeNote({ commitment: "aaa", amount: "0" }));
    await saveNote(makeNote({ commitment: "bbb", amount: "1" }));

    expect(getActiveNotes().map((n) => n.commitment)).toEqual(["bbb"]);
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


describe("Cross-tab synchronization", () => {
  it("concurrent saves do not clobber each other", async () => {
    // Simulate two tabs saving notes concurrently
    const note1 = makeNote({ commitment: "concurrent1" });
    const note2 = makeNote({ commitment: "concurrent2" });
    
    // Fire both saves simultaneously
    await Promise.all([
      saveNote(note1),
      saveNote(note2),
    ]);
    
    const notes = getNotes();
    expect(notes).toHaveLength(2);
    expect(notes.some((n) => n.commitment === "concurrent1")).toBe(true);
    expect(notes.some((n) => n.commitment === "concurrent2")).toBe(true);
  });

  it("concurrent markNoteSpent operations serialize correctly", async () => {
    await saveNote(makeNote({ commitment: "mark1" }));
    await saveNote(makeNote({ commitment: "mark2" }));
    
    // Mark both as spent concurrently
    await Promise.all([
      markNoteSpent("mark1"),
      markNoteSpent("mark2"),
    ]);
    
    const notes = getNotes();
    expect(notes[0].spent).toBe(true);
    expect(notes[1].spent).toBe(true);
  });

  it("concurrent save and markNoteSpent do not lose updates", async () => {
    await saveNote(makeNote({ commitment: "existing" }));
    
    // One tab saves a new note while another marks existing note as spent
    await Promise.all([
      saveNote(makeNote({ commitment: "new" })),
      markNoteSpent("existing"),
    ]);
    
    const notes = getNotes();
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.commitment === "existing")?.spent).toBe(true);
    expect(notes.find((n) => n.commitment === "new")).toBeDefined();
  });

  it("lock timeout throws error if lock cannot be acquired", async () => {
    // Manually set a lock with a recent timestamp that won't be considered stale
    const stubbornLock = JSON.stringify({ 
      id: "stuck-lock", 
      timestamp: Date.now() // Fresh timestamp, won't be cleared as stale
    });
    localStorage.setItem("dshield_notes_lock", stubbornLock);
    
    // Attempt to save should timeout and throw
    await expect(
      saveNote(makeNote({ commitment: "timeout-test" }))
    ).rejects.toThrow("Failed to acquire storage lock after timeout");
    
    // Clean up
    localStorage.removeItem("dshield_notes_lock");
  }, 10000); // 10 second timeout for this test
});
