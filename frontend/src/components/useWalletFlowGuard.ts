"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useWallet } from "@/components/WalletProvider";

/**
 * Tracks whether the wallet was disconnected while a flow was active.
 *
 * Pass `active = true` while a flow is running (e.g. `isLoading`). When the
 * wallet disconnects mid-flow, `interrupted` becomes true and stays true until
 * `reset()` is called. The flow can then show a recovery banner, persist
 * in-progress state, and safely pause.
 *
 * Returning a non-null `recovery` object means previously-saved in-progress
 * state was found on mount and should be surfaced to the user.
 */
export function useWalletFlowGuard(active: boolean): {
  interrupted: boolean;
  reset: () => void;
} {
  const { address, connectionVersion } = useWallet();
  const [interrupted, setInterrupted] = useState(false);
  const prevAddress = useRef(address);

  useEffect(() => {
    // Detect transition from connected → disconnected mid-flow
    if (prevAddress.current && !address) {
      setInterrupted(true);
    }
    prevAddress.current = address;
  }, [address, connectionVersion]);

  const reset = useCallback(() => {
    setInterrupted(false);
    prevAddress.current = address;
  }, [address]);

  return { interrupted, reset };
}