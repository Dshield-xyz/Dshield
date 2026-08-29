import * as StellarSdk from "@stellar/stellar-sdk";
import { POOL_CONTRACT_ID, queryContract } from "./stellar";
import { fetchCommitmentsFromChain, lookupNoteTxs } from "./indexer";
import { type ShieldedNote } from "./notes";
import { getNetworkLabel } from "./explorer";
import { formatAmountBare } from "./format";
import {
  computeReportIdentity,
  formatReportText,
  type ComplianceReport,
} from "@dshield/core/report";

// The report shape + text renderer are shared with the CLI via @dshield/core;
// re-exported here so the app keeps importing them from `@/lib/report`.
export { formatReportText };
export type { ComplianceReport };

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

  // Re-derive the commitment and nullifier hash from the note's secrets using
  // the shared @dshield/core logic. The amount is part of the commitment, so
  // this also checks the note's recorded value against what it actually claims
  // on-chain: a note whose amount was edited no longer hashes to a leaf the
  // pool holds, and `integrityOk` fails.
  const { commitment, nullifierHash, integrityOk } =
    await computeReportIdentity(note);
  const commitmentClean = commitment.replace(/^0x/, "").toLowerCase();

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
      isCompliance ? "" : formatAmountBare(item.amount),
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
      amountUsdc: isCompliance ? null : formatAmountBare(item.amount),
      amountStroops: isCompliance ? null : item.amount,
      commitment: item.commitment,
      poolId: item.poolId ?? null,
    };
  });
  return JSON.stringify(data, null, 2);
}
