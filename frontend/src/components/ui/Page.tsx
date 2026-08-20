"use client";

import { cn } from "@/lib/cn";
import { Card } from "./Card";
import { Button } from "./Button";
import { useWallet } from "@/components/WalletProvider";

/**
 * Centered page container. `width` matches the two layouts in the app: the
 * narrow flow pages (deposit/withdraw/compliance/history) and the wide
 * marketing/home layout.
 */
export function PageShell({
  width = "narrow",
  className,
  children,
}: {
  width?: "narrow" | "wide";
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto px-4 py-10 sm:px-6 sm:py-16",
        width === "narrow" ? "max-w-2xl" : "max-w-5xl",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Page title + optional supporting paragraph. */
export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: React.ReactNode;
}) {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      {description && (
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {description}
        </p>
      )}
    </div>
  );
}

/**
 * The "connect your wallet" empty state shown by every gated page. Renders the
 * page title plus a centered prompt card with the connect action inline, so
 * the user never has to hunt for the button in the header.
 */
export function ConnectGate({
  title,
  prompt,
}: {
  title: string;
  prompt: string;
}) {
  const { connect, isConnecting } = useWallet();
  return (
    <PageShell>
      <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      <Card className="mt-6 p-8 text-center">
        <p className="text-ink-muted">{prompt}</p>
        <Button
          size="lg"
          className="mt-6"
          onClick={connect}
          disabled={isConnecting}
        >
          {isConnecting ? "Connecting..." : "Connect Wallet"}
        </Button>
      </Card>
    </PageShell>
  );
}
