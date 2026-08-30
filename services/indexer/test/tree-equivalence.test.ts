import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { buildMerkleTree } from "@dshield/core";
import { CommitmentStore } from "../src/store.js";
import { buildProof } from "../src/tree.js";
import { poseidon2Hash } from "../src/poseidon.js";
import depositEvents from "./fixtures/deposit-events.json";
import withdrawEvents from "./fixtures/withdraw-events.json";

const FIXTURE_POOL_ID = "POOL_FIXTURE";

let tmpDir: string | null = null;

function freshStore(): CommitmentStore {
  tmpDir = mkdtempSync(path.join(tmpdir(), "dshield-indexer-test-"));
  return new CommitmentStore(path.join(tmpDir, "store.json"), FIXTURE_POOL_ID);
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe("service tree reconstruction against a fixture set of deposit/withdraw events", () => {
  it("applying the fixture deposit events yields the same commitment list a direct scan would", () => {
    const store = freshStore();
    for (const event of depositEvents) {
      store.setCommitment(event.leafIndex, event.commitment);
    }

    expect(store.leafCount).toBe(depositEvents.length);
    for (const event of depositEvents) {
      expect(store.commitments[event.leafIndex]).toBe(event.commitment);
    }
  });

  it("records withdraw events as spent nullifiers", () => {
    const store = freshStore();
    for (const event of withdrawEvents) {
      store.addSpentNullifier(event.nullifierHash);
    }
    for (const event of withdrawEvents) {
      expect(store.isNullifierSpent(event.nullifierHash)).toBe(true);
    }
    expect(store.isNullifierSpent("0x" + "ff".repeat(32))).toBe(false);
  });

  it(
    "produces the same root and Merkle path as building the tree directly from the raw commitment list",
    async () => {
      const store = freshStore();
      for (const event of depositEvents) {
        store.setCommitment(event.leafIndex, event.commitment);
      }
      const commitments = [...store.commitments];

      // Path A: what the service's HTTP API actually returns.
      const servicePathToLeaf2 = await buildProof(poseidon2Hash, commitments, 2);

      // Path B: a client (or a test) independently reconstructing the tree
      // from the same ordered commitment list a direct RPC scan would have
      // produced. If the service disagrees with this, a proof it serves
      // will not verify against the pool's actual on-chain root.
      const directPathToLeaf2 = await buildMerkleTree(poseidon2Hash, commitments, 2);

      expect(servicePathToLeaf2.root).toBe(directPathToLeaf2.root);
      expect(servicePathToLeaf2.pathSiblings).toEqual(directPathToLeaf2.pathSiblings);
      expect(servicePathToLeaf2.pathBits).toEqual(directPathToLeaf2.pathBits);
    },
    20000,
  );

  it(
    "every leaf's served proof verifies by walking pathSiblings/pathBits back up to the served root",
    async () => {
      const store = freshStore();
      for (const event of depositEvents) {
        store.setCommitment(event.leafIndex, event.commitment);
      }
      const commitments = [...store.commitments];

      for (let leafIndex = 0; leafIndex < commitments.length; leafIndex++) {
        const { root, pathSiblings, pathBits } = await buildProof(
          poseidon2Hash,
          commitments,
          leafIndex,
        );

        let node = commitments[leafIndex];
        for (let i = 0; i < pathBits.length; i++) {
          node =
            pathBits[i] === 0
              ? await poseidon2Hash(node, pathSiblings[i])
              : await poseidon2Hash(pathSiblings[i], node);
        }
        expect(node).toBe(root);
      }
    },
    30000,
  );
});
