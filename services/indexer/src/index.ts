import { loadConfig } from "./config.js";
import { CommitmentStore } from "./store.js";
import { startSyncLoop } from "./sync.js";
import { createIndexerServer } from "./server.js";
import { poseidon2Hash } from "./poseidon.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new CommitmentStore(config.dataFile, config.poolId);

  const chainConfig = {
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  };

  const stopSync = startSyncLoop(
    chainConfig,
    config.poolId,
    store,
    config.pollIntervalMs,
    ({ newDeposits, newWithdrawals }) => {
      if (newDeposits || newWithdrawals) {
        console.log(
          `[sync] +${newDeposits} deposits, +${newWithdrawals} withdrawals — tree now has ${store.leafCount} leaves`,
        );
      }
    },
    (err) => {
      console.error("[sync] error:", err instanceof Error ? err.message : err);
    },
  );

  const server = createIndexerServer(store, poseidon2Hash);
  server.listen(config.port, () => {
    console.log(
      `[indexer] listening on :${config.port} for pool ${config.poolId} (RPC: ${config.rpcUrl})`,
    );
  });

  const shutdown = () => {
    console.log("[indexer] shutting down");
    stopSync();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[indexer] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
