// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";

// Mutable mock wallet state so we can simulate a mid-flow disconnect.
const walletState: { address: string | null; connectionVersion: number } = {
  address: "GABCDEF...",
  connectionVersion: 0,
};

let onAddressChange: ((addr: string | null) => void) | undefined;

beforeEach(() => {
  walletState.address = "GABCDEF...";
  walletState.connectionVersion = 0;
  onAddressChange = undefined;
});

vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: walletState.address,
    network: "Standalone Network ; February 2017",
    signTransaction: vi.fn(),
    isConnecting: false,
    connectionVersion: walletState.connectionVersion,
    lastDisconnectAt: null,
  }),
  WalletProvider: ({ children }: { children: ReactNode }) => {
    onAddressChange = (addr: string | null) => {
      walletState.address = addr;
      walletState.connectionVersion += 1;
    };
    return <>{children}</>;
  },
}));

import { useWalletFlowGuard } from "@/components/useWalletFlowGuard";
import { WalletProvider } from "@/components/WalletProvider";

// Wrapper renders the real WalletProvider so onAddressChange gets wired up.
function wrapper({ children }: { children: ReactNode }) {
  return <WalletProvider>{children}</WalletProvider>;
}

describe("useWalletFlowGuard", () => {
  it("does not interrupt when wallet stays connected", () => {
    const { result } = renderHook(() => useWalletFlowGuard(true), { wrapper });
    expect(result.current.interrupted).toBe(false);
  });

  it("sets interrupted when the wallet disconnects", () => {
    const { result, rerender } = renderHook(() => useWalletFlowGuard(true), {
      wrapper,
    });
    expect(result.current.interrupted).toBe(false);

    // Simulate a wallet disconnect.
    act(() => {
      onAddressChange?.(null);
    });
    rerender();
    expect(result.current.interrupted).toBe(true);
  });

  it("does not interrupt on initial mount when already disconnected", () => {
    walletState.address = null;
    walletState.connectionVersion = 0;

    const { result, unmount } = renderHook(() => useWalletFlowGuard(true), {
      wrapper,
    });
    expect(result.current.interrupted).toBe(false);
    unmount();
  });

  it("clears interrupted after reset()", () => {
    const { result, rerender } = renderHook(() => useWalletFlowGuard(true), {
      wrapper,
    });
    act(() => {
      onAddressChange?.(null);
    });
    rerender();
    expect(result.current.interrupted).toBe(true);

    act(() => {
      result.current.reset();
    });
    expect(result.current.interrupted).toBe(false);
  });

  it("re-arms for a subsequent disconnect after reset", () => {
    const { result, rerender } = renderHook(() => useWalletFlowGuard(true), {
      wrapper,
    });
    // First disconnect
    act(() => {
      onAddressChange?.(null);
    });
    act(() => {
      rerender();
    });
    expect(result.current.interrupted).toBe(true);
    act(() => {
      result.current.reset();
    });

    // Reconnect
    act(() => {
      onAddressChange?.("GABCDEF...");
    });
    act(() => {
      rerender();
    });
    expect(result.current.interrupted).toBe(false);

    // Disconnect again
    act(() => {
      onAddressChange?.(null);
    });
    act(() => {
      rerender();
    });
    expect(result.current.interrupted).toBe(true);
  });
});