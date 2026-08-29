import * as StellarSdk from "@stellar/stellar-sdk";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || "Standalone Network ; February 2017";
const DEV_SECRET_KEY = process.env.NEXT_PUBLIC_DEV_SECRET_KEY || "";

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

export function getDevKeypair(): StellarSdk.Keypair | null {
  if (!DEV_SECRET_KEY) return null;
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
export async function fetchWithdrawFeeQuote(poolId: string): Promise<FeeQuote> {
  const fallback: FeeQuote = { feeAmount: "0", expectedXlmOut: "0", minXlmOut: "0" };
  try {
    const res = await fetch("/api/relay-withdraw-quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ poolId }),
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
