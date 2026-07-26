import * as StellarSdk from "@stellar/stellar-sdk";
import { POOL_CONTRACT_ID, queryContract } from "./stellar";
import { computeCommitment, computeNullifierHash } from "./poseidon2";
import { fetchCommitmentsFromChain, lookupNoteTxs } from "./indexer";
import { type ShieldedNote } from "./notes";
import { getNetworkLabel } from "./explorer";
import { stroopsToUsdc } from "./format";

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

/**
 * Build a compliance report for a note from authoritative on-chain data.
 * Deliberately omits amounts, addresses, AND the note itself (nullifier +
 * secret): the note is a bearer-spendable credential, so embedding it in a
 * report meant to be shared with a third party (an auditor, a PDF export)
 * would hand them the ability to withdraw the funds. Reproducing this report
 * requires the note out of band, from the holder directly.
 */
export async function buildComplianceReport(
  note: ShieldedNote,
): Promise<ComplianceReport> {
  const poolId = note.poolId || POOL_CONTRACT_ID;
  if (!poolId) throw new Error("No pool configured for this note.");

  // Re-derive the commitment and nullifier hash from the note's secrets.
  const commitment = await computeCommitment(note.nullifier, note.secret);
  const nullifierHash = await computeNullifierHash(note.nullifier);
  const commitmentClean = commitment.replace(/^0x/, "").toLowerCase();
  const integrityOk =
    commitmentClean === note.commitment.replace(/^0x/, "").toLowerCase();

  // Deposit confirmation: is the commitment in the pool's authoritative list?
  const chainCommitments = await fetchCommitmentsFromChain(poolId);
  let leafIndex: number | null = null;
  if (chainCommitments) {
    const idx = chainCommitments.findIndex(
      (c) => c.replace(/^0x/, "").toLowerCase() === commitmentClean,
    );
    if (idx >= 0) leafIndex = idx;
  }
  const depositConfirmed = leafIndex !== null;

  // Withdrawal status: has the nullifier been spent on-chain?
  let withdrawn = false;
  const usedVal = await queryContract(poolId, "is_nullifier_used", [
    StellarSdk.xdr.ScVal.scvBytes(
      Buffer.from(nullifierHash.replace(/^0x/, ""), "hex"),
    ),
  ]);
  if (usedVal) withdrawn = StellarSdk.scValToNative(usedVal) === true;

  // Best-effort: link the actual deposit/withdraw transactions.
  const txs = await lookupNoteTxs(poolId, commitment, nullifierHash);

  return {
    network: getNetworkLabel(),
    poolId,
    commitment,
    nullifierHash,
    integrityOk,
    depositConfirmed,
    leafIndex,
    withdrawn,
    depositTx: txs.depositTx,
    withdrawTx: txs.withdrawTx,
    generatedAt: Date.now(),
  };
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

/** A single row of the history page's activity feed — deposit, withdrawal, or KYC registration. */
export interface ActivityItem {
  type: "deposit" | "withdrawal" | "compliance";
  timestamp: number;
  commitment: string;
  amount: string;
  poolId?: string;
}

/**
 * Column order/meaning for {@link formatActivityCsv} and
 * {@link formatActivityJson}: `type` (deposit|withdrawal|compliance), `date`
 * (ISO 8601), `amount_usdc` / `amount_stroops` (blank for compliance rows,
 * which carry no amount), `commitment` (the KYC hash for compliance rows),
 * and `pool_id` (blank for compliance rows).
 */
const ACTIVITY_CSV_COLUMNS = [
  "type",
  "date",
  "amount_usdc",
  "amount_stroops",
  "commitment",
  "pool_id",
] as const;

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render activity rows as CSV. See {@link ACTIVITY_CSV_COLUMNS} for the column list. */
export function formatActivityCsv(items: ActivityItem[]): string {
  const rows = items.map((item) => {
    const isCompliance = item.type === "compliance";
    return [
      item.type,
      new Date(item.timestamp).toISOString(),
      isCompliance ? "" : stroopsToUsdc(item.amount),
      isCompliance ? "" : item.amount,
      item.commitment,
      item.poolId ?? "",
    ]
      .map(csvEscape)
      .join(",");
  });
  return [ACTIVITY_CSV_COLUMNS.join(","), ...rows].join("\n");
}

/** Render activity rows as JSON. Same fields as {@link formatActivityCsv}, one object per row. */
export function formatActivityJson(items: ActivityItem[]): string {
  const data = items.map((item) => {
    const isCompliance = item.type === "compliance";
    return {
      type: item.type,
      date: new Date(item.timestamp).toISOString(),
      amountUsdc: isCompliance ? null : stroopsToUsdc(item.amount),
      amountStroops: isCompliance ? null : item.amount,
      commitment: item.commitment,
      poolId: item.poolId ?? null,
    };
  });
  return JSON.stringify(data, null, 2);
}
