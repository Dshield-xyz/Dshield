import {
  getRpcServer,
  scanDepositEventsPage,
  scanWithdrawEventsPage,
  type ChainConfig,
  type EventScanCursor,
  type ScanResult,
} from "@dshield/core";
import type { CommitmentStore } from "./store.js";

// Same fallback window the frontend's in-browser sync uses when a start
// ledger is older than the RPC's event retention: the largest recent window
// most RPC providers are likely to keep (~24h at Stellar's ~5s ledger close
// time).
const RETENTION_FALLBACK_LEDGERS = 17280;

async function scanWithRetentionFallback<T>(
  cfg: ChainConfig,
  cursor: EventScanCursor,
  scanPage: (cfg: ChainConfig, cursor: EventScanCursor) => Promise<ScanResult<T>>,
): Promise<ScanResult<T>> {
  try {
    return await scanPage(cfg, cursor);
  } catch (err) {
    // A start ledger older than the RPC's retention window throws. Retry
    // once from the most recent window the RPC is likely to keep — but only
    // when resuming from a raw ledger number; a stale cursor throwing is a
    // different, non-recoverable failure and should propagate.
    if (cursor.cursor) throw err;
    const server = getRpcServer(cfg);
    const latest = await server.getLatestLedger();
    const fallbackCursor: EventScanCursor = {
      startLedger: Math.max(1, latest.sequence - RETENTION_FALLBACK_LEDGERS),
    };
    return scanPage(cfg, fallbackCursor);
  }
}

export interface SyncStats {
  newDeposits: number;
  newWithdrawals: number;
}

/**
 * Pulls every new deposit/withdraw event since the store's last saved
 * cursor, applies them, and persists the result. Safe to call repeatedly —
 * on a poll loop or once from a CLI — since progress is checkpointed in the
 * store after each page.
 */
export async function syncOnce(
  cfg: ChainConfig,
  poolId: string,
  store: CommitmentStore,
): Promise<SyncStats> {
  let newDeposits = 0;
  let depositCursor = store.depositCursor;
  for (;;) {
    const page = await scanWithRetentionFallback(
      cfg,
      depositCursor,
      (c, cur) => scanDepositEventsPage(c, poolId, cur),
    );
    for (const event of page.events) {
      store.setCommitment(event.leafIndex, event.commitment);
      newDeposits++;
    }
    depositCursor = {
      cursor: page.cursor ?? depositCursor.cursor,
      startLedger: depositCursor.startLedger,
    };
    store.setDepositCursor(depositCursor);
    store.save();
    if (page.caughtUp) break;
  }

  let newWithdrawals = 0;
  let withdrawCursor = store.withdrawCursor;
  for (;;) {
    const page = await scanWithRetentionFallback(
      cfg,
      withdrawCursor,
      (c, cur) => scanWithdrawEventsPage(c, poolId, cur),
    );
    for (const event of page.events) {
      store.addSpentNullifier(event.nullifierHash);
      newWithdrawals++;
    }
    withdrawCursor = {
      cursor: page.cursor ?? withdrawCursor.cursor,
      startLedger: withdrawCursor.startLedger,
    };
    store.setWithdrawCursor(withdrawCursor);
    store.save();
    if (page.caughtUp) break;
  }

  return { newDeposits, newWithdrawals };
}

/**
 * Runs {@link syncOnce} on a fixed interval until stopped. Errors are handed
 * to `onError` (rather than thrown) so a transient RPC hiccup doesn't kill
 * the whole process — the next tick just tries again.
 */
export function startSyncLoop(
  cfg: ChainConfig,
  poolId: string,
  store: CommitmentStore,
  intervalMs: number,
  onTick: (stats: SyncStats) => void,
  onError: (err: unknown) => void,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const stats = await syncOnce(cfg, poolId, store);
      onTick(stats);
    } catch (err) {
      onError(err);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
