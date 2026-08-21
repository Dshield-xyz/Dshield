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

vi.mock("@/lib/stellar", () => ({
  buildContractCall: vi.fn().mockResolvedValue({ toXDR: () => "tx_xdr" }),
  submitTransaction: vi.fn().mockResolvedValue({ hash: "0xhash" }),
  queryContract: vi.fn().mockResolvedValue(null),
  getPoolTiers: () => [{ id: "tier1", amount: 10000000, label: "10 USDC" }],
  ensureUsdcTrustline: vi.fn(),
  faucetUsdc: vi.fn(),
  getUsdcSacId: () => null,
}));
vi.mock("@/lib/notes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notes")>();
  return {
    ...actual,
    saveNote: vi.fn(async (note) => {
      const notes = JSON.parse(localStorage.getItem("dshield_notes") || "[]");
      notes.push(note);
      localStorage.setItem("dshield_notes", JSON.stringify(notes));
    }),
    saveDraftNotes: vi.fn(actual.saveDraftNotes),
    getDraftNotes: vi.fn(actual.getDraftNotes),
    clearDraftNotes: vi.fn(actual.clearDraftNotes),
    generateRandomField: vi.fn().mockReturnValue("00aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"),
    serializeNote: actual.serializeNote,
    generateNoteLink: actual.generateNoteLink,
  };
});
vi.mock("@/lib/deposits", () => ({ saveDeposit: vi.fn() }));
vi.mock("@/lib/poseidon2", () => ({ computeCommitment: () => Promise.resolve("0xcommitment123") }));
vi.mock("@/lib/errors", () => ({ friendlyError: (e: unknown) => String(e) }));
vi.mock("@stellar/stellar-sdk", () => ({
  nativeToScVal: () => ({ type: "address" }),
  xdr: { ScVal: { scvBytes: () => ({}), scvVec: () => ({}) } },
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/lib/format", () => ({
  TOKEN_DECIMALS: 7,
  TOKEN_SYMBOL: "USDC",
  formatStroops: (v: bigint | number) => String(v),
}));
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
vi.mock("@/components/icons", () => ({
  CopyIcon: () => <span>copy</span>,
  TelegramIcon: () => <span>tg</span>,
  WhatsAppIcon: () => <span>wa</span>,
  XIcon: () => <span>x</span>,
}));

const ADDR = "GABC123456789012345678901234567890123456789012345";

describe("DepositPage — wallet disconnect/network-switch resilience", () => {
  beforeEach(() => {
    mockWalletState = {
      address: ADDR,
      walletEventCount: 0,
      networkMismatch: false,
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
    };
    localStorage.clear();
  });

  it("shows an interruption banner when wallet disconnects mid-flow", async () => {
    // Hold the sign step open so we can detect the disconnect mid-flow
    let resolveSign: (v: string) => void = () => {};
    mockWalletState.signTransaction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSign = resolve;
        }),
    );

    const notes = await import("@/lib/notes");
    const saveDraftSpy = vi.mocked(notes.saveDraftNotes);

    const { default: DepositPage } = await import("./page");
    const { rerender } = render(<DepositPage />);

    // Click the deposit button (name contains "Shield 10000000")
    await userEvent.click(screen.getByRole("button", { name: /Shield 10000000/ }));

    // Ensure the flow started and draft notes are persisted (sign is held open)
    await waitFor(() => {
      expect(saveDraftSpy).toHaveBeenCalled();
    });

    // Simulate disconnect while the flow is in flight — force a re-render
    // so the effect sees the new walletEventCount (mock state change alone
    // does not trigger React re-renders).
    mockWalletState.address = null;
    mockWalletState.walletEventCount += 1;
    rerender(<DepositPage />);

    // The interruption banner should appear
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Flow interrupted");
    });
    expect(screen.getByRole("alert").textContent).toContain("Wallet disconnected mid-flow");
  });

  it("saves draft notes before signing so a disconnect never loses them", async () => {
    let resolveSign: (v: string) => void = () => {};
    mockWalletState.signTransaction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSign = resolve;
        }),
    );

    const notes = await import("@/lib/notes");
    const saveDraftSpy = vi.mocked(notes.saveDraftNotes);

    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);

    // Click the deposit button
    await userEvent.click(screen.getByRole("button", { name: /Shield 10000000/ }));

    // Before sign is resolved, draft notes must already be persisted
    await waitFor(() => {
      expect(saveDraftSpy).toHaveBeenCalled();
    });
    expect(notes.getDraftNotes()).toHaveLength(1);

    // Complete the flow — draft must be promoted and cleared
    resolveSign("signed_xdr");
    await waitFor(() => {
      expect(notes.clearDraftNotes).toHaveBeenCalled();
    });
    expect(notes.getDraftNotes()).toHaveLength(0);
    expect(notes.getNotes()).toHaveLength(1);
  });

  it("shows a recovery banner for stranded draft notes from a previous session", async () => {
    const notes = await import("@/lib/notes");
    await notes.saveDraftNotes([
      {
        nullifier: "00aabbcc",
        secret: "00ddeeff",
        commitment: "abcd1234",
        leafIndex: 0,
        amount: "10000000",
        spent: false,
        createdAt: Date.now(),
        poolId: "tier1",
      },
    ]);

    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("1 unsaved note found from a previous session");

    // Recover promotes the draft to permanent notes
    await userEvent.click(screen.getByRole("button", { name: /Recover \(1 note\)/ }));
    await waitFor(() => {
      expect(notes.getNotes()).toHaveLength(1);
      expect(notes.getNotes()[0].commitment).toBe("abcd1234");
      expect(notes.getDraftNotes()).toHaveLength(0);
    });
  });

  it("shows network mismatch banner and disables the deposit button", async () => {
    mockWalletState.networkMismatch = true;
    const { default: DepositPage } = await import("./page");
    render(<DepositPage />);

    expect(screen.getByRole("alert").textContent).toContain("different network");
    const btn = screen.getByRole("button", { name: "Network mismatch" });
    expect(btn).toBeDisabled();
  });
});