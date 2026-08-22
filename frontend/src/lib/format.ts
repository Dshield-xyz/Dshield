// Token + formatting helpers shared across the app. Centralized here so the
// deposit, withdraw, compliance, and history views agree on decimals, the
// symbol, and how stroop <-> USDC conversions round.

export const TOKEN_DECIMALS = 7;
export const TOKEN_SYMBOL = "USDC";

const SCALE = 10 ** TOKEN_DECIMALS;

/**
 * Convert a human USDC string to a stroop string. Returns "0" for invalid input.
 *
 * Parsed as a decimal string rather than via `parseFloat` because the result is
 * now a note's exact committed value: the amount goes into the commitment hash
 * and into the on-chain transfer, and those two must agree to the stroop. A
 * float round-trip of something like "1234567.8912345" lands a unit or two off
 * and the note becomes unspendable. Anything finer than {@link TOKEN_DECIMALS}
 * is truncated, not rounded, so a deposit never asks for more than typed.
 */
export function usdcToStroops(usdc: string): string {
  const trimmed = usdc.trim();
  if (!/^\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    return "0";
  }
  const [whole, fraction = ""] = trimmed.split(".");
  const padded = (fraction + "0".repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS);
  const stroops = BigInt(whole || "0") * BigInt(SCALE) + BigInt(padded || "0");
  return stroops.toString();
}

/**
 * Format a stroop amount as USDC with as many decimals as it actually needs,
 * e.g. "137.42 USDC", "0.5 USDC", "100 USDC". Never rounds the value away: a
 * note can hold any amount, and a balance displayed as "0 USDC" when it is
 * really 0.4 would be actively misleading.
 */
export function formatAmount(stroops: string | number | bigint): string {
  return `${formatAmountBare(stroops)} ${TOKEN_SYMBOL}`;
}

/** {@link formatAmount} without the token symbol. */
export function formatAmountBare(stroops: string | number | bigint): string {
  let value: bigint;
  try {
    value = BigInt(stroops);
  } catch {
    return "0";
  }
  const negative = value < BigInt(0);
  if (negative) value = -value;
  const whole = value / BigInt(SCALE);
  const fraction = (value % BigInt(SCALE))
    .toString()
    .padStart(TOKEN_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
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
