import * as StellarSdk from "@stellar/stellar-sdk";
import { getRpcServer, POOL_CONTRACT_ID, queryContract } from "./stellar";
import { saveDeposit, getDeposits } from "./deposits";

// Must not exceed the contract's own MAX_PAGE_SIZE (contracts/pool/src/lib.rs)
// — a larger request is silently clamped there, which would just mean more
// round trips than necessary, not a correctness issue.
const COMMITMENTS_PAGE_SIZE = 100;

/**
 * Fetch the complete, ordered list of commitments directly from the pool
 * contract's storage, paging through `get_commitments_page` until a short
 * page signals the end. This is the authoritative source for rebuilding the
 * Merkle tree — unlike scanning deposit events, it does not depend on RPC
 * event retention, so it always returns every leaf the contract has
 * inserted. Paging (rather than the old unbounded `get_commitments`) keeps
 * each call within Soroban's per-transaction CPU/footprint limits regardless
 * of pool size.
 *
 * Returns commitments as 0x-prefixed 32-byte hex strings in leaf-index order,
 * or null if any page call fails (e.g. an older pool deployment without the
 * view) — never a partial list, since a truncated commitment set would
 * silently reconstruct the wrong Merkle root.
 */
export async function fetchCommitmentsFromChain(
  poolId?: string,
): Promise<string[] | null> {
  const targetPool = poolId || POOL_CONTRACT_ID;
  if (!targetPool) return null;

  const commitments: string[] = [];
  let start = 0;

  for (;;) {
    const result = await queryContract(targetPool, "get_commitments_page", [
      StellarSdk.nativeToScVal(start, { type: "u32" }),
      StellarSdk.nativeToScVal(COMMITMENTS_PAGE_SIZE, { type: "u32" }),
    ]);
    if (!result) return null;

    const native = StellarSdk.scValToNative(result) as unknown;
    if (!Array.isArray(native)) return null;

    for (const buf of native) {
      const bytes = Buffer.from(buf as Uint8Array);
      commitments.push("0x" + bytes.toString("hex").padStart(64, "0"));
    }

    if (native.length < COMMITMENTS_PAGE_SIZE) break;
    start += native.length;
  }

  return commitments;
}

export interface NoteTxRefs {
  depositTx: { hash: string; at: string } | null;
  withdrawTx: { hash: string; at: string } | null;
}

/**
 * Best-effort lookup of the on-chain transactions that touched a note, for the
 * compliance report: the deposit tx that inserted `commitmentHex`, and the
 * withdraw tx that spent `nullifierHashHex` (if any). Both are derived purely
 * from public events — anyone holding the note can reproduce them. Returns
 * nulls for whatever the RPC's event retention can't reach; the report falls
 * back to the authoritative contract views (get_commitments_page / is_nullifier_used)
 * for the confirmed/withdrawn facts, so missing tx links never block a report.
 */
export async function lookupNoteTxs(
  poolId: string,
  commitmentHex: string,
  nullifierHashHex: string,
): Promise<NoteTxRefs> {
  const server = getRpcServer();
  const wantCommitment = commitmentHex.replace(/^0x/, "").toLowerCase();
  const wantNullifier = nullifierHashHex.replace(/^0x/, "").toLowerCase();

  const refs: NoteTxRefs = { depositTx: null, withdrawTx: null };

  let startLedger = 1;
  let cursor: string | undefined;
  let triedRetentionFallback = false;
  let hasMore = true;

  while (hasMore && (!refs.depositTx || !refs.withdrawTx)) {
    let response: StellarSdk.rpc.Api.GetEventsResponse;
    try {
      const filters = [{ type: "contract" as const, contractIds: [poolId] }];
      const opts = cursor
        ? { filters, cursor, limit: 100 }
        : { filters, startLedger, limit: 100 };
      response = await server.getEvents(opts);
    } catch {
      if (!cursor && !triedRetentionFallback) {
        triedRetentionFallback = true;
        try {
          const latest = await server.getLatestLedger();
          startLedger = Math.max(1, latest.sequence - 17280);
          continue;
        } catch {
          break;
        }
      }
      break;
    }

    const events = response.events || [];
    for (const event of events) {
      try {
        if (!event.topic || event.topic.length < 1) continue;
        const kind = StellarSdk.scValToNative(event.topic[0]) as string;

        if (kind === "deposit" && !refs.depositTx) {
          const dataMap = StellarSdk.scValToNative(event.value) as Record<
            string,
            unknown
          >;
          if (dataMap && typeof dataMap === "object" && "commitment" in dataMap) {
            const hex = Buffer.from(dataMap.commitment as Uint8Array)
              .toString("hex")
              .toLowerCase();
            if (hex === wantCommitment) {
              refs.depositTx = {
                hash: event.txHash,
                at: event.ledgerClosedAt,
              };
            }
          }
        } else if (kind === "withdraw" && !refs.withdrawTx) {
          const val = StellarSdk.scValToNative(event.value);
          const hex = Buffer.from(val as Uint8Array)
            .toString("hex")
            .toLowerCase();
          if (hex === wantNullifier) {
            refs.withdrawTx = { hash: event.txHash, at: event.ledgerClosedAt };
          }
        }
      } catch {
        continue;
      }
    }

    if (events.length < 100) {
      hasMore = false;
    } else {
      cursor = events[events.length - 1].id;
    }
  }

  return refs;
}

