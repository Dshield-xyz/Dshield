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
  ensureUsdcTrustline: vi.fn(),
  hasUsdcTrustline: vi.fn(),
  getUsdcSacId: () => "sac_id",
  relayWithdrawal: vi.fn(),
  POOL_CONTRACT_ID: "pool_contract",
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
vi.mock("@/lib/deposits", () => ({ getAllCommitments: () => [], clearDeposits: vi.fn() }));
vi.mock("@/lib/poseidon2", () => ({
  computeNullifierHash: vi.fn(),
  computeRecipientHash: vi.fn(),
  buildMerkleTree: vi.fn(),
}));
vi.mock("@/lib/indexer", () => ({ syncDepositsFromChain: vi.fn(), fetchCommitmentsFromChain: vi.fn() }));
vi.mock("@/lib/prover", () => ({ proveWithdrawal: vi.fn() }));
vi.mock("@/lib/errors", () => ({ friendlyError: (e: unknown) => String(e) }));
vi.mock("@/lib/sync", () => ({ syncSpentNotes: () => Promise.resolve(0) }));
vi.mock("@/lib/format", () => ({
  truncateMiddle: (s: string, a: number, b: number) => s.slice(0, a) + "…" + s.slice(-b),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

describe("WithdrawPage — disconnected", () => {
  it("renders ConnectGate when wallet is not connected", async () => {
    const { default: WithdrawPage } = await import("./page");
    render(<WithdrawPage />);
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
  });
});