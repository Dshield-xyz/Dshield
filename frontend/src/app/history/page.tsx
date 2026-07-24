"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/components/WalletProvider";
import { Button, buttonVariants } from "@/components/ui/Button";
import { getNotes, serializeNotes } from "@/lib/notes";
import { getKyc } from "@/lib/kyc";
import { formatStroopsOrDash } from "@/lib/format";
import { PageShell, PageHeader, ConnectGate } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";

/** How many activity rows to reveal per "page" as the user scrolls. */
const PAGE_SIZE = 5;

type ActivityItem = {
  type: "deposit" | "withdrawal" | "compliance";
  timestamp: number;
  commitment: string;
  amount: string;
  poolId?: string;
};

function buildActivity(): ActivityItem[] {
  if (typeof window === "undefined") return [];

  const notes = getNotes();
  const kyc = getKyc();
  const items: ActivityItem[] = [];

  for (const note of notes) {
    items.push({
      type: "deposit",
      timestamp: note.createdAt,
      commitment: note.commitment,
      amount: note.amount,
      poolId: note.poolId,
    });

    if (note.spent) {
      items.push({
        type: "withdrawal",
        timestamp: note.createdAt + 1,
        commitment: note.commitment,
        amount: note.amount,
        poolId: note.poolId,
      });
    }
  }

  if (kyc?.registeredOnChain) {
    items.push({
      type: "compliance",
      timestamp: kyc.createdAt,
      commitment: kyc.hash,
      amount: "0",
    });
  }

  items.sort((a, b) => b.timestamp - a.timestamp);
  return items;
}

const TYPE_META: Record<
  ActivityItem["type"],
  { tone: BadgeProps["tone"]; label: string }
> = {
  deposit: { tone: "green", label: "Deposit" },
  withdrawal: { tone: "blue", label: "Withdrawal" },
  compliance: { tone: "purple", label: "KYC Registered" },
};

type FilterType = "all" | "deposit" | "withdrawal" | "compliance";

export default function HistoryPage() {
  const { address } = useWallet();
  const [filter, setFilter] = useState<FilterType>("all");
  const [activity] = useState(() => buildActivity());
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const allNotes = typeof window !== "undefined" ? getNotes() : [];

  const filtered =
    filter === "all" ? activity : activity.filter((a) => a.type === filter);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = visibleCount < filtered.length;

  function changeFilter(next: FilterType) {
    setFilter(next);
    setVisibleCount(PAGE_SIZE); // restart pagination for the new filter
  }

  function downloadAllNotes() {
    if (allNotes.length === 0) return;
    const blob = new Blob([serializeNotes(allNotes)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dshield-notes-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Reveal the next batch when the sentinel near the end of the list scrolls
  // into view. A short delay keeps the spinner perceptible so it reads as
  // loading rather than a flash.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || loadingRef.current) return;
        loadingRef.current = true;
        setLoadingMore(true);
        window.setTimeout(() => {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, filtered.length));
          setLoadingMore(false);
          loadingRef.current = false;
        }, 350);
      },
      // Trigger before the user hits the very bottom of the list.
      { rootMargin: "240px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, filtered.length]);

  const stats = {
    deposits: activity.filter((a) => a.type === "deposit").length,
    withdrawals: activity.filter((a) => a.type === "withdrawal").length,
    compliance: activity.filter((a) => a.type === "compliance").length,
  };

  if (!address) {
    return (
      <ConnectGate
        title="History"
        prompt="Connect your wallet to see your shielded activity."
      />
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="History"
        description="Your deposits, withdrawals, and compliance activity. This record lives only on this device — it's never published anywhere."
      />

      {allNotes.length > 0 && (
        <div className="mt-6 flex justify-end">
          <Button variant="outline" size="sm" onClick={downloadAllNotes}>
            Download all notes (.txt)
          </Button>
        </div>
      )}

      {/* Stats */}
      <div className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card padding="sm" className="text-center">
          <p className="text-2xl font-bold text-green-400">{stats.deposits}</p>
          <p className="mt-1 text-xs text-zinc-500">Deposits</p>
        </Card>
        <Card padding="sm" className="text-center">
          <p className="text-2xl font-bold text-blue-400">
            {stats.withdrawals}
          </p>
          <p className="mt-1 text-xs text-zinc-500">Withdrawals</p>
        </Card>
        <Card padding="sm" className="text-center">
          <p className="text-2xl font-bold text-purple-400">
            {stats.compliance}
          </p>
          <p className="mt-1 text-xs text-zinc-500">Compliance</p>
        </Card>
      </div>

      {/* Filters */}
      <div className="mt-6 flex gap-2">
        {(
          [
            { key: "all", label: "All" },
            { key: "deposit", label: "Deposits" },
            { key: "withdrawal", label: "Withdrawals" },
            { key: "compliance", label: "Compliance" },
          ] as const
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => changeFilter(key)}
            aria-pressed={filter === key}
            className={cn(
              "focus-ring rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
              filter === key
                ? "bg-zinc-800 text-white"
                : "text-zinc-500 hover:bg-zinc-800/50 hover:text-white",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Activity list */}
      <div className="mt-6 space-y-2">
        {filtered.length === 0 ? (
          <Card className="p-8 text-center">
            <p className="text-sm text-zinc-500">
              {activity.length === 0
                ? "No activity yet — your shielded history will appear here."
                : "Nothing matches this filter."}
            </p>
            {activity.length === 0 && (
              <Link
                href="/deposit"
                className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4" })}
              >
                Make your first deposit
              </Link>
            )}
          </Card>
        ) : (
          <>
            {visible.map((item, i) => (
              <Card
                key={`${item.commitment}-${item.type}-${i}`}
                interactive
                padding="sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={TYPE_META[item.type].tone}>
                        {TYPE_META[item.type].label}
                      </Badge>
                      {item.type !== "compliance" && (
                        <span className="text-sm font-semibold text-white">
                          {formatStroopsOrDash(item.amount)}
                        </span>
                      )}
                    </div>
                    <p className="mt-2 truncate font-mono text-xs text-zinc-600">
                      {item.commitment}
                    </p>
                  </div>
                  <span className="flex-shrink-0 text-xs text-zinc-600">
                    {new Date(item.timestamp).toLocaleDateString()}
                  </span>
                </div>
              </Card>
            ))}

            {/* Infinite-scroll sentinel — entering view loads the next batch. */}
            {hasMore && (
              <div
                ref={sentinelRef}
                className="flex items-center justify-center gap-2 py-4 text-xs text-zinc-500"
              >
                <Spinner />
                {loadingMore ? "Loading more…" : "Scroll to load more"}
              </div>
            )}

            {!hasMore && filtered.length > PAGE_SIZE && (
              <p className="py-4 text-center text-xs text-zinc-600">
                That&apos;s everything — {filtered.length} item
                {filtered.length === 1 ? "" : "s"}.
              </p>
            )}
          </>
        )}
      </div>
    </PageShell>
  );
}
