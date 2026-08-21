// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock WalletProvider for disconnected state
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: null,
    signTransaction: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnecting: false,
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/stellar", () => ({
  buildContractCall: vi.fn(),
  submitTransaction: vi.fn(),
  queryContract: vi.fn(),
  getPoolTiers: () => [],
  ensureUsdcTrustline: vi.fn(),
  faucetUsdc: vi.fn(),
  getUsdcSacId: () => null,
}));
vi.mock("@/lib/notes", () => ({
  saveNote: vi.fn(),
  serializeNote: () => "",
  generateNoteLink: () => "",
  generateRandomField: () => "0xrandom",
  ShieldedNote: {} as any,
}));
vi.mock("@/lib/deposits", () => ({ saveDeposit: vi.fn() }));
vi.mock("@/lib/poseidon2", () => ({ computeCommitment: () => Promise.resolve("0xcommitment") }));
vi.mock("@/lib/errors", () => ({ friendlyError: (e: unknown) => String(e) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/format", () => ({
  TOKEN_DECIMALS: 7, TOKEN_SYMBOL: "USDC", formatStroops: (v: bigint) => String(v),
}));

describe("DepositPage — disconnected", () => {
  it("renders ConnectGate when wallet is not connected", async () => {
    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
  });
});