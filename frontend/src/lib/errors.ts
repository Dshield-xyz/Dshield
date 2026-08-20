/**
 * Converts raw SDK / network / contract errors into short, readable messages.
 * Call this inside every catch block before toasting.
 *
 * @param fallback — Used when the raw error message is too long to display
 *   as-is and no known pattern matched.
 */
export function friendlyError(err: unknown, fallback?: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  if (
    lower.includes("user declined") ||
    lower.includes("user rejected") ||
    lower.includes("rejected the request") ||
    lower.includes("declined access")
  )
    return "Cancelled — you declined the signature in your wallet.";

  if (
    lower.includes("failed to fetch") ||
    lower.includes("networkerror") ||
    lower.includes("network error") ||
    lower.includes("etimedout") ||
    lower.includes("econnrefused")
  )
    return "Network error — check your connection and try again.";

  if (lower.includes("timed out") || lower.includes("timeout"))
    return "The request timed out. The network may be busy — try again in a moment.";

  if (lower.includes("insufficient") && lower.includes("fund"))
    return "Insufficient funds — your wallet doesn't have enough USDC.";

  if (
    lower.includes("invoke_host_function") ||
    lower.includes("transactionfailed") ||
    lower.includes("tx_failed") ||
    lower.includes("error(contract")
  )
    return "The transaction was rejected on-chain. Check your note and try again.";

  // Keep raw message only if it's short enough to be readable as-is
  if (raw.length < 100) return raw;

  return fallback ?? "Something went wrong — please try again.";
}
