import * as StellarSdk from "@stellar/stellar-sdk";
import { computeNullifierHash } from "./poseidon2";
import { queryContract, POOL_CONTRACT_ID } from "./stellar";
import { getNotes, markNoteSpent } from "./notes";

/**
 * Checks every unspent note against the on-chain nullifier set and marks any
 * that have already been withdrawn (by this device or another). Returns the
 * number of notes newly marked as spent.
 */
export async function syncSpentNotes(): Promise<number> {
  const unspent = getNotes().filter((n) => !n.spent);
  let count = 0;
  for (const note of unspent) {
    const poolId = note.poolId || POOL_CONTRACT_ID;
    if (!poolId) continue;
    try {
      const nullifierHash = await computeNullifierHash(note.nullifier);
      const val = await queryContract(poolId, "is_nullifier_used", [
        StellarSdk.xdr.ScVal.scvBytes(
          Buffer.from(nullifierHash.replace(/^0x/, ""), "hex"),
        ),
      ]);
      if (val && StellarSdk.scValToNative(val) === true) {
        await markNoteSpent(note.commitment);
        count++;
      }
    } catch {
      // Best-effort — skip notes that fail to check
    }
  }
  return count;
}
