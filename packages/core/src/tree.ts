/**
 * Merkle tree reconstruction for the DShield shielded pool.
 *
 * This is the single definition of "how the pool's tree is built" shared by
 * every client that needs to reconstruct a withdrawal proof's `pathSiblings`
 * / `pathBits` from an ordered commitment list: the frontend (in-browser),
 * the standalone indexer service, and any future CLI. The pool contract
 * (contracts/pool/src/lib.rs, `insert_commitment`) is the authoritative
 * implementation; this module must agree with it byte for byte, or a proof
 * built from a locally reconstructed path will not verify against the
 * on-chain root.
 *
 * The two-argument hash is injected rather than baked in, so this module has
 * no dependency on how a particular runtime computes Poseidon2 (a Noir/WASM
 * circuit in the browser and in the indexer service today, potentially a
 * native implementation elsewhere tomorrow) and can be unit-tested with a
 * trivial fake hash.
 */

/** A binary hash of two field elements, each a 0x-prefixed hex string. */
export type Hash2 = (a: string, b: string) => Promise<string>;

/** Depth of the pool's Merkle tree — must match `TREE_DEPTH` in the Noir circuits and `TREE_HEIGHT` in the pool contract. */
export const TREE_DEPTH = 20;

export const EMPTY_LEAF = "0x" + "00".repeat(32);

export function ensureHex(v: string): string {
  return v.startsWith("0x") ? v : "0x" + v;
}

/**
 * Precomputes the "empty subtree" hash at every level: `zeroes[0]` is the
 * empty leaf, `zeroes[d+1] = hash(zeroes[d], zeroes[d])`. Used to fill in
 * positions the tree hasn't grown into yet, exactly as the pool contract's
 * `zeroes_for_tree` does.
 */
export async function computeZeroHashes(
  hash2: Hash2,
  depth: number = TREE_DEPTH,
): Promise<string[]> {
  const zeroes: string[] = [EMPTY_LEAF];
  let cur = EMPTY_LEAF;
  for (let i = 0; i < depth; i++) {
    cur = await hash2(cur, cur);
    zeroes.push(cur);
  }
  return zeroes;
}

export interface MerkleProof {
  root: string;
  pathSiblings: string[];
  pathBits: number[];
}

/**
 * Rebuilds the full Merkle tree bottom-up from an ordered leaf/commitment
 * list and returns the current root, plus the sibling path to `targetIndex`.
 *
 * Missing leaves (anywhere from `commitments.length` up to `targetIndex`,
 * inclusive) are treated as the empty leaf, matching the pool contract's
 * behavior for indices the tree hasn't grown into yet.
 */
export async function buildMerkleTree(
  hash2: Hash2,
  commitments: string[],
  targetIndex: number,
  depth: number = TREE_DEPTH,
  zeroHashes?: string[],
): Promise<MerkleProof> {
  if (targetIndex < 0) {
    throw new Error(`targetIndex must be non-negative, got ${targetIndex}`);
  }
  const zeroes = zeroHashes ?? (await computeZeroHashes(hash2, depth));
  const n = commitments.length;

  const leaves: string[] = [];
  for (let i = 0; i < Math.max(n, targetIndex + 1); i++) {
    leaves.push(i < n ? ensureHex(commitments[i]) : zeroes[0]);
  }

  let currentLevel = leaves;
  const pathSiblings: string[] = [];
  const pathBits: number[] = [];
  let targetIdx = targetIndex;

  for (let level = 0; level < depth; level++) {
    const bit = targetIdx & 1;
    pathBits.push(bit);

    const siblingIdx = targetIdx ^ 1;
    if (siblingIdx < currentLevel.length) {
      pathSiblings.push(currentLevel[siblingIdx]);
    } else {
      pathSiblings.push(zeroes[level]);
    }

    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right =
        i + 1 < currentLevel.length ? currentLevel[i + 1] : zeroes[level];
      nextLevel.push(await hash2(left, right));
    }

    if (nextLevel.length === 0) {
      nextLevel.push(zeroes[level + 1]);
    }

    currentLevel = nextLevel;
    targetIdx = targetIdx >> 1;
  }

  return {
    root: currentLevel[0],
    pathSiblings,
    pathBits,
  };
}

/**
 * Convenience wrapper for callers that only want the current root (e.g. a
 * "what root does this commitment set produce" health check) and don't need
 * a sibling path. Costs the same as `buildMerkleTree` — every level is
 * computed regardless of which leaf's path is requested — so this is just
 * `buildMerkleTree` with an arbitrary in-range target index discarded.
 */
export async function computeRoot(
  hash2: Hash2,
  commitments: string[],
  depth: number = TREE_DEPTH,
  zeroHashes?: string[],
): Promise<string> {
  const { root } = await buildMerkleTree(
    hash2,
    commitments,
    0,
    depth,
    zeroHashes,
  );
  return root;
}
