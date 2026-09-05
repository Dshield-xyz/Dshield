import * as StellarSdk from "@stellar/stellar-sdk";
import { isNativeAsset, type ChainConfig } from "@dshield/core";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const DEV_SECRET_KEY = process.env.NEXT_PUBLIC_DEV_SECRET_KEY || "";

export const POOL_CONTRACT_ID = process.env.NEXT_PUBLIC_POOL_CONTRACT_ID || "";
export const COMPLIANCE_CONTRACT_ID = process.env.NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID || "";
export const GOVERNANCE_CONTRACT_ID = process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID || "";

// Base URL of a self-hosted standalone indexer (see services/indexer/), used
// as an optional faster source for Merkle paths instead of scanning RPC
// events or paging get_commitments_page in-browser. Unset by default: the
// app works fully without one, falling back to direct RPC scanning. See
// fetchMerkleProofFromService in ./indexer for the trust model.
export const INDEXER_SERVICE_URL = process.env.NEXT_PUBLIC_INDEXER_SERVICE_URL || "";

// Classic Stellar assets this deployment knows how to wrap as Stellar Asset
// Contracts, as "CODE:ISSUER" pairs. The pool's allow-list (read on-chain) is
// the authority on what can be shielded; this only supplies the extra fact a
// contract address cannot express — which classic asset a SAC wraps — so the
// app can establish the trustline an account needs before it can hold it.
//
// A SAC's contract id is a hash of the asset, so it cannot be reversed. An
// asset that is allow-listed but missing here is still perfectly shieldable;
// the app just can't open a trustline on the user's behalf, and says so.
const CLASSIC_ASSETS = process.env.NEXT_PUBLIC_CLASSIC_ASSETS || "";

// The demo's test USDC, kept as its own setting for backwards compatibility
// with existing .env.local files written by earlier deploys.
export const USDC_CODE = process.env.NEXT_PUBLIC_USDC_CODE || "USDC";
export const USDC_ISSUER = process.env.NEXT_PUBLIC_USDC_ISSUER || "";

/** Every classic asset configured for this deployment, deduplicated by SAC id. */
export function getClassicAssets(): StellarSdk.Asset[] {
  const assets: StellarSdk.Asset[] = [];
  const seen = new Set<string>();

  const add = (code: string, issuer: string) => {
    if (!code || !issuer) return;
    const key = `${code}:${issuer}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      assets.push(new StellarSdk.Asset(code, issuer));
    } catch {
      // A malformed entry in config must not take down every other asset.
    }
  };

  if (USDC_ISSUER) add(USDC_CODE, USDC_ISSUER);
  for (const entry of CLASSIC_ASSETS.split(",")) {
    const [code, issuer] = entry.trim().split(":");
    if (code && issuer) add(code, issuer);
  }
  return assets;
}

/**
 * The classic asset a SAC contract address wraps, or `null` if this deployment
 * doesn't know of one — either a pure Soroban token (no trustline concept) or a
 * classic asset nobody configured.
 */
export function classicAssetForContract(
  contractId: string,
): StellarSdk.Asset | null {
  const passphrase = getNetworkPassphrase();
  for (const asset of getClassicAssets()) {
    try {
      if (asset.contractId(passphrase) === contractId) return asset;
    } catch {
      // Ignore an asset whose contract id can't be derived on this network.
    }
  }
  return null;
}

/**
 * True if `address` can already hold `contractId`.
 *
 * Native XLM needs no trustline, so it is always holdable. For everything else
 * we probe the token's `balance` view rather than reading classic trustlines
 * directly, which an RPC-only localnet can't do: the simulation succeeds for a
 * trusting account (even at a 0 balance) and fails when the trustline is
 * missing.
 */
export async function hasTrustline(
  contractId: string,
  address: string,
): Promise<boolean> {
  if (!contractId) return true;
  if (isNativeAsset(contractId, getNetworkPassphrase())) return true;
  const result = await queryContract(contractId, "balance", [
    StellarSdk.nativeToScVal(address, { type: "address" }),
  ]);
  return result !== null;
}

/**
 * Ensure `address` can hold `contractId`, establishing a trustline (signed by
 * the connected wallet) if one is missing and this deployment knows which
 * classic asset the contract wraps.
 *
 * Throws rather than silently continuing when a trustline is needed but can't
 * be opened — a withdrawal into an account that can't hold the asset fails
 * on-chain, and failing here says why.
 */
export async function ensureTrustline(
  contractId: string,
  address: string,
  signTransaction: (xdr: string) => Promise<string>,
): Promise<void> {
  if (await hasTrustline(contractId, address)) return;

  const asset = classicAssetForContract(contractId);
  if (!asset) {
    throw new Error(
      `${address.slice(0, 4)}…${address.slice(-4)} cannot hold this asset yet, ` +
        "and it isn't a classic asset this app can add a trustline for. Add the " +
        "trustline from your wallet and try again.",
    );
  }

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
 * Mint test funds to `address` via the server-side faucet route. The issuer
 * secret lives only on the server (see /api/faucet), so it is never exposed to
 * the browser, and the route refuses to run on a production network.
 *
 * Returns `false` when no faucet is available for this asset (a mainnet
 * deployment, or any asset whose issuer key the server doesn't hold), so the
 * caller can tell the user to fund the wallet themselves instead of failing.
 */
export async function faucetAsset(
  contractId: string,
  address: string,
  amount: bigint | number,
): Promise<boolean> {
  const res = await fetch("/api/faucet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address,
      asset: contractId,
      amount: BigInt(amount).toString(),
    }),
  });
  if (res.status === 503 || res.status === 403) return false; // no faucet here
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Faucet request failed (${res.status})`);
  }
  return true;
}

