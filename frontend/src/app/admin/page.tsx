"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { PageShell, PageHeader } from "@/components/ui/Page";
import { Card, CardLabel } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { truncateMiddle } from "@/lib/format";
import { explorerContractUrl } from "@/lib/explorer";
import { friendlyError } from "@/lib/errors";
import { submitTransaction, GOVERNANCE_CONTRACT_ID } from "@/lib/stellar";
import {
  listQueuedCalls,
  getTimelockDelaySeconds,
  getGovernanceAdmin,
  buildCancelCall,
  buildExecuteCall,
  type QueuedCall,
} from "@/lib/governance";

// Governance assigns ids sequentially starting at 0 but exposes no count, so
// this view scans a fixed window of the most recent ids. Comfortably covers
// a demo/small-team deployment without paging.
const SCAN_WINDOW = 50;

function formatDuration(diffSeconds: number): string {
  if (diffSeconds <= 0) return "ready";
  const mins = Math.floor(diffSeconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function StatusBadge({
  status,
  eta,
  nowSeconds,
}: {
  status: QueuedCall["status"];
  eta: number;
  nowSeconds: number;
}) {
  if (status === "Executed") return <Badge tone="blue">Executed</Badge>;
  if (status === "Cancelled") return <Badge tone="zinc">Cancelled</Badge>;
  const ready = eta <= nowSeconds;
  return <Badge tone={ready ? "green" : "zinc"}>{ready ? "Ready" : "Pending"}</Badge>;
}

export default function AdminPage() {
  const { address, signTransaction } = useWallet();
  const { toast } = useToast();
  const [calls, setCalls] = useState<QueuedCall[]>([]);
  const [delaySeconds, setDelaySeconds] = useState<number | null>(null);
  const [govAdmin, setGovAdmin] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<number | null>(null);
  // Wall-clock reference for "ready"/"executable in Xm" — read once per
  // tick via effect rather than calling Date.now() during render.
  const [nowSeconds, setNowSeconds] = useState(0);

  async function refresh() {
    setIsLoading(true);
    try {
      const [found, delay, admin] = await Promise.all([
        listQueuedCalls(SCAN_WINDOW),
        getTimelockDelaySeconds(),
        getGovernanceAdmin(),
      ]);
      setCalls(found);
      setDelaySeconds(delay);
      setGovAdmin(admin);
    } finally {
      setIsLoading(false);
    }
  }

  /* eslint-disable react-hooks/set-state-in-effect -- initial fetch/clock
   * tick must run on mount; there's no external subscription to attach to. */
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    setNowSeconds(Date.now() / 1000);
    const interval = setInterval(() => setNowSeconds(Date.now() / 1000), 30_000);
    return () => clearInterval(interval);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const isAdmin = !!address && !!govAdmin && address === govAdmin;

  async function handleCancel(id: number) {
    if (!address) return;
    setPendingAction(id);
    try {
      const tx = await buildCancelCall(id, address);
      const signed = await signTransaction(tx.toXDR());
      await submitTransaction(signed);
      toast(`Call #${id} cancelled.`, "success");
      await refresh();
    } catch (err) {
      toast(friendlyError(err), "error");
    } finally {
      setPendingAction(null);
    }
  }

  async function handleExecute(id: number) {
    if (!address) return;
    setPendingAction(id);
    try {
      const tx = await buildExecuteCall(id, address);
      const signed = await signTransaction(tx.toXDR());
      await submitTransaction(signed);
      toast(`Call #${id} executed.`, "success");
      await refresh();
    } catch (err) {
      toast(friendlyError(err), "error");
    } finally {
      setPendingAction(null);
    }
  }

  if (!GOVERNANCE_CONTRACT_ID) {
    return (
      <PageShell>
        <PageHeader
          title="Governance"
          description="Queued admin changes and their timelock status."
        />
        <Card className="mt-8">
          <p className="text-sm text-zinc-500">
            No governance contract configured (NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID
            is unset).
          </p>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Governance"
        description="Privileged changes to the pool and compliance contracts (verifier swaps, admin rotation, disclosure-VK rotation) are queued here and only take effect after a fixed delay — giving users a window to see a change coming before it's live."
      />

      <div className="mt-8 space-y-6">
        <Card padding="sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-zinc-500">Timelock delay: </span>
              <span className="font-medium text-white">
                {delaySeconds !== null ? formatDuration(delaySeconds) : "—"}
              </span>
            </div>
            <div>
              <span className="text-zinc-500">Governance admin: </span>
              {govAdmin ? (
                <span className="font-mono text-xs text-zinc-300">
                  {truncateMiddle(govAdmin, 6, 6)}
                </span>
              ) : (
                <span className="text-zinc-500">—</span>
              )}
            </div>
            <a
              href={explorerContractUrl(GOVERNANCE_CONTRACT_ID) ?? undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-auto text-xs text-brand-400 hover:text-brand-300"
            >
              View contract
            </a>
          </div>
        </Card>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <CardLabel>Queued Changes</CardLabel>
            <button
              onClick={refresh}
              disabled={isLoading}
              className="text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:pointer-events-none"
            >
              {isLoading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {calls.length === 0 ? (
            <Card>
              <p className="text-sm text-zinc-500">
                {isLoading ? "Loading…" : "No queued changes found."}
              </p>
            </Card>
          ) : (
            <div className="space-y-2">
              {calls.map((call) => {
                const ready = call.eta <= nowSeconds;
                const busy = pendingAction === call.id;
                return (
                  <Card key={call.id} padding="sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono text-xs text-zinc-500">
                        #{call.id}
                      </span>
                      <span className="font-medium text-white">{call.function}</span>
                      <span className="font-mono text-xs text-zinc-400">
                        {truncateMiddle(call.target, 6, 6)}
                      </span>
                      <StatusBadge status={call.status} eta={call.eta} nowSeconds={nowSeconds} />
                      <span className="ml-auto text-xs text-zinc-500">
                        {call.status === "Pending"
                          ? ready
                            ? "Ready to execute"
                            : `Executable in ${formatDuration(call.eta - nowSeconds)}`
                          : new Date(call.eta * 1000).toLocaleString()}
                      </span>
                    </div>

                    {call.status === "Pending" && address && (
                      <div className="mt-3 flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!ready || busy}
                          onClick={() => handleExecute(call.id)}
                        >
                          {busy ? "…" : "Execute"}
                        </Button>
                        {isAdmin && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            className="text-red-400"
                            onClick={() => handleCancel(call.id)}
                          >
                            {busy ? "…" : "Cancel"}
                          </Button>
                        )}
                      </div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <Card padding="sm" border="brand">
          <p className="text-xs text-zinc-400">
            Queuing a new change (verifier rotation, admin rotation, disclosure-VK
            rotation) is done via the Stellar CLI —
            see{" "}
            <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono">
              scripts/rotate-timelocked.sh
            </code>
            . This page tracks and executes/cancels calls already queued.
          </p>
        </Card>
      </div>
    </PageShell>
  );
}
