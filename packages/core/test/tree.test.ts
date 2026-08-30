import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  computeZeroHashes,
  buildMerkleTree,
  computeRoot,
  EMPTY_LEAF,
  ensureHex,
  type Hash2,
} from "../src/tree.js";

/**
 * A fast, deterministic stand-in for Poseidon2. It has none of Poseidon2's
 * cryptographic properties, but for testing the tree-walking logic in
 * isolation all that matters is that it's a consistent binary function of
 * its two inputs — the real hasher is exercised separately in
 * services/indexer's fixture test, where its output must match the on-chain
 * root.
 */
const fakeHash2: Hash2 = async (a, b) =>
  "0x" + createHash("sha256").update(a + b).digest("hex").slice(0, 64);

function leaf(n: number): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

describe("computeZeroHashes", () => {
  it("starts with the empty leaf and has depth+1 entries", async () => {
    const zeroes = await computeZeroHashes(fakeHash2, 4);
    expect(zeroes).toHaveLength(5);
    expect(zeroes[0]).toBe(EMPTY_LEAF);
  });

  it("each level is the hash of the previous level with itself", async () => {
    const zeroes = await computeZeroHashes(fakeHash2, 3);
    for (let i = 0; i < 3; i++) {
      expect(zeroes[i + 1]).toBe(await fakeHash2(zeroes[i], zeroes[i]));
    }
  });
});

describe("buildMerkleTree", () => {
  it("an empty tree's root is the top-level zero hash", async () => {
    const zeroes = await computeZeroHashes(fakeHash2, 4);
    const { root } = await buildMerkleTree(fakeHash2, [], 0, 4);
    expect(root).toBe(zeroes[4]);
  });

  it("matches a hand-computed root for two leaves at depth 1", async () => {
    const l0 = leaf(0xaa);
    const l1 = leaf(0xbb);
    const expectedRoot = await fakeHash2(l0, l1);

    const proof0 = await buildMerkleTree(fakeHash2, [l0, l1], 0, 1);
    expect(proof0.root).toBe(expectedRoot);
    expect(proof0.pathBits).toEqual([0]);
    expect(proof0.pathSiblings).toEqual([l1]);

    const proof1 = await buildMerkleTree(fakeHash2, [l0, l1], 1, 1);
    expect(proof1.root).toBe(expectedRoot);
    expect(proof1.pathBits).toEqual([1]);
    expect(proof1.pathSiblings).toEqual([l0]);
  });

  it("root does not depend on which leaf's path was requested", async () => {
    const commitments = [leaf(1), leaf(2), leaf(3), leaf(4), leaf(5)];
    const roots = await Promise.all(
      [0, 1, 2, 3, 4].map(
        async (i) => (await buildMerkleTree(fakeHash2, commitments, i, 6)).root,
      ),
    );
    expect(new Set(roots).size).toBe(1);
  });

  it("computeRoot agrees with buildMerkleTree's root", async () => {
    const commitments = [leaf(1), leaf(2), leaf(3)];
    const { root } = await buildMerkleTree(fakeHash2, commitments, 0, 5);
    expect(await computeRoot(fakeHash2, commitments, 5)).toBe(root);
  });

  it("a path verifies by walking pathSiblings/pathBits back up to the root", async () => {
    const commitments = [leaf(10), leaf(20), leaf(30), leaf(40), leaf(50)];
    const targetIndex = 3;
    const { root, pathSiblings, pathBits } = await buildMerkleTree(
      fakeHash2,
      commitments,
      targetIndex,
      8,
    );

    let node = ensureHex(commitments[targetIndex]);
    for (let i = 0; i < pathBits.length; i++) {
      node =
        pathBits[i] === 0
          ? await fakeHash2(node, pathSiblings[i])
          : await fakeHash2(pathSiblings[i], node);
    }
    expect(node).toBe(root);
  });

  it("treats indices beyond the commitment list as empty leaves", async () => {
    const commitments = [leaf(1)];
    // targetIndex 3 is beyond the single known commitment; the tree must
    // still extend out to cover it, padding with the empty leaf.
    const { root } = await buildMerkleTree(fakeHash2, commitments, 3, 4);
    const zeroes = await computeZeroHashes(fakeHash2, 4);
    // Rebuilding by hand: leaves [c0, 0, 0, 0] (padded to targetIndex+1=4),
    // then two more levels combining with the zero-subtree hash to reach the
    // fixed tree depth of 4.
    const l01 = await fakeHash2(ensureHex(commitments[0]), zeroes[0]);
    const l23 = await fakeHash2(zeroes[0], zeroes[0]);
    const level1 = await fakeHash2(l01, l23);
    const level2 = await fakeHash2(level1, zeroes[2]);
    const expectedRoot = await fakeHash2(level2, zeroes[3]);
    expect(root).toBe(expectedRoot);
  });

  it("rejects a negative target index", async () => {
    await expect(buildMerkleTree(fakeHash2, [], -1, 4)).rejects.toThrow();
  });
});
