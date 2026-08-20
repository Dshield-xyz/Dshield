import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const DEV_SECRET_KEY_CONFIGURED =
  process.env.NEXT_PUBLIC_DEV_SECRET_KEY_CONFIGURED === "true" ||
  Boolean(process.env.NEXT_PUBLIC_DEV_SECRET_KEY);
const DEV_SECRET_KEY_WARNING =
  "NEXT_PUBLIC_DEV_SECRET_KEY is configured but ignored because it is only allowed on localhost during non-production builds.";

export const POOL_CONTRACT_ID = process.env.NEXT_PUBLIC_POOL_CONTRACT_ID || "";
export const COMPLIANCE_CONTRACT_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID || "";

// Test USDC asset wrapped as a Stellar Asset Contract. Classic assets require
// a trustline before an account can hold them; these let the app establish the
// trustline and faucet test USDC so any wallet can use the demo.
export const USDC_CODE = process.env.NEXT_PUBLIC_USDC_CODE || "USDC";
export const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER || "";

export function getUsdcAsset(): StellarSdk.Asset | null {
  if (!USDC_ISSUER) return null;
  return new StellarSdk.Asset(USDC_CODE, USDC_ISSUER);
}

/**
 * Returns true if the account already trusts (can hold) the test USDC asset.
 * On RPC-only localnets we can't read classic trustlines directly, so we probe
 * the SAC `balance` view: it simulates fine for a trusting account (even with a
 * 0 balance) and fails when the trustline is missing.
 */
export async function hasUsdcTrustline(address: string): Promise<boolean> {
  const sac = getUsdcSacId();
  if (!sac) return true; // no asset configured -> nothing to enforce
  const result = await queryContract(sac, "balance", [
    StellarSdk.nativeToScVal(address, { type: "address" }),
  ]);
  return result !== null;
}

export function getUsdcSacId(): string | null {
  const asset = getUsdcAsset();
  if (!asset) return null;
  return asset.contractId(getNetworkPassphrase());
}

/**
 * Ensure `address` has a USDC trustline, establishing one (signed by the
 * connected wallet) if missing. No-op when already trusted or no asset set.
 */
export async function ensureUsdcTrustline(
  address: string,
  signTransaction: (xdr: string) => Promise<string>,
): Promise<void> {
  const asset = getUsdcAsset();
  if (!asset) return;
  if (await hasUsdcTrustline(address)) return;

  const server = getRpcServer();
  const account = await server.getAccount(address);
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(StellarSdk.Operation.changeTrust({ asset }))
    .setTimeout(60)
    .build();

  const signedXdr = await signTransaction(tx.toXDR());
  await submitTransaction(signedXdr);
}

/**
 * Mint test USDC to `address` via the server-side faucet route. The issuer
 * secret lives only on the server (see /api/faucet), so it is never exposed to
 * the browser. Requires the recipient to already have a USDC trustline.
 */
export async function faucetUsdc(
  address: string,
  amount: bigint | number,
): Promise<void> {
  if (!getUsdcSacId()) return;
  const res = await fetch("/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, amount: BigInt(amount).toString() }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Faucet request failed (${res.status})`);
  }
}

export interface PoolTier {
  id: string;
  label: string;
  amount: number;
}

export function getPoolTiers(): PoolTier[] {
  const tiers: PoolTier[] = [];
  const raw = process.env.NEXT_PUBLIC_POOL_TIERS || "";
  if (raw) {
    for (const entry of raw.split(",")) {
      const [label, id, amt] = entry.split(":");
      if (label && id && amt) {
        tiers.push({ id, label, amount: Number(amt) });
      }
    }
  }
  if (tiers.length === 0 && POOL_CONTRACT_ID) {
    tiers.push({ id: POOL_CONTRACT_ID, label: "10 USDC", amount: 100000000 });
  }
  return tiers;
}

export function getRpcServer() {
  return new StellarSdk.rpc.Server(RPC_URL, { allowHttp: true });
}

