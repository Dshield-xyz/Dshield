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

vi.mock("@/lib/notes", () => ({
  getNotes: () => [],
  serializeNotes: () => "",
}));
vi.mock("@/lib/kyc", () => ({ getKyc: () => null }));
vi.mock("@/lib/report", () => ({
  formatActivityCsv: () => "",
  formatActivityJson: () => "[]",
}));
vi.mock("@/lib/format", () => ({ formatStroopsOrDash: (v: string) => v }));
vi.mock("@/lib/cn", () => ({ cn: (...args: unknown[]) => args.filter(Boolean).join(" ") }));

describe("HistoryPage — disconnected", () => {
  it("renders ConnectGate when wallet is not connected", async () => {
    const { default: HistoryPage } = await import("./page");
    render(<HistoryPage />);
    expect(screen.getByText("History")).toBeInTheDocument();
    expect(screen.getByText("Connect Wallet")).toBeInTheDocument();
    expect(screen.getByText(/Connect your wallet to see your shielded activity/)).toBeInTheDocument();
  });
});