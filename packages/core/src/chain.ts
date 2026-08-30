/**
 * Stellar RPC helpers for reading pool state, shared by every off-chain
 * client that needs to reconstruct the commitment set: the frontend, the
 * standalone indexer service, and any future CLI.
 *
 * These are deliberately self-contained (they take a `ChainConfig` rather
 * than reading `process.env` or importing frontend-specific wiring) so they
 * work the same way in a browser bundle and in a plain Node process.
 */
import * as StellarSdk from "@stellar/stellar-sdk";

export interface ChainConfig {
  rpcUrl: string;
  networkPassphrase: string;
}

export function getRpcServer(cfg: ChainConfig): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(cfg.rpcUrl, { allowHttp: true });
}

// A throwaway source account with sequence 0, used only to simulate a
// read-only contract call. Its balance/existence on-chain doesn't matter —
// simulateTransaction never actually submits anything.
const SIMULATION_SOURCE =
  "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";

/**
 * Simulates a read-only contract call and returns its return value, or
 * `null` if simulation failed (e.g. the method doesn't exist on this
 * contract, or the RPC endpoint is unreachable).
 */
export async function queryContractView(
  cfg: ChainConfig,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = [],
): Promise<StellarSdk.xdr.ScVal | null> {
  const server = getRpcServer(cfg);
  const contract = new StellarSdk.Contract(contractId);
  const account = new StellarSdk.Account(SIMULATION_SOURCE, "0");

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) return null;
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simulated)) return null;
  return simulated.result?.retval ?? null;
}

// Must not exceed the contract's own MAX_PAGE_SIZE (contracts/pool/src/lib.rs)
// — a larger request is silently clamped there, which would just mean more
// round trips than necessary, not a correctness issue.
const COMMITMENTS_PAGE_SIZE = 100;

/**
 * Fetches the complete, ordered list of commitments directly from the pool
 * contract's storage via `get_commitments_page`, paging until a short page
 * signals the end. This is the authoritative source for rebuilding the
 * Merkle tree — unlike scanning deposit events, it does not depend on RPC
 * event retention, so it always returns every leaf the contract has
 * inserted. Returns 0x-prefixed 32-byte hex strings in leaf-index order, or
 * `null` if any page call fails — never a partial list, since a truncated
 * commitment set would silently reconstruct the wrong root.
 */
