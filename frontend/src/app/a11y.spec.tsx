// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";

expect.extend(toHaveNoViolations);

// Every wallet-gated page renders a lightweight <ConnectGate> when no
// wallet is connected — this is the state every user sees first, and it
// lets us exercise real page markup without mocking the Stellar SDK,
// note-storage, or transaction-building logic those pages also import.
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => ({
    address: null,
    signTransaction: vi.fn(),
  }),
  WalletProvider: ({ children }: { children: React.ReactNode }) => children,
}));

describe("accessibility (axe-core regression guard)", () => {
  it("deposit page has no axe violations", async () => {
    const { default: DepositPage } = await import("./deposit/page");
    const { container } = render(<DepositPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("withdraw page has no axe violations", async () => {
    const { default: WithdrawPage } = await import("./withdraw/page");
    const { container } = render(<WithdrawPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("history page has no axe violations", async () => {
    const { default: HistoryPage } = await import("./history/page");
    const { container } = render(<HistoryPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("compliance page has no axe violations", async () => {
    const { default: CompliancePage } = await import("./compliance/page");
    const { container } = render(<CompliancePage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});