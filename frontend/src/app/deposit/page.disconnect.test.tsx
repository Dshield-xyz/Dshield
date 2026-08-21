// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// Connected-wallet mock so the deposit form (not ConnectGate) renders.
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

// Keep the page's non-wallet dependencies real where possible, but stub the
// chain SDK surface that requires network access.
vi.mock("@/lib/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/stellar")>();
  return {
    ...actual,
    buildContractCall: vi.fn(),
    submitTransaction: vi.fn(),
    queryContract: vi.fn(),
    ensureUsdcTrustline: vi.fn(),
    faucetUsdc: vi.fn(),
    getUsdcSacId: vi.fn(() => null),
  };
});

describe("deposit page — wallet disconnect resilience", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the deposit form when a wallet is connected", async () => {
    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);
    expect(screen.getByText("Deposit")).toBeTruthy();
    // The form renders its main CTA (not the ConnectGate).
    expect(screen.getByText(/How it works/i)).toBeTruthy();
  });

  it("shows a recovery banner when pending notes were persisted (interrupted flow)", async () => {
    const note = {
      nullifier: "00" + "ab".repeat(31),
      secret: "00" + "cd".repeat(31),
      commitment: "00" + "ef".repeat(31),
      leafIndex: 3,
      amount: "100000000",
      spent: false,
      createdAt: Date.now(),
      poolId: "CABC123",
    };
    localStorage.setItem("dshield_pending_notes", JSON.stringify([note]));

    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);

    expect(screen.getByText(/pending note recovered/i)).toBeTruthy();
    expect(screen.getByText(/copy them now/i)).toBeTruthy();
    expect(screen.getByText("Discard all")).toBeTruthy();
  });

  it("discards recovered pending notes when the user clicks Discard all", async () => {
    const note = {
      nullifier: "00" + "ab".repeat(31),
      secret: "00" + "cd".repeat(31),
      commitment: "00" + "ef".repeat(31),
      leafIndex: 3,
      amount: "100000000",
      spent: false,
      createdAt: Date.now(),
      poolId: "CABC123",
    };
    localStorage.setItem("dshield_pending_notes", JSON.stringify([note]));

    const { default: DepositPage } = await import("./page");
    const { unmount } = render(<DepositPage />);
    expect(screen.getByText(/pending note recovered/i)).toBeTruthy();

    const discard = screen.getByText("Discard all");
    discard.click();

    await waitFor(() => {
      expect(screen.queryByText(/pending note recovered/i)).toBeNull();
    });
    expect(localStorage.getItem("dshield_pending_notes")).toBeNull();
    unmount();
  });
});