export async function fetchCommitmentsFromChain(
  cfg: ChainConfig,
  poolId: string,
): Promise<string[] | null> {
  const commitments: string[] = [];
  let start = 0;

  for (;;) {
    const result = await queryContractView(cfg, poolId, "get_commitments_page", [
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

export interface DepositEvent {
  leafIndex: number;
  /** 0x-prefixed 32-byte hex commitment. */
  commitment: string;
  txHash: string;
  ledgerClosedAt: string;
}

export interface WithdrawEvent {
  /** 0x-prefixed 32-byte hex nullifier hash. */
  nullifierHash: string;
  txHash: string;
  ledgerClosedAt: string;
}

export interface EventScanCursor {
  /** RPC event pagination cursor to resume from; unset for a fresh scan. */
  cursor?: string;
  /** Ledger to start from when `cursor` is unset. */
  startLedger: number;
}

export interface ScanResult<T> {
  events: T[];
  /** Cursor to pass as `cursor` on the next call to resume where this left off. */
  cursor?: string;
  /** True once a short page confirmed there is nothing more to fetch right now. */
  caughtUp: boolean;
}

const EVENTS_PAGE_LIMIT = 100;
// Deposit event topic0 ("deposit") base64-encoded as an ScSymbol — matches
// the filter the frontend indexer already relies on.
const DEPOSIT_TOPIC0 = "AAAADwAAAAdkZXBvc2l0AA==";

/**
 * Scans one page of `deposit` events starting from `cursor.cursor` (if set)
 * or `cursor.startLedger`, and returns the new events plus a cursor to
 * resume from. Does not loop to the chain tip itself — callers (a polling
 * loop, or a test driving a fixture) decide how many pages to pull.
 *
 * Throws if `cursor.startLedger` is older than the RPC's event retention
 * window; callers should catch this and retry from `getLatestLedger() -
 * <retention>`, same fallback the frontend's sync already performs.
 */
export async function scanDepositEventsPage(
  cfg: ChainConfig,
  poolId: string,
  cursor: EventScanCursor,
): Promise<ScanResult<DepositEvent>> {
  const server = getRpcServer(cfg);
  const filters = [
    {
      type: "contract" as const,
      contractIds: [poolId],
      topics: [[DEPOSIT_TOPIC0, "*"]],
    },
  ];
  const opts = cursor.cursor
    ? { filters, cursor: cursor.cursor, limit: EVENTS_PAGE_LIMIT }
    : { filters, startLedger: cursor.startLedger, limit: EVENTS_PAGE_LIMIT };

  const response = await server.getEvents(opts);
  const rawEvents = response.events || [];
  const events: DepositEvent[] = [];

  for (const event of rawEvents) {
    try {
      if (!event.topic || event.topic.length < 2) continue;
      const leafIndex = StellarSdk.scValToNative(event.topic[1]) as number;
      const dataMap = StellarSdk.scValToNative(event.value) as Record<
        string,
        unknown
      >;
      if (!dataMap || typeof dataMap !== "object" || !("commitment" in dataMap)) {
        continue;
      }
      const commitment =
        "0x" + Buffer.from(dataMap.commitment as Uint8Array).toString("hex");
      events.push({
        leafIndex,
        commitment,
        txHash: event.txHash,
        ledgerClosedAt: event.ledgerClosedAt,
      });
    } catch {
      continue;
    }
  }

  const caughtUp = rawEvents.length < EVENTS_PAGE_LIMIT;
  const nextCursor = caughtUp
    ? cursor.cursor
    : rawEvents[rawEvents.length - 1]!.id;

  return { events, cursor: nextCursor, caughtUp };
}

/**
 * Same as {@link scanDepositEventsPage} but for `withdraw` events. Filters by
 * contract only (not by topic — `withdraw`'s single-value data format makes a
 * topic-based ScSymbol filter easy to get subtly wrong) and checks each
 * event's decoded topic in code instead, same as the frontend's
 * `lookupNoteTxs`.
 */
export async function scanWithdrawEventsPage(
  cfg: ChainConfig,
  poolId: string,
  cursor: EventScanCursor,
): Promise<ScanResult<WithdrawEvent>> {
  const server = getRpcServer(cfg);
  const filters = [{ type: "contract" as const, contractIds: [poolId] }];
  const opts = cursor.cursor
    ? { filters, cursor: cursor.cursor, limit: EVENTS_PAGE_LIMIT }
    : { filters, startLedger: cursor.startLedger, limit: EVENTS_PAGE_LIMIT };

  const response = await server.getEvents(opts);
  const rawEvents = response.events || [];
  const events: WithdrawEvent[] = [];

  for (const event of rawEvents) {
    try {
      if (!event.topic || event.topic.length < 1) continue;
      const kind = StellarSdk.scValToNative(event.topic[0]) as string;
      if (kind !== "withdraw") continue;
      const nullifierHash =
        "0x" +
        Buffer.from(
          StellarSdk.scValToNative(event.value) as Uint8Array,
        ).toString("hex");
      events.push({
        nullifierHash,
        txHash: event.txHash,
        ledgerClosedAt: event.ledgerClosedAt,
      });
    } catch {
      continue;
    }
  }

  const caughtUp = rawEvents.length < EVENTS_PAGE_LIMIT;
  const nextCursor = caughtUp
    ? cursor.cursor
    : rawEvents[rawEvents.length - 1]!.id;

  return { events, cursor: nextCursor, caughtUp };
}
