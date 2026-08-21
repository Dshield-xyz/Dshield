// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock WalletProvider for connected state
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: "GABC123456789012345678901234567890123456789012345",
    signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnecting: false,
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/stellar", () => ({
  buildContractCall: vi.fn().mockResolvedValue({ toXDR: () => "tx_xdr" }),
  submitTransaction: vi.fn().mockResolvedValue({ hash: "0xhash" }),
  queryContract: vi.fn().mockResolvedValue(null),
  getPoolTiers: () => [{ id: "tier1", amount: 10000000, label: "10 USDC" }],
  ensureUsdcTrustline: vi.fn(),
  faucetUsdc: vi.fn(),
  getUsdcSacId: () => "sac_id",
}));
vi.mock("@/lib/notes", () => ({
  saveNote: vi.fn(),
  serializeNote: () => "note_data",
  generateNoteLink: () => "https://dshield.test/note",
  generateRandomField: () => "0xrandom123",
  ShieldedNote: {} as any,
}));
vi.mock("@/lib/deposits", () => ({ saveDeposit: vi.fn() }));
vi.mock("@/lib/poseidon2", () => ({ computeCommitment: () => Promise.resolve("0xcommitment123") }));
vi.mock("@/lib/errors", () => ({ friendlyError: (e: unknown) => String(e) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/format", () => ({
  TOKEN_DECIMALS: 7, TOKEN_SYMBOL: "USDC", formatStroops: (v: bigint) => String(v),
}));

describe("DepositPage — connected", () => {
  it("renders deposit form when connected (not ConnectGate)", async () => {
    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);
    expect(screen.queryByText("Connect Wallet")).not.toBeInTheDocument();
    expect(screen.getByText("Shield 10000000")).toBeInTheDocument();
    expect(screen.getByText("Amount (USDC)")).toBeInTheDocument();
  });
});