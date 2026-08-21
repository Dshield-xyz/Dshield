// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mutable wallet mock so tests can simulate mid-flow disconnect/network-switch
let mockWalletState: {
  address: string | null;
  walletEventCount: number;
  networkMismatch: boolean;
  signTransaction: ReturnType<typeof vi.fn>;
};

vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({ ...mockWalletState }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Fixed on-chain root so the merkle-tree checks pass and the flow reaches the
// proof stage, where we can hold it open mid-flow.
const MOCK_ROOT = Buffer.alloc(32, 7); // 0x0707...07

vi.mock("@/lib/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes")>();
  return {
    ...actual,
    getActiveNotes: vi.fn(() => [
      {
        nullifier: "00aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
        secret: "00ddeeffaabbccdd00112233445566778899aabbccddeeff00112233445566778899",
        commitment: "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234",
        leafIndex: 0,
        amount: "10000000",
        spent: false,
        createdAt: Date.now(),
        poolId: "tier1",
      },
    ]),
    getNotes: vi.fn(() => []),
    markNoteSpent: vi.fn(),
    saveNoteIfNew: vi.fn(),
    serializeNotes: () => "",
  };
});
vi.mock("@/lib/stellar", () => ({
  buildContractCall: vi.fn().mockResolvedValue({ toXDR: () => "tx_xdr" }),
  submitTransaction: vi.fn().mockResolvedValue({ hash: "0xhash" }),
  queryContract: vi.fn().mockImplementation((_id: string, method: string) => {
    if (method === "get_root") return MOCK_ROOT;
    return null; // is_nullifier_used etc.
  }),
  ensureUsdcTrustline: vi.fn(),
  hasUsdcTrustline: vi.fn().mockResolvedValue(true),
  getUsdcSacId: () => null,
  relayWithdrawal: vi.fn().mockResolvedValue(null),
  POOL_CONTRACT_ID: "tier1",
}));
vi.mock("@stellar/stellar-sdk", () => ({
  nativeToScVal: () => ({ type: "address" }),
  scValToNative: (v: unknown) => v,
  xdr: { ScVal: { scvBytes: () => ({}), scvVec: () => ({}) } },
}));
vi.mock("@/lib/deposits", () => ({
  getAllCommitments: () => ["0707070707070707070707070707070707070707070707070707070707070707"],
  clearDeposits: vi.fn(),
}));
vi.mock("@/lib/poseidon2", () => ({
  computeNullifierHash: () => Promise.resolve("0xnullifierhash"),
  computeRecipientHash: () => Promise.resolve("0xrecipienthash"),
  buildMerkleTree: () =>
    Promise.resolve({
      root: "0x" + "07".repeat(32),
      pathSiblings: [],
      pathBits: [],
    }),
}));
vi.mock("@/lib/indexer", () => ({
  syncDepositsFromChain: vi.fn().mockResolvedValue(0),
  fetchCommitmentsFromChain: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/prover", () => ({
  proveWithdrawal: () => {
    // Hold the proof open so we can detect the disconnect mid-flow
    return new Promise(() => {}); // never resolves
  },
}));
vi.mock("@/lib/errors", () => ({ friendlyError: (e: unknown) => String(e) }));
vi.mock("@/lib/sync", () => ({ syncSpentNotes: () => Promise.resolve(0) }));
vi.mock("@/lib/format", () => ({ truncateMiddle: (s: string, a: number, b: number) => s.slice(0, a) + "..." + s.slice(-b) }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/ui/Page", () => ({
  PageShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: () => <div />,
  ConnectGate: ({ title, prompt }: { title: string; prompt: string }) => (
    <div>
      <h1>{title}</h1>
      <p>{prompt}</p>
    </div>
  ),
}));
vi.mock("@/components/ui/Card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/ui/Button", () => ({
  Button: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
  buttonVariants: () => "",
}));
vi.mock("@/components/ui/Input", () => ({
  Input: (props: { label?: string; value: string; onChange: (e: { target: { value: string } }) => void; placeholder?: string }) => (
    <label>
      {props.label}
      <input value={props.value} onChange={props.onChange} placeholder={props.placeholder} />
    </label>
  ),
}));
vi.mock("@/components/ui/SelectButton", () => ({
  SelectButton: ({ children }: { children: React.ReactNode }) => <button type="button">{children}</button>,
}));
vi.mock("@/components/ui/ProgressSteps", () => ({
  ProgressSteps: ({ label }: { label: string }) => <div>{label}</div>,
}));
vi.mock("@/components/ui/NoteImport", () => ({
  NoteImport: () => <div />,
}));

const ADDR = "GABC123456789012345678901234567890123456789012345";

describe("WithdrawPage — wallet disconnect/network-switch resilience", () => {
  beforeEach(() => {
    mockWalletState = {
      address: ADDR,
      walletEventCount: 0,
      networkMismatch: false,
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
    };
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows an interruption banner when wallet disconnects mid-flow", async () => {
    const { default: WithdrawPage } = await import("./page");
    const { rerender } = render(<WithdrawPage />);

    // Select the pre-loaded note by clicking the select button
    await userEvent.click(screen.getByText(/abcd1234/));

    // Start a withdrawal — proof generation is held open (never resolves)
    await userEvent.click(screen.getByRole("button", { name: /Generate Proof.*Withdraw/ }));

    // Wait until the flow reaches the proof stage
    await waitFor(() => {
      expect(screen.getByText(/Generating your private proof/)).toBeInTheDocument();
    });

    // Simulate disconnect mid-flow
    mockWalletState.address = null;
    mockWalletState.walletEventCount += 1;
    rerender(<WithdrawPage />);

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const interruption = alerts.find((a) => a.textContent.includes("Flow interrupted"));
      expect(interruption).toBeTruthy();
      expect(interruption!.textContent).toContain("Wallet disconnected mid-flow");
    });
  });

  it("shows a network mismatch banner and disables the withdraw button", async () => {
    mockWalletState.networkMismatch = true;
    const { default: WithdrawPage } = await import("./page");
    render(<WithdrawPage />);

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("different network");

    // Select the pre-loaded note to reveal the withdraw button
    await userEvent.click(screen.getByText(/abcd1234/));

    const btn = screen.getByRole("button", { name: "Network mismatch" });
    expect(btn).toBeDisabled();
  });
});