export async function syncDepositsFromChain(
  poolId?: string,
): Promise<number> {
  const targetPool = poolId || POOL_CONTRACT_ID;
  if (!targetPool) return 0;

  const server = getRpcServer();
  const existingDeposits = getDeposits().filter(
    (d) => !d.poolId || d.poolId === targetPool,
  );
  const knownIndices = new Set(existingDeposits.map((d) => d.leafIndex));

  let synced = 0;
  let cursor: string | undefined;
  // Reconstructing the Merkle tree requires EVERY deposit, so scan from the
  // start of the chain rather than a recent window. On a network whose event
  // retention does not reach ledger 1, the getEvents call below will throw and
  // we fall back to the largest window the RPC allows.
  let startLedger = 1;
  try {
    const latest = await server.getLatestLedger();
    if (latest.sequence > 0 && startLedger > latest.sequence) {
      startLedger = latest.sequence;
    }
  } catch {
    startLedger = 1;
  }

  let hasMore = true;
  let triedRetentionFallback = false;

  while (hasMore) {
    let response: StellarSdk.rpc.Api.GetEventsResponse;
    try {
      const filters = [
        {
          type: "contract" as const,
          contractIds: [targetPool],
          topics: [["AAAADwAAAAdkZXBvc2l0AA==", "*"]],
        },
      ];
      const opts = cursor
        ? { filters, cursor, limit: 100 }
        : { filters, startLedger, limit: 100 };
      response = await server.getEvents(opts);
    } catch {
      // A start ledger older than the RPC's event retention window throws.
      // Retry once from the most recent window the RPC is likely to keep.
      if (!cursor && !triedRetentionFallback) {
        triedRetentionFallback = true;
        try {
          const latest = await server.getLatestLedger();
          startLedger = Math.max(1, latest.sequence - 17280);
          continue;
        } catch {
          break;
        }
      }
      break;
    }

    const events = response.events || [];

    for (const event of events) {
      try {
        if (!event.topic || event.topic.length < 2) continue;

        const idxScVal = event.topic[1];
        const leafIndex = StellarSdk.scValToNative(idxScVal) as number;

        if (knownIndices.has(leafIndex)) continue;

        const dataMap = StellarSdk.scValToNative(event.value) as Record<
          string,
          unknown
        >;
        let commitment: string;

        if (dataMap && typeof dataMap === "object" && "commitment" in dataMap) {
          const buf = dataMap.commitment as Buffer;
          commitment = Buffer.from(buf).toString("hex");
        } else {
          continue;
        }

        saveDeposit({
          commitment,
          leafIndex,
          timestamp: Date.now(),
          poolId: targetPool,
        });
        knownIndices.add(leafIndex);
        synced++;
      } catch {
        continue;
      }
    }

    if (events.length < 100) {
      hasMore = false;
    } else {
      cursor = events[events.length - 1].id;
    }
  }

  return synced;
}