/** Balance of `contractId` held by `address`, in the asset's base units. */
export async function assetBalance(
  contractId: string,
  address: string,
): Promise<bigint> {
  const val = await queryContract(contractId, "balance", [
    StellarSdk.nativeToScVal(address, { type: "address" }),
  ]);
  if (!val) return BigInt(0);
  try {
    return BigInt(StellarSdk.scValToNative(val) as string | number);
  } catch {
    return BigInt(0);
  }
}

/**
 * The shielded pool. There is exactly one: notes carry their own value, so a
 * single pool serves every amount. Splitting deposits across fixed-denomination
 * tiers would only fragment the anonymity set — every user is better hidden in
 * one crowd than in three.
 */
export function getPoolId(): string {
  return POOL_CONTRACT_ID;
}

export function getRpcServer() {
  return new StellarSdk.rpc.Server(RPC_URL, { allowHttp: true });
}

export function getNetworkPassphrase() {
  return NETWORK_PASSPHRASE;
}

/**
 * This deployment's network, in the shape the shared @dshield/core helpers
 * take. They deliberately accept a config rather than reading `process.env`, so
 * the same code runs in the browser bundle, the CLI and the indexer.
 */
export function getChainConfig(): ChainConfig {
  return { rpcUrl: RPC_URL, networkPassphrase: NETWORK_PASSPHRASE };
}

/**
 * True when this build points at Stellar mainnet. Gates the conveniences that
 * only make sense against play money — the faucet, the dev signing key — so
 * they can't be reached with real funds at stake.
 */
export function isMainnet(): boolean {
  return NETWORK_PASSPHRASE === StellarSdk.Networks.PUBLIC;
}

/**
 * The demo signing key, when one is configured.
 *
 * Ignored outright on mainnet: `NEXT_PUBLIC_DEV_SECRET_KEY` is inlined into the
 * client bundle by Next, so honouring it against real funds would publish a
 * spending key to everyone who loads the page. A build that still sets it is a
 * misconfiguration, and refusing here means the app falls back to a real
 * wallet rather than quietly signing with a public secret.
 */
export function getDevKeypair(): StellarSdk.Keypair | null {
  if (!DEV_SECRET_KEY) return null;
  if (isMainnet()) return null;
  return StellarSdk.Keypair.fromSecret(DEV_SECRET_KEY);
}

export function devSignTransaction(xdr: string): string {
  const keypair = getDevKeypair();
  if (!keypair) throw new Error("No dev secret key configured");
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
  /** Relayer fee actually carved out of the payout, in the withdrawn asset. */
  feeAmount?: string;
}

