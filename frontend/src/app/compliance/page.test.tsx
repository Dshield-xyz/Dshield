// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock WalletProvider — PageShell imports useWallet from it
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

// Mock all lib modules that compliance page imports
vi.mock("@/lib/notes", () => ({
  getNotes: () => [],
  saveNoteIfNew: vi.fn(),
  serializeNotes: () => "",
  type: {} as any,
}));
vi.mock("@/lib/errors", () => ({
  friendlyError: (e: unknown) => String(e),
}));
vi.mock("@/lib/sync", () => ({
  syncSpentNotes: () => Promise.resolve(0),
}));
vi.mock("@/lib/report", () => ({
  buildComplianceReport: vi.fn(),
  formatReportText: () => "",
  type: {} as any,
}));
vi.mock("@/lib/explorer", () => ({
  explorerTxUrl: () => "",
  explorerContractUrl: () => "",
}));
vi.mock("@/lib/format", () => ({
  truncateMiddle: (s: string, a: number, b: number) => s.slice(0, a) + "…" + s.slice(-b),
}));
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
vi.mock("fflate", () => ({
  zipSync: () => new Uint8Array(0),
  strToU8: (s: string) => new TextEncoder().encode(s),
}));

describe("CompliancePage", () => {
  it("renders page title and description", async () => {
    const { default: CompliancePage } = await import("./page");
    render(<CompliancePage />);
    expect(screen.getByText("Compliance")).toBeInTheDocument();
    expect(
      screen.getByText(/Create verifiable reports about your shielded funds/),
    ).toBeInTheDocument();
  });

  it("shows empty state when no notes exist", async () => {
    const { default: CompliancePage } = await import("./page");
    render(<CompliancePage />);
    expect(
      screen.getByText(/No notes on this device yet/),
    ).toBeInTheDocument();
  });

  it("renders mode toggle buttons", async () => {
    const { default: CompliancePage } = await import("./page");
    render(<CompliancePage />);
    expect(screen.getAllByText("Generate Reports").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Verify Reports").length).toBeGreaterThan(0);
  });
});