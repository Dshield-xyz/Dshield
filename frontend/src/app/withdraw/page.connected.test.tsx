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

vi.mock("@/lib/notes", () => ({
  getActiveNotes: () => [],
  getNotes: () => [],
  markNoteSpent: vi.fn(),
  parseNote: () => null,
  saveNoteIfNew: vi.fn(),
  serializeNotes: () => "",
  ShieldedNote: {} as any,
}));
vi.mock("@/lib/format", () => ({
  truncateMiddle: (s: string, a: number, b: number) => s.slice(0, a) + "…" + s.slice(-b),
}));
vi.mock("@/lib/sync", () => ({ syncSpentNotes: () => Promise.resolve(0) }));
vi.mock("@/lib/stellar", () => ({
  buildContractCall: vi.fn(),
  submitTransaction: vi.fn(),
  queryContract: vi.fn(),
  ensureUsdcTrustline: vi.fn(),
  hasUsdcTrustline: vi.fn(),
  getUsdcSacId: () => "sac_id",
  relayWithdrawal: vi.fn(),
  POOL_CONTRACT_ID: "pool_contract",
}));
vi.mock("@/lib/deposits", () => ({ getAllCommitments: () => [], clearDeposits: vi.fn() }));
vi.mock("@/lib/poseidon2", () => ({
  computeNullifierHash: vi.fn(),
  computeRecipientHash: vi.fn(),
  buildMerkleTree: vi.fn(),
}));
vi.mock("@/lib/indexer", () => ({ syncDepositsFromChain: vi.fn(), fetchCommitmentsFromChain: vi.fn() }));
vi.mock("@/lib/prover", () => ({ proveWithdrawal: vi.fn() }));
vi.mock("@/lib/errors", () => ({ friendlyError: (e: unknown) => String(e) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe("WithdrawPage — connected", () => {
  it("renders withdraw page when connected (not ConnectGate)", async () => {
    const { default: WithdrawPage } = await import("./page");
    render(<WithdrawPage />);
    expect(screen.queryByText("Connect Wallet")).not.toBeInTheDocument();
    // No notes → empty state, no download button
    expect(screen.getByText(/You don.*t have any notes to withdraw/)).toBeInTheDocument();
    expect(screen.getByText("Make a deposit")).toBeInTheDocument();
  });

  it("shows empty-state text when no notes exist", async () => {
    const { default: WithdrawPage } = await import("./page");
    render(<WithdrawPage />);
    expect(screen.getByText(/You don.*t have any notes to withdraw/)).toBeInTheDocument();
    expect(screen.getByText(/Received a note from someone\? Import it below/)).toBeInTheDocument();
  });
});