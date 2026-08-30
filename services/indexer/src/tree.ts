import {
  buildMerkleTree,
  computeZeroHashes,
  TREE_DEPTH,
  type Hash2,
  type MerkleProof,
} from "@dshield/core";

// The zero-subtree hashes depend only on the hash function and tree depth,
// never on the commitment set, so they're computed once and reused for
// every request instead of recomputing 20 hashes per call.
let zeroHashesCache: string[] | null = null;

async function getCachedZeroHashes(hash2: Hash2): Promise<string[]> {
  if (!zeroHashesCache) {
    zeroHashesCache = await computeZeroHashes(hash2, TREE_DEPTH);
  }
  return zeroHashesCache;
}

/** Rebuilds the tree over the current commitment set and returns the sibling path to `leafIndex`. */
export async function buildProof(
  hash2: Hash2,
  commitments: readonly string[],
  leafIndex: number,
): Promise<MerkleProof> {
  const zeroes = await getCachedZeroHashes(hash2);
  return buildMerkleTree(hash2, [...commitments], leafIndex, TREE_DEPTH, zeroes);
}

/** Rebuilds the tree and returns only the current root. */
export async function buildRoot(
  hash2: Hash2,
  commitments: readonly string[],
): Promise<string> {
  const { root } = await buildProof(hash2, commitments, 0);
  return root;
}