// The XLM SAC and Soroswap-compatible router the pool contract swaps a
// carved-out relayer fee through (see contracts/pool/src/lib.rs
// swap_fee_for_asset). Both are admin-configured on the pool via
// set_dex_router; the frontend needs its own copies to source a quote before
// the user signs, so the "effective fee" shown matches what the contract will
// actually charge.
export const XLM_SAC_ID = process.env.NEXT_PUBLIC_XLM_SAC_ID || "";
export const DEX_ROUTER_ID = process.env.NEXT_PUBLIC_DEX_ROUTER_ID || "";

// Basis points on top of the router's quoted output that the relayer accepts
// as slippage before the on-chain swap reverts. Matches the leeway a relayer
// (frontend/src/app/api/relay-withdraw/route.ts) is expected to allow between
// quoting a fee and the withdrawal actually landing on-chain.
const FEE_SLIPPAGE_BPS = 100; // 1%

export interface FeeQuote {
  /** Amount of the withdrawn asset the relayer fee will carve out. */
  feeAmount: string;
  /** Expected XLM the swap will yield for `feeAmount`, before slippage. */
  expectedXlmOut: string;
  /** Slippage floor to pass as `fee_min_out` to `withdraw`. */
  minXlmOut: string;
}

/**
 * Quotes what `feeAmount` of the withdrawn asset is currently worth in XLM,
 * via the same DEX router the pool contract swaps through. Returns `null`
 * when no router/fee-asset is configured, so callers can fall back to "no fee
 * abstraction available" rather than showing a broken quote.
 *
 * This is a read-only simulation (get_amounts_out), not a real swap -- the
 * actual conversion happens on-chain inside `withdraw` itself, using
 * `minXlmOut` from this quote as the slippage floor the relayer commits to
 * showing the user before they sign (see acceptance criteria on issue #149).
 */
export async function quoteFeeSwap(
  tokenId: string,
  feeAmount: string,
): Promise<FeeQuote | null> {
  if (!DEX_ROUTER_ID || !XLM_SAC_ID) return null;
  if (BigInt(feeAmount) <= BigInt(0)) return null;

  const path = [
    StellarSdk.nativeToScVal(tokenId, { type: "address" }),
    StellarSdk.nativeToScVal(XLM_SAC_ID, { type: "address" }),
  ];
  const result = await queryContract(DEX_ROUTER_ID, "get_amounts_out", [
    StellarSdk.nativeToScVal(BigInt(feeAmount), { type: "i128" }),
    StellarSdk.xdr.ScVal.scvVec(path),
  ]);
  if (!result) return null;

  const amounts = StellarSdk.scValToNative(result) as bigint[];
  const expectedXlmOut = amounts[amounts.length - 1];
  if (expectedXlmOut === undefined) return null;

  const minXlmOut =
    (expectedXlmOut * BigInt(10_000 - FEE_SLIPPAGE_BPS)) / BigInt(10_000);

  return {
    feeAmount,
    expectedXlmOut: expectedXlmOut.toString(),
    minXlmOut: minXlmOut.toString(),
  };
}

/**
 * Pre-flight version of the fee quote, run from the browser before the user
 * signs anything (see acceptance criteria on issue #149: "the effective fee
 * paid is shown to the user before they sign"). Goes through the server route
 * rather than calling `quoteFeeSwap` directly so it reflects the exact
 * config (router, fee asset, flat fee amount) `relay-withdraw` will use.
 */
export async function fetchWithdrawFeeQuote(
  poolId: string,
  asset: string,
): Promise<FeeQuote> {
  const fallback: FeeQuote = { feeAmount: "0", expectedXlmOut: "0", minXlmOut: "0" };
  try {
    const res = await fetch("/api/relay-withdraw-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId, asset }),
    });
    if (!res.ok) return fallback;
    const body = (await res.json().catch(() => null)) as FeeQuote | null;
    return body ?? fallback;
  } catch {
    return fallback;
  }
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
  /** SEP-41 token contract address the note being spent is denominated in. */
  asset: string;
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
    feeAmount?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || `Relayed withdrawal failed (${res.status})`);
  }
  return { hash: body.hash!, relayer: body.relayer!, feeAmount: body.feeAmount };
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
