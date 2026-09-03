import { describe, it, expect } from "vitest";
import {
  poseidon2Hash,
  computeCommitment,
  computeNullifierHash,
  buildMerkleTree,
  normalizeField,
} from "./poseidon2.js";

const ZERO_32 = "0x" + "00".repeat(32);
const KNOWN_ZERO_HASH =
  "0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1";
const KNOWN_NULLIFIER_HASH =
  "0x162e3a2744c870a14bcdbd4028e3400ba6ae1d2e869fa850b1b411e57a370e04";
// hash_leaf(nullifier=1234, secret=5678, amount=1000000) as computed by the
// Noir circuits — the exact fixture in circuits/shielded_pool/Prover.toml.
// Pinning it here is what keeps the TypeScript hasher in @dshield/core from
// drifting from the circuit and the on-chain contract: if any of the three
// disagree, every note the app or CLI mints becomes unwithdrawable.
const KNOWN_LEAF =
  "0x16111c32922f91c6807ea7b21de7ce3164cec5defead888c64e8d33451507952";

describe("normalizeField", () => {
  it("left-pads a value whose top byte is zero to 32 bytes", () => {
    expect(
      normalizeField("0x301b2607fdf1a5aed8e781d63cd1b03545333687293c81aceeb7e9ea61c140"),
    ).toBe(
      "0x00301b2607fdf1a5aed8e781d63cd1b03545333687293c81aceeb7e9ea61c140",
    );
  });

  it("throws if the value exceeds 32 bytes", () => {
    expect(() => normalizeField("0x" + "ff".repeat(33))).toThrow();
  });
});

describe("poseidon2Hash", () => {
  it("hashes two zero fields to the known zero hash", async () => {
    expect(await poseidon2Hash(ZERO_32, ZERO_32)).toBe(KNOWN_ZERO_HASH);
  });
});

describe("computeCommitment", () => {
  it("matches the Noir circuits' hash_leaf for the shared fixture", async () => {
    expect(await computeCommitment("04d2", "162e", "1000000")).toBe(KNOWN_LEAF);
  });

  it("binds the amount: same secrets with a different value differ", async () => {
    const a = await computeCommitment("00aabb", "00ccdd", "1000000");
    const b = await computeCommitment("00aabb", "00ccdd", "1000001");
    expect(a).not.toBe(b);
  });
});

describe("computeNullifierHash", () => {
  it("matches the circuit's nullifier hash for the shared fixture", async () => {
    expect(await computeNullifierHash("04d2")).toBe(KNOWN_NULLIFIER_HASH);
  });
});

describe("buildMerkleTree", () => {
  it("produces a 20-deep path and a defined root for a single leaf", async () => {
    const { root, pathSiblings, pathBits } = await buildMerkleTree([KNOWN_LEAF], 0);
    expect(pathSiblings).toHaveLength(20);
    expect(pathBits).toHaveLength(20);
    expect(root.startsWith("0x")).toBe(true);
    expect(root.length).toBe(66);
  });
});
