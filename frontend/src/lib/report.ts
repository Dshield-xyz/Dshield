import * as StellarSdk from "@stellar/stellar-sdk";
import { POOL_CONTRACT_ID, queryContract } from "./stellar";
import { computeCommitment, computeNullifierHash, assetToField } from "./poseidon2";
import { fetchCommitmentsFromChain, lookupNoteTxs } from "./indexer";
import { type ShieldedNote } from "./notes";
import { getNetworkLabel } from "./explorer";
import { fromBaseUnits } from "./format";
import { formatReportText, type ComplianceReport } from "@dshield/core/report";

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

  // Re-derive the commitment and nullifier hash from the note's secrets. The
  // amount is part of the commitment, so this also checks the note's recorded
  // value against what it actually claims on-chain: a note whose amount was
  // edited no longer hashes to a leaf the pool holds, and `integrityOk` fails.
  const assetField = await assetToField(note.asset);
  const commitment = await computeCommitment(
    note.nullifier,
    note.secret,
    note.amount,
    assetField,
  );
  const nullifierHash = await computeNullifierHash(note.nullifier);
  const commitmentClean = commitment.replace(/^0x/, "").toLowerCase();
  // The recomputed commitment must match the note's own recorded commitment,
  // or the note was tampered with (or its amount/asset edited) after minting.
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

/** A single row of the history page's activity feed — deposit, withdrawal, or KYC registration. */
export interface ActivityItem {
  type: "deposit" | "withdrawal" | "compliance";
  timestamp: number;
  commitment: string;
  amount: string;
  /**
   * SEP-41 asset the amount is denominated in. Empty for compliance rows,
   * which carry no amount at all.
   */
  asset: string;
  poolId?: string;
}

/**
 * Column order/meaning for {@link formatActivityCsv} and
 * {@link formatActivityJson}: `type` (deposit|withdrawal|compliance), `date`
 * (ISO 8601), `amount` / `amount_base_units` and the `asset` they are
 * denominated in (all blank for compliance rows, which carry no amount),
 * `commitment` (the KYC hash for compliance rows), and `pool_id` (blank for
 * compliance rows).
 *
 * `amount_base_units` is the authoritative figure — it is exactly what the
 * chain stores. `amount` is the same value scaled for reading, which needs the
 * asset's precision; without a {@link DecimalsLookup} it falls back to the
 * 7-decimal Stellar Asset Contract convention, so a row of a token with other
 * precision would read wrong. That is why `asset` is exported alongside.
 */
const ACTIVITY_CSV_COLUMNS = [
  "type",
  "date",
  "amount",
  "amount_base_units",
  "asset",
  "commitment",
  "pool_id",
] as const;

/**
 * Resolves an asset's decimal precision. Callers that know the pool's assets
 * (the history page does — see useNoteFormatter) pass one so exports render at
 * each asset's real precision.
 */
export type DecimalsLookup = (asset: string) => number;

function csvEscape(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Render activity rows as CSV. See {@link ACTIVITY_CSV_COLUMNS} for the column list. */
export function formatActivityCsv(
  items: ActivityItem[],
  decimalsFor?: DecimalsLookup,
): string {
  const rows = items.map((item) => {
    const isCompliance = item.type === "compliance";
    return [
      item.type,
      new Date(item.timestamp).toISOString(),
      isCompliance ? "" : fromBaseUnits(item.amount, decimalsFor?.(item.asset)),
      isCompliance ? "" : item.amount,
      isCompliance ? "" : item.asset,
      item.commitment,
      item.poolId ?? "",
    ]
      .map(csvEscape)
      .join(",");
  });
  return [ACTIVITY_CSV_COLUMNS.join(","), ...rows].join("\n");
}

/** Render activity rows as JSON. Same fields as {@link formatActivityCsv}, one object per row. */
export function formatActivityJson(
  items: ActivityItem[],
  decimalsFor?: DecimalsLookup,
): string {
  const data = items.map((item) => {
    const isCompliance = item.type === "compliance";
    return {
      type: item.type,
      date: new Date(item.timestamp).toISOString(),
      amount: isCompliance
        ? null
        : fromBaseUnits(item.amount, decimalsFor?.(item.asset)),
      amountBaseUnits: isCompliance ? null : item.amount,
      asset: isCompliance ? null : item.asset,
      commitment: item.commitment,
      poolId: item.poolId ?? null,
    };
  });
  return JSON.stringify(data, null, 2);
}
