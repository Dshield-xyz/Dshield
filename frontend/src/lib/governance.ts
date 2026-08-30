import * as StellarSdk from "@stellar/stellar-sdk";
import { GOVERNANCE_CONTRACT_ID, buildContractCall, queryContract } from "@/lib/stellar";

export type CallStatus = "Pending" | "Executed" | "Cancelled";

export interface QueuedCall {
  id: number;
  target: string;
  function: string;
  eta: number; // unix seconds
  status: CallStatus;
}

/**
 * Reads governance's `QueuedCall` (see contracts/governance/src/lib.rs) for
 * `id`, or `null` if no call was ever queued with that id. `args` isn't
 * surfaced here: it's the XDR-encoded call arguments, useful for actually
 * executing the call but not for the pending-changes view this backs.
 */
export async function getQueuedCall(id: number): Promise<QueuedCall | null> {
  if (!GOVERNANCE_CONTRACT_ID) return null;
  const val = await queryContract(GOVERNANCE_CONTRACT_ID, "get_call", [
    StellarSdk.nativeToScVal(id, { type: "u32" }),
  ]);
  if (!val) return null;

  const native = StellarSdk.scValToNative(val) as {
    target: string;
    function: string;
    eta: string | number | bigint;
    status: { tag?: string } | string;
  } | null;
  if (!native) return null;

  const status =
    typeof native.status === "string" ? native.status : (native.status.tag ?? "Pending");

  return {
    id,
    target: native.target,
    function: native.function,
    eta: Number(native.eta),
    status: status as CallStatus,
  };
}

/** Scans ids `0..count` (governance's ids are sequential, starting at 0) and
 * returns every call found, newest first. `count` should come from a known
 * upper bound (e.g. the highest id you've queued/seen) since the contract
 * doesn't expose a total count. */
export async function listQueuedCalls(count: number): Promise<QueuedCall[]> {
  const ids = Array.from({ length: count }, (_, i) => i);
  const calls = await Promise.all(ids.map(getQueuedCall));
  return calls.filter((c): c is QueuedCall => c !== null).reverse();
}

export async function getTimelockDelaySeconds(): Promise<number | null> {
  if (!GOVERNANCE_CONTRACT_ID) return null;
  const val = await queryContract(GOVERNANCE_CONTRACT_ID, "get_delay", []);
  if (!val) return null;
  return Number(StellarSdk.scValToNative(val));
}

export async function getGovernanceAdmin(): Promise<string | null> {
  if (!GOVERNANCE_CONTRACT_ID) return null;
  const val = await queryContract(GOVERNANCE_CONTRACT_ID, "get_admin", []);
  if (!val) return null;
  return StellarSdk.scValToNative(val) as string;
}

/** Builds a `cancel(id)` call, signed by the connected wallet. Only the
 * governance contract's configured admin can actually cancel (see
 * contracts/governance/src/lib.rs `cancel`); a non-admin caller's
 * transaction will fail simulation/auth. */
export async function buildCancelCall(
  id: number,
  publicKey: string,
): Promise<StellarSdk.Transaction> {
  return buildContractCall(
    GOVERNANCE_CONTRACT_ID,
    "cancel",
    [StellarSdk.nativeToScVal(id, { type: "u32" })],
    publicKey,
  );
}

/** Builds an `execute(id)` call. Callable by anyone once the delay has
 * elapsed (see contracts/governance/src/lib.rs `execute`). */
export async function buildExecuteCall(
  id: number,
  publicKey: string,
): Promise<StellarSdk.Transaction> {
  return buildContractCall(
    GOVERNANCE_CONTRACT_ID,
    "execute",
    [StellarSdk.nativeToScVal(id, { type: "u32" })],
    publicKey,
  );
}
