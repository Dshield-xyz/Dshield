import { computeCommitment, computeNullifierHash } from "./poseidon2";
import type { ShieldedNote } from "./notes";

export interface ComplianceReport {
  network: string;
  poolId: string;
  /** 0x-prefixed 32-byte commitment, recomputed from the note. */
  commitment: string;
  /** 0x-prefixed 32-byte nullifier hash, derived from the note. */
  nullifierHash: string;
  /** Whether the commitment recomputed from the note matches the note's stored commitment. */
  integrityOk: boolean;
  /** The commitment was found in the pool's on-chain commitment list. */
  depositConfirmed: boolean;
  /** Leaf index of the commitment on-chain, or null if not found. */
  leafIndex: number | null;
  /** The nullifier has been spent on-chain (funds withdrawn). */
  withdrawn: boolean;
  depositTx: { hash: string; at: string } | null;
  withdrawTx: { hash: string; at: string } | null;
  generatedAt: number;
}

export interface ReportIdentity {
  /** 0x-prefixed 32-byte commitment, recomputed from the note's secrets + amount. */
  commitment: string;
  /** 0x-prefixed 32-byte nullifier hash, derived from the note's nullifier. */
  nullifierHash: string;
  /** The recomputed commitment matches the one stored in the note. */
  integrityOk: boolean;
}

/**
 * Re-derive the commitment and nullifier hash from a note's secrets. The amount
 * is part of the commitment, so this also checks the note's recorded value
 * against what it claims on-chain: a note whose amount was edited no longer
 * hashes to a leaf the pool holds, and `integrityOk` fails.
 *
 * This is the note-only, offline half of a compliance report — shared by the
 * frontend and the CLI so both derive identity the exact same way. The on-chain
 * half (deposit confirmation, withdrawal status, tx links) is layered on by the
 * caller using its own chain client.
 */
export async function computeReportIdentity(
  note: ShieldedNote,
): Promise<ReportIdentity> {
  const commitment = await computeCommitment(
    note.nullifier,
    note.secret,
    note.amount,
  );
  const nullifierHash = await computeNullifierHash(note.nullifier);
  const commitmentClean = commitment.replace(/^0x/, "").toLowerCase();
  const integrityOk =
    commitmentClean === note.commitment.replace(/^0x/, "").toLowerCase();
  return { commitment, nullifierHash, integrityOk };
}

/** Render a report as plain text for download / inspection. */
export function formatReportText(r: ComplianceReport): string {
  const line = (k: string, v: string) => `${k.padEnd(20)}${v}`;
  return [
    "DShield Compliance Report",
    "=========================",
    line("Generated", new Date(r.generatedAt).toISOString()),
    line("Network", r.network),
    line("Pool contract", r.poolId),
    "",
    line("Note integrity", r.integrityOk ? "OK (commitment matches)" : "MISMATCH"),
    line(
      "Deposit",
      r.depositConfirmed
        ? `Confirmed on-chain (leaf #${r.leafIndex})`
        : "Not found on-chain",
    ),
    line("Status", r.withdrawn ? "Withdrawn (nullifier spent)" : "In pool (unspent)"),
    line("Commitment", r.commitment),
    line("Nullifier hash", r.nullifierHash),
    r.depositTx
      ? line("Deposit tx", `${r.depositTx.hash} (${r.depositTx.at})`)
      : line("Deposit tx", "n/a (outside event retention)"),
    r.withdrawTx
      ? line("Withdraw tx", `${r.withdrawTx.hash} (${r.withdrawTx.at})`)
      : line("Withdraw tx", r.withdrawn ? "n/a (outside event retention)" : "—"),
  ].join("\n");
}
