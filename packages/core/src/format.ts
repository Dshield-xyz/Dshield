// Amount formatting shared by the browser app, the `dshield` CLI and the
// indexer, so all three agree on how a note's value is parsed and displayed.
//
// The pool holds notes for several allow-listed SEP-41 assets over one shared
// tree, so nothing here may assume a single token: every conversion takes the
// asset's `decimals` explicitly. `DEFAULT_DECIMALS` is the Stellar Asset
// Contract convention (7, matching classic assets and XLM) and is only a
// fallback for call sites that have no asset in hand.

export const DEFAULT_DECIMALS = 7;

/**
 * @deprecated Read `decimals` off the note's asset ({@link AssetInfo}) instead.
 * Kept so call sites that predate multi-asset support keep compiling; it is
 * only correct for 7-decimal assets.
 */
export const TOKEN_DECIMALS = DEFAULT_DECIMALS;

/**
 * @deprecated Read `symbol` off the note's asset ({@link AssetInfo}) instead.
 * Labelling an XLM note "USDC" is worse than showing no symbol at all.
 */
export const TOKEN_SYMBOL = "USDC";

function scale(decimals: number): bigint {
  return BigInt(10) ** BigInt(decimals);
}

/**
 * Convert a human-typed amount ("1.5") to the asset's smallest unit ("15000000"
 * at 7 decimals). Returns "0" for anything that isn't a plain decimal number.
 *
 * Parsed as a decimal string rather than via `parseFloat` because the result is
 * a note's exact committed value: the amount goes into the commitment hash and
 * into the on-chain transfer, and those two must agree to the last unit. A
 * float round-trip of something like "1234567.8912345" lands a unit or two off
 * and the note becomes permanently unspendable. Anything finer than the asset's
 * precision is truncated, not rounded, so a deposit never asks the wallet for
 * more than the user typed.
 */
export function toBaseUnits(
  amount: string,
  decimals: number = DEFAULT_DECIMALS,
): string {
  const trimmed = amount.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return "0";
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const padded = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const units = BigInt(whole || "0") * scale(decimals) + BigInt(padded || "0");
  return units.toString();
}

/**
 * Render a base-unit amount with as many decimal places as it actually needs,
 * e.g. "137.42", "0.5", "100". Never rounds a non-zero value away to zero — a
 * change note worth 0.0000001 displayed as "0" would read as "gone".
 */
export function fromBaseUnits(
  units: string | number | bigint,
  decimals: number = DEFAULT_DECIMALS,
): string {
  let value: bigint;
  try {
    value = BigInt(units);
  } catch {
    return "0";
  }
  const negative = value < BigInt(0);
  if (negative) value = -value;
  const divisor = scale(decimals);
  const whole = value / divisor;
  const fraction = (value % divisor)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}

/** {@link fromBaseUnits} with the asset's symbol appended, e.g. "137.42 XLM". */
export function formatUnits(
  units: string | number | bigint,
  symbol: string,
  decimals: number = DEFAULT_DECIMALS,
): string {
  return `${fromBaseUnits(units, decimals)} ${symbol}`;
}

/**
 * @deprecated Use {@link toBaseUnits} with the asset's decimals.
 */
export function usdcToStroops(usdc: string): string {
  return toBaseUnits(usdc, DEFAULT_DECIMALS);
}

/**
 * @deprecated Use {@link formatUnits} with the asset's symbol and decimals.
 */
export function formatAmount(units: string | number | bigint): string {
  return formatUnits(units, TOKEN_SYMBOL, DEFAULT_DECIMALS);
}

/**
 * @deprecated Use {@link fromBaseUnits} with the asset's decimals.
 */
export function formatAmountBare(units: string | number | bigint): string {
  return fromBaseUnits(units, DEFAULT_DECIMALS);
}

/**
 * Truncate a long identifier to `lead` leading and `tail` trailing characters
 * joined by an ellipsis, e.g. `truncateMiddle(hash, 4, 4)` -> "ab12…ef90".
 * Strings already short enough are returned unchanged.
 */
export function truncateMiddle(value: string, lead = 4, tail = 4): string {
  if (value.length <= lead + tail) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
