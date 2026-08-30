export interface Config {
  rpcUrl: string;
  networkPassphrase: string;
  poolId: string;
  port: number;
  /** Where to persist the commitment store (a JSON file) between restarts. */
  dataFile: string;
  /** How often to poll the RPC for new deposit/withdraw events. */
  pollIntervalMs: number;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    rpcUrl: process.env.RPC_URL || "http://localhost:8000/soroban/rpc",
    networkPassphrase:
      process.env.NETWORK_PASSPHRASE || "Standalone Network ; February 2017",
    poolId: required("POOL_CONTRACT_ID"),
    port: Number(process.env.PORT || 8091),
    dataFile: process.env.DATA_FILE || "./data/indexer-store.json",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 5000),
  };
}
