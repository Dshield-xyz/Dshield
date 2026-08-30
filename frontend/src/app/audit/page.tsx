"use client";

import { useState } from "react";
import {
  parseViewDisclosureBundle,
  verifyViewDisclosureBundle,
  type ViewDisclosureBundle,
  type ViewDisclosureVerification,
} from "@/lib/viewDisclosure";
import { friendlyError } from "@/lib/errors";
import { formatAmount, truncateMiddle } from "@/lib/format";
import { explorerContractUrl } from "@/lib/explorer";
import { PageShell, PageHeader } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";

/**
 * Read-only auditor page: no wallet connection, no secrets required. A
 * verifier pastes the proof bundle a note holder shared with them and gets a
 * pass/fail answer plus the disclosed amount — nothing else is required
 * because verification only needs public data (the proof, the circuit's own
 * math, and the pool's on-chain state).
 */
export default function AuditPage() {
  const [raw, setRaw] = useState("");
  const [bundle, setBundle] = useState<ViewDisclosureBundle | null>(null);
  const [result, setResult] = useState<ViewDisclosureVerification | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => setRaw(String(reader.result ?? ""));
    reader.readAsText(file);
  }

  async function handleVerify() {
    setError(null);
    setResult(null);
    const parsed = parseViewDisclosureBundle(raw.trim());
    if (!parsed) {
      setError("That doesn't look like a DShield viewing-proof bundle.");
      return;
    }
    setBundle(parsed);
    setIsLoading(true);
    try {
      const verification = await verifyViewDisclosureBundle(parsed);
      setResult(verification);
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setIsLoading(false);
    }
  }

  function reset() {
    setRaw("");
    setBundle(null);
    setResult(null);
    setError(null);
  }

  return (
    <PageShell>
      <PageHeader
        title="Audit"
        description="Verify a DShield viewing-disclosure proof. No wallet or account needed — this checks the proof against its circuit and the note's pool entirely from public data."
      />

      <div className="mt-8 space-y-6">
        {!result && (
          <Card>
            <label className="text-sm font-medium text-zinc-400" htmlFor="bundle-input">
              Proof bundle
            </label>
            <textarea
              id="bundle-input"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              disabled={isLoading}
              rows={8}
              placeholder="Paste the .json proof bundle you were sent…"
              className="focus-ring mt-2 w-full resize-none rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 font-mono text-xs text-zinc-300 placeholder:text-zinc-600"
            />
            <div className="mt-3 flex items-center justify-between">
              <label className="cursor-pointer text-xs text-brand-400 hover:text-brand-300">
                Or upload a file
                <input
                  type="file"
                  accept="application/json"
                  className="hidden"
                  disabled={isLoading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
              </label>
            </div>
            <Button
              fullWidth
              size="lg"
              className="mt-4"
              onClick={handleVerify}
              disabled={isLoading || raw.trim().length === 0}
            >
              {isLoading ? "Verifying…" : "Verify"}
            </Button>
            {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          </Card>
        )}

        {result && bundle && (
          <Card>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-zinc-400">Result</h2>
              <Badge tone={result.proofValid ? "green" : "zinc"}>
                {result.proofValid ? "Proof valid" : "Proof invalid"}
              </Badge>
            </div>

            <dl className="mt-4 space-y-3 text-sm">
              <Row label="Disclosed amount" value={formatAmount(bundle.amount)} />
              <Row
                label="Viewing key"
                value={
                  <span className="break-all font-mono text-xs text-zinc-300">
                    {bundle.viewKey}
                  </span>
                }
              />
              <Row
                label="Pool contract"
                value={
                  explorerContractUrl(bundle.poolId) ? (
                    <a
                      href={explorerContractUrl(bundle.poolId)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all font-mono text-xs text-brand-400 hover:text-brand-300"
                    >
                      {truncateMiddle(bundle.poolId, 10, 8)}
                    </a>
                  ) : (
                    <span className="break-all font-mono text-xs text-zinc-300">
                      {truncateMiddle(bundle.poolId, 10, 8)}
                    </span>
                  )
                }
              />
              <Row
                label="Merkle root known to pool"
                value={
                  result.rootKnown === null ? (
                    <span className="text-zinc-500">Couldn&apos;t check</span>
                  ) : result.rootKnown ? (
                    <span className="text-green-400">Yes</span>
                  ) : (
                    <span className="text-yellow-400">No — not a state this pool reached</span>
                  )
                }
              />
            </dl>

            <p className="mt-4 text-xs text-zinc-500">
              {result.proofValid
                ? "This proof cryptographically demonstrates a note worth the amount above exists in the pool above, without revealing which note or who holds it can spend it."
                : "This proof did not verify — it may be corrupted, tampered with, or generated for a different circuit version."}
            </p>

            <Button fullWidth variant="outline" className="mt-4" onClick={reset}>
              Verify another
            </Button>
          </Card>
        )}
      </div>
    </PageShell>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-4">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd className="min-w-0 text-right sm:text-right">{value}</dd>
    </div>
  );
}
