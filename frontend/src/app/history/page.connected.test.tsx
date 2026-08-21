// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock WalletProvider for connected state
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: "GABC123456789012345678901234567890123456789012345",
    signTransaction: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnecting: false,
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/notes", () => ({
  getNotes: () => [
    { commitment: "0xabc", spent: false, createdAt: Date.now(), amount: "100", poolId: "pool1" },
    { commitment: "0xdef", spent: true, createdAt: Date.now() - 1000, amount: "200", poolId: "pool1" },
  ],
  serializeNotes: () => "",
}));
vi.mock("@/lib/kyc", () => ({
  getKyc: () => ({ registeredOnChain: true, createdAt: Date.now(), hash: "0xkyc" }),
}));
vi.mock("@/lib/report", () => ({
  formatActivityCsv: () => "csv",
  formatActivityJson: () => "[]",
}));
vi.mock("@/lib/format", () => ({ formatStroopsOrDash: (v: string) => v }));
vi.mock("@/lib/cn", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

describe("HistoryPage — connected", () => {
  it("renders stats when connected (not ConnectGate)", async () => {
    const { default: HistoryPage } = await import("./page");
    render(<HistoryPage />);
    // "Deposits" appears in both stats and filter → use getAllByText
    expect(screen.getAllByText("Deposits").length).toBeGreaterThan(0);
    expect(screen.queryByText("Connect Wallet")).not.toBeInTheDocument();
  });

  it("renders filter buttons", async () => {
    const { default: HistoryPage } = await import("./page");
    render(<HistoryPage />);
    expect(screen.getByText("All")).toBeInTheDocument();
    expect(screen.getAllByText("Deposits").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Withdrawals").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Compliance").length).toBeGreaterThan(0);
  });
});