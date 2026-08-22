import * as StellarSdk from "@stellar/stellar-sdk";
import { computeNullifierHash } from "./poseidon2";
import { queryContract, POOL_CONTRACT_ID } from "./stellar";
import {
  getNotes,
  getPendingNotes,
  markNoteSpent,
  setNoteLeafIndex,
  type ShieldedNote,
} from "./notes";

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

/**
 * Asks the pool which leaf a commitment landed on. Returns null if the pool
 * hasn't recorded it (yet) or the query fails.
 */
export async function fetchLeafIndex(note: ShieldedNote): Promise<number | null> {
  const poolId = note.poolId || POOL_CONTRACT_ID;
  if (!poolId) return null;
  try {
    const val = await queryContract(poolId, "get_commitment_index", [
      StellarSdk.xdr.ScVal.scvBytes(
        Buffer.from(note.commitment.replace(/^0x/, ""), "hex"),
      ),
    ]);
    if (!val) return null;
    const index = StellarSdk.scValToNative(val) as number | null | undefined;
    return typeof index === "number" ? index : null;
  } catch {
    return null;
  }
}

/**
 * Settles notes whose leaf index isn't known yet, and returns how many moved.
 *
 * Two things create them. A withdrawal mints its change note in the same
 * transaction, so the slot it lands on isn't knowable when the note is saved —
 * it is stored before submission anyway, because losing it would lose the
 * funds. A deposit can't reserve a slot either: the index it reads before
 * signing is only a prediction, and any deposit or withdrawal that confirms
 * first takes it. Both are settled here by asking the pool where the
 * commitment actually ended up.
 *
 * A note that stays unresolved simply hasn't confirmed yet; it is not lost, and
 * the next call picks it up.
 */
export async function resolvePendingLeafIndexes(): Promise<number> {
  let resolved = 0;
  for (const note of getPendingNotes()) {
    const index = await fetchLeafIndex(note);
    if (index !== null) {
      setNoteLeafIndex(note.commitment, index);
      resolved++;
    }
  }
  return resolved;
}
