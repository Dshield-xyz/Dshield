"use client";

import { useState, useEffect, useReducer } from "react";
import { zipSync, strToU8 } from "fflate";
import {
  getNotes,
  saveNoteIfNew,
  serializeNotes,
  type ShieldedNote,
} from "@/lib/notes";
import { friendlyError } from "@/lib/errors";
import { syncSpentNotes } from "@/lib/sync";
import {
  buildComplianceReport,
  formatReportText,
  type ComplianceReport,
} from "@/lib/report";
import { explorerTxUrl, explorerContractUrl } from "@/lib/explorer";
import { truncateMiddle } from "@/lib/format";
import { PageShell, PageHeader } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { SelectButton } from "@/components/ui/SelectButton";
import { useToast } from "@/components/ui/Toast";
import { NoteImport } from "@/components/ui/NoteImport";

type Mode = "generate" | "verify";

type ReportStatus = "pending" | "loading" | "done" | "error";

interface ReportResult {
  note: ShieldedNote;
  status: ReportStatus;
  report?: ComplianceReport;
  error?: string;
}

export default function CompliancePage() {
  const [mode, setMode] = useState<Mode>("generate");
  const [selectedCommitments, setSelectedCommitments] = useState<Set<string>>(
    new Set(),
  );
  const [results, setResults] = useState<ReportResult[]>([]);
  const [expandedCommitment, setExpandedCommitment] = useState<string | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();
  const [, refresh] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    syncSpentNotes().then((n) => {
      if (n > 0) refresh();
    });
  }, []);

  const allNotes = typeof window !== "undefined" ? getNotes() : [];

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

  function switchMode(m: Mode) {
    setMode(m);
    setResults([]);
    setSelectedCommitments(new Set());
    setExpandedCommitment(null);
  }

  function toggleNote(note: ShieldedNote) {
    if (isLoading) return;
    setSelectedCommitments((prev) => {
      const next = new Set(prev);
      if (next.has(note.commitment)) {
        next.delete(note.commitment);
      } else {
        next.add(note.commitment);
      }
      return next;
    });
  }

  const selectedNotes =
    mode === "generate"
      ? allNotes.filter((n) => selectedCommitments.has(n.commitment))
      : Array.from(selectedCommitments)
          .map((c) => allNotes.find((n) => n.commitment === c))
          .filter((n): n is ShieldedNote => !!n);

  async function handleRun() {
    if (selectedNotes.length === 0) return;
    setIsLoading(true);
    setExpandedCommitment(null);

    // Seed all results as loading upfront so the accordion renders immediately.
    const initial: ReportResult[] = selectedNotes.map((note) => ({
      note,
      status: "loading",
    }));
    setResults(initial);

    // Run all reports in parallel; update each slot as it settles.
    await Promise.allSettled(
      selectedNotes.map(async (note, i) => {
        try {
          const report = await buildComplianceReport(note);
          setResults((prev) => {
            const next = [...prev];
            next[i] = { note, status: "done", report };
            return next;
          });
          if (!report.depositConfirmed) {
            toast(
              `Note ${truncateMiddle(note.commitment, 6, 4)}: deposit not found on-chain.`,
              "info",
            );
          }
        } catch (err) {
          setResults((prev) => {
            const next = [...prev];
            next[i] = { note, status: "error", error: friendlyError(err) };
            return next;
          });
        }
      }),
    );

    setIsLoading(false);
  }

  function downloadOneTxt(report: ComplianceReport) {
    const blob = new Blob([formatReportText(report)], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dshield-compliance-${report.commitment.replace(/^0x/, "").slice(0, 12)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadAllZip() {
    const done = results.filter((r) => r.status === "done" && r.report);
    if (done.length === 0) return;

    const files: Record<string, Uint8Array> = {};
    for (const r of done) {
      const name = `dshield-compliance-${r.report!.commitment.replace(/^0x/, "").slice(0, 12)}.txt`;
      files[name] = strToU8(formatReportText(r.report!));
    }

    const zipped = zipSync(files);
    const blob = new Blob([zipped], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dshield-compliance-${Date.now()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadOnePdf(report: ComplianceReport) {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(reportHtml(report));
    w.document.close();
    w.focus();
    w.print();
  }

  const doneCount = results.filter((r) => r.status === "done").length;
  const hasResults = results.length > 0;

  return (
    <PageShell>
      <PageHeader
        title="Compliance"
        description="Create verifiable reports about your shielded funds for auditors or regulators — proving exactly what you choose to, and nothing more. Anyone you share a note with can verify it here too."
      />

      {/* Mode toggle */}
      <fieldset className="mt-8 grid grid-cols-2 gap-2">
        <legend className="sr-only">Report Mode</legend>
        <SelectButton
          selected={mode === "generate"}
          onClick={() => switchMode("generate")}
          disabled={isLoading}
          className="text-center font-medium"
          aria-label="Generate Reports mode"
        >
          Generate Reports
        </SelectButton>
        <SelectButton
          selected={mode === "verify"}
          onClick={() => switchMode("verify")}
          disabled={isLoading}
          className="text-center font-medium"
          aria-label="Verify Reports mode"
        >
          Verify Reports
        </SelectButton>
      </fieldset>

      <div className="mt-6 space-y-6">
        {/* Note selection */}
        {mode === "generate" && (
          <Card>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-400">
                Your Notes ({allNotes.length})
              </h2>
              <div className="flex items-center gap-3">
                {allNotes.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={downloadAllNotes}
                      className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                    >
                      Download all
                    </button>
                    <button
                      disabled={isLoading}
                      onClick={() =>
                        selectedCommitments.size === allNotes.length
                          ? setSelectedCommitments(new Set())
                          : setSelectedCommitments(
                              new Set(allNotes.map((n) => n.commitment)),
                            )
                      }
                      className="text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:pointer-events-none"
                    >
                      {selectedCommitments.size === allNotes.length
                        ? "Deselect all"
                        : "Select all"}
                    </button>
                  </>
                )}
              </div>
            </div>

            {allNotes.length === 0 ? (
              <p className="mt-3 text-sm text-zinc-500">
                No notes on this device yet. Make a deposit, or import a note
                below.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                {allNotes.map((note) => {
                  const selected = selectedCommitments.has(note.commitment);
                  return (
                    <button
                      key={note.commitment}
                      onClick={() => toggleNote(note)}
                      disabled={isLoading}
                      aria-pressed={selected}
                      aria-label={`${selected ? "Deselect" : "Select"} note ${truncateMiddle(note.commitment, 16, 16)}, status: ${note.spent ? "withdrawn" : "in pool"}`}
                      className={`focus-ring w-full rounded-xl border px-4 py-3 text-left transition-all disabled:pointer-events-none ${
                        selected
                          ? "border-brand-500/50 bg-brand-950/30"
                          : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className={`h-4 w-4 shrink-0 rounded border transition-colors ${selected ? "border-brand-500 bg-brand-500" : "border-zinc-600"}`}
                        >
                          {selected && (
                            <svg
                              viewBox="0 0 16 16"
                              fill="white"
                              className="h-4 w-4"
                            >
                              <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                            </svg>
                          )}
                        </div>
                        <span className="font-mono text-xs text-zinc-300">
                          {truncateMiddle(note.commitment, 16, 16)}
                        </span>
                        <Badge
                          tone={note.spent ? "blue" : "green"}
                          className="ml-auto shrink-0"
                        >
                          {note.spent ? "Withdrawn" : "In pool"}
                        </Badge>
                      </div>
                      <div className="ml-6 mt-1 text-xs text-zinc-500">
                        Leaf #{note.leafIndex}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        {/* NoteImport for both modes */}
        <NoteImport
          disabled={isLoading}
          title={
            mode === "generate"
              ? "Or import a Shielded Note"
              : "Paste notes to verify"
          }
          onImport={(notes) => {
            const newSel = new Set(selectedCommitments);
            for (const note of notes) {
              saveNoteIfNew(note);
              newSel.add(note.commitment);
            }
            setSelectedCommitments(newSel);
            refresh();
          }}
        />

        {/* Run button */}
        {selectedNotes.length > 0 && !hasResults && (
          <Button fullWidth size="lg" onClick={handleRun} disabled={isLoading}>
            {isLoading
              ? "Reading chain…"
              : mode === "generate"
                ? selectedNotes.length === 1
                  ? "Generate Report"
                  : `Generate ${selectedNotes.length} Reports`
                : selectedNotes.length === 1
                  ? "Verify Report"
                  : `Verify ${selectedNotes.length} Reports`}
          </Button>
        )}

        {/* Results accordion */}
        {hasResults && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-zinc-500">
                {doneCount} of {results.length} complete
              </p>
              {doneCount > 1 && (
                <button
                  onClick={downloadAllZip}
                  className="flex items-center gap-1.5 text-xs font-medium text-brand-400 transition-colors hover:text-brand-300"
                >
                  <svg
                    className="h-3.5 w-3.5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                    />
                  </svg>
                  Download all (.zip)
                </button>
              )}
            </div>

            {results.map((r) => {
              const isExpanded = expandedCommitment === r.note.commitment;
              return (
                <div
                  key={r.note.commitment}
                  className="aurora-border overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 backdrop-blur-sm"
                >
                  {/* Accordion header */}
                  <div className="relative z-10 flex items-center transition-colors hover:bg-zinc-800/40">
                    <button
                      onClick={() =>
                        setExpandedCommitment(
                          isExpanded ? null : r.note.commitment,
                        )
                      }
                      aria-expanded={isExpanded}
                      className="focus-ring flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-300">
                        {truncateMiddle(r.note.commitment, 14, 12)}
                      </span>

                      <StatusBadge status={r.status} />

                      {/* Chevron */}
                      <svg
                        className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19 9l-7 7-7-7"
                        />
                      </svg>
                    </button>

                    {/* Per-note .txt download */}
                    {r.status === "done" && r.report && (
                      <button
                        type="button"
                        onClick={() => downloadOneTxt(r.report!)}
                        className="focus-ring mr-3 shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-700 hover:text-white"
                      >
                        .txt
                      </button>
                    )}
                  </div>

                  {/* Accordion body */}
                  {isExpanded && (
                    <div className="border-t border-zinc-800 px-4 py-4">
                      {r.status === "loading" && (
                        <p className="text-sm text-zinc-500">
                          Fetching from chain…
                        </p>
                      )}
                      {r.status === "error" && (
                        <p className="text-sm text-red-400">{r.error}</p>
                      )}
                      {r.status === "done" && r.report && (
                        <ReportBody
                          report={r.report}
                          onDownloadPdf={() => downloadOnePdf(r.report!)}
                          onDownloadTxt={() => downloadOneTxt(r.report!)}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Re-run / clear */}
            <div className="flex gap-2">
              <Button
                fullWidth
                variant="outline"
                size="sm"
                onClick={handleRun}
                disabled={isLoading}
                className="text-xs"
              >
                {isLoading ? "Running…" : "Re-run all"}
              </Button>
              <Button
                fullWidth
                variant="ghost"
                size="sm"
                onClick={() => {
                  setResults([]);
                  setExpandedCommitment(null);
                }}
                disabled={isLoading}
                className="text-xs text-zinc-500"
              >
                Clear results
              </Button>
            </div>
          </div>
        )}
      </div>
    </PageShell>
  );
}

function StatusBadge({ status }: { status: ReportStatus }) {
  if (status === "loading") return <Badge tone="zinc">Loading…</Badge>;
  if (status === "done") return <Badge tone="green">Complete</Badge>;
  if (status === "error")
    return (
      <Badge tone="zinc" className="bg-red-950/40 text-red-400">
        Error
      </Badge>
    );
  return <Badge tone="zinc">Pending</Badge>;
}

function ReportBody({
  report,
  onDownloadPdf,
  onDownloadTxt,
}: {
  report: ComplianceReport;
  onDownloadPdf: () => void;
  onDownloadTxt: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Badge tone={report.integrityOk ? "green" : "zinc"}>
          {report.integrityOk ? "Note valid" : "Note mismatch"}
        </Badge>
      </div>

      <dl className="space-y-3 text-sm">
        <ReportRow label="Network" value={report.network} />
        <ReportRow
          label="Deposit"
          value={
            report.depositConfirmed ? (
              <span className="text-green-400">
                Confirmed on-chain (leaf #{report.leafIndex})
              </span>
            ) : (
              <span className="text-yellow-400">Not found on-chain</span>
            )
          }
        />
        <ReportRow
          label="Status"
          value={
            report.withdrawn ? (
              <span className="text-blue-400">Withdrawn (nullifier spent)</span>
            ) : (
              <span className="text-zinc-300">In pool (unspent)</span>
            )
          }
        />
        <ReportRow
          label="Commitment"
          value={
            <span className="break-all font-mono text-xs text-zinc-300">
              {report.commitment}
            </span>
          }
        />
        <ReportRow
          label="Nullifier hash"
          value={
            <span className="break-all font-mono text-xs text-zinc-300">
              {report.nullifierHash}
            </span>
          }
        />
        <ReportRow
          label="Pool contract"
          value={
            <ExplorerLink
              url={explorerContractUrl(report.poolId)}
              text={report.poolId}
              mono
            />
          }
        />
        {report.depositTx && (
          <ReportRow
            label="Deposit tx"
            value={
              <ExplorerLink
                url={explorerTxUrl(report.depositTx.hash)}
                text={report.depositTx.hash}
                sub={report.depositTx.at}
                mono
              />
            }
          />
        )}
        {report.withdrawTx && (
          <ReportRow
            label="Withdraw tx"
            value={
              <ExplorerLink
                url={explorerTxUrl(report.withdrawTx.hash)}
                text={report.withdrawTx.hash}
                sub={report.withdrawTx.at}
                mono
              />
            }
          />
        )}
      </dl>

      <div className="grid grid-cols-2 gap-2">
        <Button variant="primary" onClick={onDownloadPdf}>
          Download PDF
        </Button>
        <Button variant="outline" onClick={onDownloadTxt}>
          Download .txt
        </Button>
      </div>
    </div>
  );
}

function ReportRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-right sm:text-right">{value}</dd>
    </div>
  );
}

function ExplorerLink({
  url,
  text,
  sub,
  mono,
}: {
  url: string | null;
  text: string;
  sub?: string;
  mono?: boolean;
}) {
  const body = (
    <span className={mono ? "break-all font-mono text-xs" : "break-all"}>
      {text}
    </span>
  );
  return (
    <span className="inline-block">
      {url ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-400 hover:text-brand-300"
        >
          {body}
        </a>
      ) : (
        <span className="text-zinc-300">{body}</span>
      )}
      {sub && <span className="block text-xs text-zinc-600">{sub}</span>}
    </span>
  );
}

// Fields like poolId/commitment ultimately trace back to a pasted note
// string (see NoteImport), so they're not trustworthy enough to interpolate
// into HTML unescaped before document.write — escape everything.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function reportHtml(r: ComplianceReport): string {
  const row = (k: string, v: string) =>
    `<tr><td class="k">${escapeHtml(k)}</td><td class="v">${v}</td></tr>`;
  const link = (h: string) => {
    const u = explorerTxUrl(h);
    const safeHash = escapeHtml(h);
    return u ? `<a href="${escapeHtml(u)}">${safeHash}</a>` : safeHash;
  };
  const rows = [
    row("Generated", escapeHtml(new Date(r.generatedAt).toISOString())),
    row("Network", escapeHtml(r.network)),
    row(
      "Note integrity",
      r.integrityOk ? "OK — commitment matches" : "MISMATCH",
    ),
    row(
      "Deposit",
      r.depositConfirmed
        ? `Confirmed on-chain (leaf #${r.leafIndex})`
        : "Not found on-chain",
    ),
    row(
      "Status",
      r.withdrawn ? "Withdrawn (nullifier spent)" : "In pool (unspent)",
    ),
    row("Commitment", escapeHtml(r.commitment)),
    row("Nullifier hash", escapeHtml(r.nullifierHash)),
    row("Pool contract", escapeHtml(r.poolId)),
    r.depositTx ? row("Deposit tx", link(r.depositTx.hash)) : "",
    r.withdrawTx ? row("Withdraw tx", link(r.withdrawTx.hash)) : "",
  ].join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>DShield Compliance Report</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;color:#18181b}
  h1{font-size:20px;margin:0 0 4px}.sub{color:#71717a;font-size:13px;margin:0 0 24px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td{padding:8px 0;border-bottom:1px solid #e4e4e7;vertical-align:top}
  td.k{color:#71717a;width:160px}td.v{font-family:ui-monospace,monospace;word-break:break-all}
  .label{font-size:11px;color:#71717a;margin-bottom:6px}a{color:#2563eb}
</style></head><body>
<h1>DShield Compliance Report</h1>
<p class="sub">Verifiable against public on-chain data.</p>
<table>${rows}</table>
</body></html>`;
}