export function getNetworkPassphrase() {
  return NETWORK_PASSPHRASE;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function getBrowserHostname(): string | null {
  if (typeof window === "undefined") return null;
  return window.location?.hostname || null;
}

function getConfiguredDevSecretKey(): string {
  // Keep production builds from reading this NEXT_PUBLIC_ value at all. That
  // lets the bundler remove the dev-secret path instead of inlining a
  // accidentally configured secret into shipped client JavaScript.
  if (process.env.NODE_ENV === "production") return "";
  return process.env.NEXT_PUBLIC_DEV_SECRET_KEY || "";
}

export function isDevSecretKeyAllowedForEnvironment({
  devSecretKey,
  nodeEnv,
  hostname,
}: {
  devSecretKey: string;
  nodeEnv: string | undefined;
  hostname: string | null;
}): boolean {
  if (!devSecretKey) return false;
  if (nodeEnv === "production") return false;
  if (hostname === null) return true;
  return isLocalHostname(hostname);
}

export function isDevSecretKeyAllowed(): boolean {
  return isDevSecretKeyAllowedForEnvironment({
    devSecretKey: getConfiguredDevSecretKey(),
    nodeEnv: process.env.NODE_ENV,
    hostname: getBrowserHostname(),
  });
}

export function getDevSecretKeyWarning(): string | null {
  if (!DEV_SECRET_KEY_CONFIGURED || isDevSecretKeyAllowed()) return null;
  return DEV_SECRET_KEY_WARNING;
}

export function getDevKeypair(): StellarSdk.Keypair | null {
  const devSecretKey = getConfiguredDevSecretKey();
  if (!devSecretKey || !isDevSecretKeyAllowed()) return null;
  return StellarSdk.Keypair.fromSecret(devSecretKey);
}

export function devSignTransaction(xdr: string): string {
  const keypair = getDevKeypair();
  if (!keypair) throw new Error(getDevSecretKeyWarning() || "No dev secret key configured");
  const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
  tx.sign(keypair);
  return tx.toXDR();
}

export async function buildContractCall(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  publicKey: string,
): Promise<StellarSdk.Transaction> {
  const server = getRpcServer();
  const account = await server.getAccount(publicKey);
  const contract = new StellarSdk.Contract(contractId);

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    throw new Error(`Simulation failed: ${simulated.error}`);
  }
  return StellarSdk.rpc.assembleTransaction(tx, simulated).build();
}

export interface RelayResult {
  hash: string;
  relayer: string;
}

/**
 * Submit a withdrawal through the server-side relayer so the user's account
 * never appears on-chain (unlinkable withdrawal). Returns the relay result, or
 * `null` if no relayer is configured (HTTP 503) so the caller can fall back to
 * a wallet-signed submission.
 */
export async function relayWithdrawal(params: {
  poolId: string;
  recipient: string;
  publicInputs: string;
  proof: string;
}): Promise<RelayResult | null> {
  const res = await fetch("/api/relay-withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (res.status === 503) return null; // relayer not configured
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    hash?: string;
    relayer?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `Relayed withdrawal failed (${res.status})`);
  }
  return { hash: body.hash!, relayer: body.relayer! };
}

export async function submitTransaction(signedXdr: string): Promise<string> {
  const server = getRpcServer();
  const tx = StellarSdk.TransactionBuilder.fromXDR(signedXdr, getNetworkPassphrase());
  const response = await server.sendTransaction(tx);

  if (response.status === "ERROR") {
    throw new Error(`Transaction failed: ${response.status}`);
  }

  let result = await server.getTransaction(response.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 1000));
    result = await server.getTransaction(response.hash);
  }

  if (result.status === "FAILED") {
    throw new Error("Transaction failed on-chain");
  }

  return response.hash;
}

export function bytesToScVal(hex: string): StellarSdk.xdr.ScVal {
  const bytes = Buffer.from(hex, "hex");
  return StellarSdk.xdr.ScVal.scvBytes(bytes);
}

export async function queryContract(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = [],
): Promise<StellarSdk.xdr.ScVal | null> {
  const server = getRpcServer();
  const contract = new StellarSdk.Contract(contractId);

  const account = new StellarSdk.Account(
    "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH",
    "0",
  );

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build();

  const simulated = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulated)) {
    return null;
  }
  if (!StellarSdk.rpc.Api.isSimulationSuccess(simulated)) {
    return null;
  }
  return simulated.result?.retval ?? null;
}
