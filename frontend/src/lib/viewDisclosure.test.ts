import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildViewDisclosureProof,
  parseViewDisclosureBundle,
  verifyViewDisclosureBundle,
  type ViewDisclosureBundle,
} from "./viewDisclosure";
import type { ShieldedNote } from "./notes";

vi.mock("./indexer", () => ({
  fetchCommitmentsFromChain: vi.fn(),
}));
vi.mock("./stellar", () => ({
  POOL_CONTRACT_ID: "POOL123",
  queryContract: vi.fn(),
}));
vi.mock("./prover", () => ({
  proveViewDisclosure: vi.fn(),
  verifyViewDisclosure: vi.fn(),
}));

import { fetchCommitmentsFromChain } from "./indexer";
import { queryContract } from "./stellar";
import { proveViewDisclosure, verifyViewDisclosure } from "./prover";

function makeNote(overrides: Partial<ShieldedNote> = {}): ShieldedNote {
  return {
    nullifier: "00aabbcc",
    secret: "00ddeeff",
    commitment: "abcd1234",
    leafIndex: 0,
    amount: "1000000",
    asset: "1",
    spent: false,
    createdAt: Date.now(),
    poolId: "POOL123",
    ...overrides,
  };
}

describe("buildViewDisclosureProof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fetchCommitmentsFromChain as ReturnType<typeof vi.fn>).mockResolvedValue([
      "0x" + "00".repeat(31) + "ab",
    ]);
    (proveViewDisclosure as ReturnType<typeof vi.fn>).mockResolvedValue({
      proof: "deadbeef",
      publicInputs: "1".padStart(64, "0"),
    });
  });

  it("never includes nullifier or secret in the returned bundle", async () => {
    const note = makeNote();
    const bundle = await buildViewDisclosureProof(note);

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain(note.nullifier);
    expect(serialized).not.toContain(note.secret);
  });

  it("includes the note's amount so the verifier learns it", async () => {
    const note = makeNote({ amount: "424242" });
    const bundle = await buildViewDisclosureProof(note);
    expect(bundle.amount).toBe("424242");
  });

  it("passes the note's real secret material to the prover as private witnesses", async () => {
    const note = makeNote();
    await buildViewDisclosureProof(note);

    const call = (proveViewDisclosure as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.nullifier).toBe(note.nullifier);
    expect(call.secret).toBe(note.secret);
  });

  it("throws if the note's leaf index is still pending", async () => {
    const note = makeNote({ leafIndex: -1 });
    await expect(buildViewDisclosureProof(note)).rejects.toThrow(/leaf index/i);
  });

  it("throws if chain commitments can't be loaded", async () => {
    (fetchCommitmentsFromChain as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(buildViewDisclosureProof(makeNote())).rejects.toThrow();
  });
});

describe("parseViewDisclosureBundle", () => {
  const VALID: ViewDisclosureBundle = {
    v: 1,
    poolId: "POOL123",
    merkleRoot: "0x1",
    viewKey: "0x2",
    amount: "1000000",
    proof: "deadbeef",
    publicInputs: "00".repeat(32),
    generatedAt: Date.now(),
  };

  it("round-trips a valid bundle", () => {
    expect(parseViewDisclosureBundle(JSON.stringify(VALID))).toEqual(VALID);
  });

  it("returns null for invalid JSON", () => {
    expect(parseViewDisclosureBundle("not json")).toBeNull();
  });

  it("returns null for the wrong version", () => {
    expect(parseViewDisclosureBundle(JSON.stringify({ ...VALID, v: 2 }))).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    const rest: Record<string, unknown> = { ...VALID };
    delete rest.proof;
    expect(parseViewDisclosureBundle(JSON.stringify(rest))).toBeNull();
  });
});

describe("verifyViewDisclosureBundle", () => {
  const BUNDLE: ViewDisclosureBundle = {
    v: 1,
    poolId: "POOL123",
    merkleRoot: "0x" + "ab".repeat(32),
    viewKey: "0x2",
    amount: "1000000",
    proof: "deadbeef",
    publicInputs: "00".repeat(32),
    generatedAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports proof validity from the circuit verifier", async () => {
    (verifyViewDisclosure as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (queryContract as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await verifyViewDisclosureBundle(BUNDLE);
    expect(result.proofValid).toBe(true);
  });

  it("reports an invalid proof", async () => {
    (verifyViewDisclosure as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    (queryContract as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await verifyViewDisclosureBundle(BUNDLE);
    expect(result.proofValid).toBe(false);
  });

  it("reports rootKnown as null when the root check can't be completed", async () => {
    (verifyViewDisclosure as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (queryContract as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("rpc down"));

    const result = await verifyViewDisclosureBundle(BUNDLE);
    expect(result.rootKnown).toBeNull();
  });
});
