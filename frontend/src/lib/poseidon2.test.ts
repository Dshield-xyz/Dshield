import { describe, it, expect } from "vitest";
import {
  poseidon2Hash,
  computeCommitment,
  computeNullifierHash,
  getZeroHashes,
  buildMerkleTree,
  normalizeField,
} from "./poseidon2";

const ZERO_32 = "0x" + "00".repeat(32);
const KNOWN_ZERO_HASH =
  "0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1";
const KNOWN_NULLIFIER_HASH =
  "0x162e3a2744c870a14bcdbd4028e3400ba6ae1d2e869fa850b1b411e57a370e04";

describe("normalizeField", () => {
  it("left-pads a value whose top byte is zero to 32 bytes", () => {
    // Regression: the Noir hasher returns this root unpadded; on-chain it is a
    // full 32-byte value. They must compare equal after normalization.
    expect(
      normalizeField("0x301b2607fdf1a5aed8e781d63cd1b03545333687293c81aceeb7e9ea61c140"),
    ).toBe(
      "0x00301b2607fdf1a5aed8e781d63cd1b03545333687293c81aceeb7e9ea61c140",
    );
  });

  it("leaves a full 32-byte value unchanged", () => {
    const full =
      "0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1";
    expect(normalizeField(full)).toBe(full);
  });

  it("adds the 0x prefix and pads when missing", () => {
    expect(normalizeField("04d2")).toBe("0x" + "04d2".padStart(64, "0"));
  });

  it("always yields 32 bytes (66 chars with 0x)", () => {
    expect(normalizeField("0x1").length).toBe(66);
  });

  it("throws if the value exceeds 32 bytes", () => {
    expect(() => normalizeField("0x" + "ff".repeat(33))).toThrow();
  });
});

describe("poseidon2Hash", () => {
  it("hashes two zero fields to the known zero hash", async () => {
    const result = await poseidon2Hash(ZERO_32, ZERO_32);
    expect(result).toBe(KNOWN_ZERO_HASH);
  });

  it("returns a hex string starting with 0x", async () => {
    const result = await poseidon2Hash("1", "2");
    expect(result.startsWith("0x")).toBe(true);
    expect(result.length).toBeGreaterThan(2);
  });
});

describe("computeCommitment", () => {
  it("returns a hex string", async () => {
    const result = await computeCommitment("00aabb", "00ccdd");
    expect(result.startsWith("0x")).toBe(true);
  });

  it("is deterministic", async () => {
    const a = await computeCommitment("00aabb", "00ccdd");
    const b = await computeCommitment("00aabb", "00ccdd");
    expect(a).toBe(b);
  });

  it("differs with different inputs", async () => {
    const a = await computeCommitment("00aabb", "00ccdd");
    const b = await computeCommitment("00ccdd", "00aabb");
    expect(a).not.toBe(b);
  });
});

describe("computeNullifierHash", () => {
  it("matches the known hash for field value 1234 (0x04d2)", async () => {
    const result = await computeNullifierHash("04d2");
    expect(result).toBe(KNOWN_NULLIFIER_HASH);
  });
});

describe("getZeroHashes", () => {
  it("returns 21 elements (depth 0 through 20)", async () => {
    const zeroes = await getZeroHashes();
    expect(zeroes).toHaveLength(21);
  });

  it("first element is 32 zero bytes", async () => {
    const zeroes = await getZeroHashes();
    expect(zeroes[0]).toBe(ZERO_32);
  });

  it("second element is the known zero hash", async () => {
    const zeroes = await getZeroHashes();
    expect(zeroes[1]).toBe(KNOWN_ZERO_HASH);
  });

  it("all elements start with 0x", async () => {
    const zeroes = await getZeroHashes();
    for (const z of zeroes) {
      expect(z.startsWith("0x")).toBe(true);
    }
  });
});

describe("buildMerkleTree", () => {
  it("returns 20-element pathSiblings and pathBits for 1 leaf", async () => {
    const commitment = await computeCommitment("00aabb", "00ccdd");
    const proof = await buildMerkleTree([commitment], 0);
    expect(proof.pathSiblings).toHaveLength(20);
    expect(proof.pathBits).toHaveLength(20);
    expect(proof.root.startsWith("0x")).toBe(true);
  });

  it("pathBits are all 0 for index 0", async () => {
    const commitment = await computeCommitment("00aabb", "00ccdd");
    const proof = await buildMerkleTree([commitment], 0);
    expect(proof.pathBits.every((b) => b === 0)).toBe(true);
  });

  it("pathBits for index 1 starts with 1", async () => {
    const c0 = await computeCommitment("001111", "002222");
    const c1 = await computeCommitment("003333", "004444");
    const proof = await buildMerkleTree([c0, c1], 1);
    expect(proof.pathBits[0]).toBe(1);
  });

  it("siblings at index 0 with 1 leaf are all zero hashes", async () => {
    const zeroes = await getZeroHashes();
    const commitment = await computeCommitment("00aabb", "00ccdd");
    const proof = await buildMerkleTree([commitment], 0);
    for (let i = 0; i < 20; i++) {
      expect(proof.pathSiblings[i]).toBe(zeroes[i]);
    }
  });

  it("produces different roots for different commitments", async () => {
    const c1 = await computeCommitment("001111", "002222");
    const c2 = await computeCommitment("003333", "004444");
    const proof1 = await buildMerkleTree([c1], 0);
    const proof2 = await buildMerkleTree([c2], 0);
    expect(proof1.root).not.toBe(proof2.root);
  });

  it("2-leaf tree has different root than 1-leaf tree", async () => {
    const c0 = await computeCommitment("001111", "002222");
    const c1 = await computeCommitment("003333", "004444");
    const proof1Leaf = await buildMerkleTree([c0], 0);
    const proof2Leaves = await buildMerkleTree([c0, c1], 0);
    expect(proof1Leaf.root).not.toBe(proof2Leaves.root);
    expect(proof2Leaves.pathSiblings).toHaveLength(20);
    expect(proof2Leaves.pathBits).toHaveLength(20);
  });

  it("2-leaf tree: sibling at level 0 for index 0 is the other leaf", async () => {
    const c0 = await computeCommitment("001111", "002222");
    const c1 = await computeCommitment("003333", "004444");
    const proof = await buildMerkleTree([c0, c1], 0);
    expect(proof.pathSiblings[0].toLowerCase()).toBe(c1.toLowerCase());
  });
});
