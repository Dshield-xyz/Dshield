// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Mock WalletProvider so useWalletFlowGuard doesn't try to import
// @stellar/freighter-api (a CJS module that vitest/ESM can't handle).
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: null,
    network: "Standalone Network ; February 2017",
    signTransaction: vi.fn(),
    isConnecting: false,
    connectionVersion: 0,
    lastDisconnectAt: null,
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock the flow guard to a no-op — the recovery banner is driven by the
// draft-loading effect, not the guard's interrupted flag.
vi.mock("@/components/useWalletFlowGuard", () => ({
  useWalletFlowGuard: () => ({
    interrupted: false,
    reset: () => {},
  }),
}));

describe("compliance page — wallet disconnect resilience", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders the compliance page", async () => {
    const { default: CompliancePage } = await import("./page");
    render(<CompliancePage />);
    expect(screen.getByText(/Compliance/i)).toBeTruthy();
  });

  it("shows a recovery banner when a draft was persisted (interrupted session)", async () => {
    const draft = {
      selectedCommitments: ["00" + "bb".repeat(31)],
      mode: "generate",
    };
    localStorage.setItem("dshield_compliance_draft", JSON.stringify(draft));

    const { default: CompliancePage } = await import("./page");
    render(<CompliancePage />);

    expect(screen.getByText("Previous selection recovered")).toBeTruthy();
  });

  it("clears the draft when the user dismisses the recovered selection", async () => {
    const draft = {
      selectedCommitments: ["00" + "bb".repeat(31)],
      mode: "generate",
    };
    localStorage.setItem("dshield_compliance_draft", JSON.stringify(draft));

    const { default: CompliancePage } = await import("./page");
    const { unmount } = render(<CompliancePage />);
    expect(screen.getByText("Previous selection recovered")).toBeTruthy();

    const dismiss = screen.getByText("Dismiss selection");
    dismiss.click();

    await waitFor(() => {
      expect(screen.queryByText("Previous selection recovered")).toBeNull();
    });
    expect(localStorage.getItem("dshield_compliance_draft")).toBeNull();
    unmount();
  });
});