// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Connected-wallet mock so the withdraw form (not ConnectGate) renders.
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567",
    network: "Standalone Network ; February 2017",
    signTransaction: vi.fn(),
    isConnecting: false,
    connectionVersion: 0,
    lastDisconnectAt: null,
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar")>();
  return {
    ...actual,
    buildContractCall: vi.fn(),
    submitTransaction: vi.fn(),
    queryContract: vi.fn(),
    ensureUsdcTrustline: vi.fn(),
    hasUsdcTrustline: vi.fn(),
    getUsdcSacId: vi.fn(() => null),
  };
});

// Stub the prover (Web Worker) so the page renders without heavy machinery.
vi.mock("@/lib/prover", () => ({
  proveWithdrawal: vi.fn(),
}));

describe("withdraw page — wallet disconnect resilience", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the withdraw form when a wallet is connected", async () => {
    const { default: WithdrawPage } = await import("./page");
    render(<WithdrawPage />);
    expect(screen.getByText("Withdraw")).toBeTruthy();
  });

  it("restores a persisted draft and shows the recovery banner", async () => {
    const draft = {
      selectedCommitments: ["00" + "aa".repeat(31)],
      recipient: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567",
    };
    localStorage.setItem("dshield_withdraw_draft", JSON.stringify(draft));

    const { default: WithdrawPage } = await import("./page");
    render(<WithdrawPage />);

    expect(screen.getByText("Previous selection recovered")).toBeTruthy();
    expect(screen.getByText(/was restored/i)).toBeTruthy();
  });

  it("clears the draft when the user dismisses the recovered selection", async () => {
    const draft = {
      selectedCommitments: ["00" + "aa".repeat(31)],
      recipient: "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567",
    };
    localStorage.setItem("dshield_withdraw_draft", JSON.stringify(draft));

    const { default: WithdrawPage } = await import("./page");
    const { unmount } = render(<WithdrawPage />);
    expect(screen.getByText("Previous selection recovered")).toBeTruthy();

    const dismiss = screen.getByText("Dismiss selection");
    dismiss.click();

    await waitFor(() => {
      expect(screen.queryByText("Previous selection recovered")).toBeNull();
    });
    expect(localStorage.getItem("dshield_withdraw_draft")).toBeNull();
    unmount();
  });
});