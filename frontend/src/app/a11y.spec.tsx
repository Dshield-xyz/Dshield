// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { axe, toHaveNoViolations } from "jest-axe";

import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { StatusMessage } from "@/components/ui/StatusMessage";

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

describe("ui component accessibility", () => {
  it("Button has no axe violations", async () => {
    const { container } = render(<Button>Click me</Button>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Button (primary variant) has no axe violations", async () => {
    const { container } = render(<Button variant="primary">Submit</Button>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Button (outline variant) has no axe violations", async () => {
    const { container } = render(<Button variant="outline">Cancel</Button>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Badge has no axe violations", async () => {
    const { container } = render(<Badge>Active</Badge>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Badge (green tone) has no axe violations", async () => {
    const { container } = render(<Badge tone="green">Verified</Badge>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Card has no axe violations", async () => {
    const { container } = render(<Card>Card content</Card>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Card (brand border) has no axe violations", async () => {
    const { container } = render(<Card border="brand">Highlighted</Card>);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Input with label has no axe violations", async () => {
    const { container } = render(<Input label="Wallet address" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Input with hint has no axe violations", async () => {
    const { container } = render(
      <Input label="Amount" hint="Enter the amount to deposit" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Spinner has no axe violations", async () => {
    const { container } = render(<Spinner />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("StatusMessage (success) has no axe violations", async () => {
    const { container } = render(
      <StatusMessage message="Operation completed successfully" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("StatusMessage (error) has no axe violations", async () => {
    const { container } = render(
      <StatusMessage message="Error: transaction failed" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("StatusMessage (info) has no axe violations", async () => {
    const { container } = render(
      <StatusMessage message="Processing your request" />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});