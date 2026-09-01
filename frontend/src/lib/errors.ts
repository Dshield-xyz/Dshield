/**
 * Converts raw SDK / network / contract errors into short, readable messages.
 * Call this inside every catch block before toasting.
 */
export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();

  // --- Hardware wallet (Ledger) failures ---
  // Checked before the generic "user declined" cases (first below) because a
  // device rejection is a distinct UX from a browser-extension decline.
  if (
    lower.includes("locked device") ||
    lower.includes("device is locked") ||
    lower.includes("please unlock") ||
    lower.includes("unlock your device") ||
    lower.includes("unlock your ledger")
  )
    return "Your Ledger is locked — unlock it and try again.";

  // hw-app-str surfaces "wrong app" as a transport status code: 0x6d00 (INS
  // not supported) or 0x6e00 (CLA not supported) when the Stellar app isn't
  // the one open on the device.
  if (
    lower.includes("wrong app") ||
    lower.includes("6d00") ||
    lower.includes("6e00") ||
    lower.includes("stellar app") ||
    lower.includes("app is not open")
  )
    return "Open the Stellar app on your Ledger and try again.";

  if (
    lower.includes("condition of use") ||
    lower.includes("denied by the user") ||
    lower.includes("rejected on your device")
  )
    return "Cancelled — you declined the request on your Ledger device.";

  if (
    lower.includes("webusb") ||
    lower.includes("no device selected") ||
    lower.includes("device not found") ||
    lower.includes("notfounderror") ||
    lower.includes("ledger can not be used") ||
    lower.includes("ledger wallets can not be used") ||
    (lower.includes("transport") && lower.includes("ledger"))
  )
    return "Couldn't reach your Ledger device — connect it via USB, allow the browser to access it, and try again.";

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

  if (lower.includes("kyc") || lower.includes("not allowed"))
    return "The on-ramp could not verify your identity. Review its requirements or choose another payment method.";

  if (lower.includes("expired") || lower.includes("refunded"))
    return "Your on-ramp session expired or was refunded. No funds were shielded; please start again.";

  if (lower.includes("sep-24") || lower.includes("on-ramp") || lower.includes("anchor"))
    return "The fiat on-ramp is unavailable right now. Please try again shortly.";

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

  return "Something went wrong — please try again.";
}
