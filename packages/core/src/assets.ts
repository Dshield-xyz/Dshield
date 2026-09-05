/**
 * Asset discovery for the multi-asset pool.
 *
 * A single pool instance shields notes for every asset on its admin-managed
 * allow-list, over one shared Merkle tree and nullifier set — the anonymity set
 * is shared across assets rather than fragmented into a pool per token. Which
 * assets those are is decided on-chain, so the clients read the list from the
 * contract (`get_assets`) rather than hardcoding one token, and read each
 * asset's own `symbol`/`decimals` off its SEP-41 contract rather than assuming
 * the 7-decimal USDC the demo deployment used to be pinned to.
 *
 * Native XLM participates like any other asset: it is shielded through its
 * Stellar Asset Contract, which implements the same SEP-41 interface. The one
 * thing that makes it special is off-chain — an account needs no trustline to
 * hold XLM — so {@link AssetInfo.native} is exposed for callers that must skip
 * the trustline dance.
 */
import * as StellarSdk from "@stellar/stellar-sdk";
import { type ChainConfig, queryContractView } from "./chain.js";
import { DEFAULT_DECIMALS } from "./format.js";

export interface AssetInfo {
  /** SEP-41 token contract address (C…). This is what the pool allow-lists. */
  contractId: string;
  /** Display symbol, e.g. "XLM" or "USDC". */
  symbol: string;
  /** Precision of the asset's smallest unit. */
  decimals: number;
  /** True for the native XLM Stellar Asset Contract, which needs no trustline. */
  native: boolean;
}

/**
 * The symbol a Stellar Asset Contract reports for native XLM. The SAC returns
 * the string "native" rather than "XLM", which is an implementation detail no
 * user should ever be shown.
 */
const NATIVE_SAC_SYMBOL = "native";

export const NATIVE_SYMBOL = "XLM";

/** Contract address of the native XLM Stellar Asset Contract on this network. */
export function nativeSacId(networkPassphrase: string): string {
  return StellarSdk.Asset.native().contractId(networkPassphrase);
}

/** Contract address of the Stellar Asset Contract wrapping a classic asset. */
export function classicSacId(
  code: string,
  issuer: string,
  networkPassphrase: string,
): string {
  return new StellarSdk.Asset(code, issuer).contractId(networkPassphrase);
}

/** True if `contractId` is this network's native XLM SAC. */
export function isNativeAsset(
  contractId: string,
  networkPassphrase: string,
): boolean {
  try {
    return contractId === nativeSacId(networkPassphrase);
  } catch {
    return false;
  }
}

function scValToString(val: StellarSdk.xdr.ScVal | null): string | null {
  if (!val) return null;
  const native = StellarSdk.scValToNative(val) as unknown;
  if (typeof native === "string") return native;
  // A SAC returns its symbol as ScSymbol/ScString; anything else (Buffer from a
  // non-standard token) is decoded as UTF-8 rather than shown as "[object …]".
  if (native instanceof Uint8Array) return Buffer.from(native).toString("utf8");
  return null;
}

/**
 * Reads an asset's display metadata straight off its SEP-41 contract.
 *
 * Falls back to a truncated contract address and {@link DEFAULT_DECIMALS} when
 * a token doesn't implement `symbol`/`decimals` — an asset the admin has
 * allow-listed must stay usable even if its metadata calls fail, since notes
 * denominated in it may already exist in the tree. Getting `decimals` wrong
 * only misformats the display; the on-chain amount is always in base units.
 */
export async function fetchAssetInfo(
  cfg: ChainConfig,
  contractId: string,
): Promise<AssetInfo> {
  const native = isNativeAsset(contractId, cfg.networkPassphrase);

  const [symbolVal, decimalsVal] = await Promise.all([
    queryContractView(cfg, contractId, "symbol"),
    queryContractView(cfg, contractId, "decimals"),
  ]);

  let symbol = scValToString(symbolVal);
  if (native || symbol === NATIVE_SAC_SYMBOL) symbol = NATIVE_SYMBOL;
  if (!symbol) symbol = `${contractId.slice(0, 4)}…${contractId.slice(-4)}`;

  const rawDecimals = decimalsVal
    ? (StellarSdk.scValToNative(decimalsVal) as number)
    : null;
  const decimals =
    typeof rawDecimals === "number" && Number.isInteger(rawDecimals) &&
    rawDecimals >= 0 && rawDecimals <= 38
      ? rawDecimals
      : DEFAULT_DECIMALS;

  return { contractId, symbol, decimals, native };
}

/**
 * Every asset the pool currently accepts, in registration order, with the
 * metadata needed to display and parse amounts in it.
 *
 * Returns an empty list — never a partial one — if the allow-list itself can't
 * be read, so a caller never mistakes an RPC failure for "this pool supports
 * exactly one asset" and shields into the wrong token.
 */
export async function fetchPoolAssets(
  cfg: ChainConfig,
  poolId: string,
): Promise<AssetInfo[]> {
  const val = await queryContractView(cfg, poolId, "get_assets");
  if (!val) return [];
  const addresses = StellarSdk.scValToNative(val) as string[];
  if (!Array.isArray(addresses)) return [];
  return Promise.all(addresses.map((a) => fetchAssetInfo(cfg, a)));
}

/**
 * Picks the asset a note is denominated in out of a known list.
 *
 * A note stores its asset's contract address, so this is a lookup rather than a
 * guess. When the asset is no longer allow-listed (the admin removed it, but
 * the note still exists and is still spendable if it is re-added) the caller
 * gets a placeholder with safe defaults instead of `undefined`, so amounts
 * still render.
 */
export function resolveAsset(
  assets: AssetInfo[],
  contractId: string,
): AssetInfo {
  const found = assets.find((a) => a.contractId === contractId);
  if (found) return found;
  return {
    contractId,
    symbol: contractId ? `${contractId.slice(0, 4)}…${contractId.slice(-4)}` : "?",
    decimals: DEFAULT_DECIMALS,
    native: false,
  };
}
