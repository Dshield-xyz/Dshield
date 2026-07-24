"use client";

import { useState, useEffect, useReducer } from "react";
import { useWallet } from "@/components/WalletProvider";
import {
  buildContractCall,
  submitTransaction,
  queryContract,
  ensureUsdcTrustline,
  hasUsdcTrustline,
  getUsdcSacId,
  relayWithdrawal,
  POOL_CONTRACT_ID,
} from "@/lib/stellar";
import {
  getActiveNotes,
  getNotes,
  markNoteSpent,
  parseNote,
  saveNoteIfNew,
  serializeNotes,
  type ShieldedNote,
} from "@/lib/notes";
import { getAllCommitments, clearDeposits } from "@/lib/deposits";
import {
  computeNullifierHash,
  computeRecipientHash,
  buildMerkleTree,
} from "@/lib/poseidon2";
import {
  syncDepositsFromChain,
  fetchCommitmentsFromChain,
} from "@/lib/indexer";
import { proveWithdrawal, type ProofStage } from "@/lib/prover";
import { friendlyError } from "@/lib/errors";
import { syncSpentNotes } from "@/lib/sync";
import { truncateMiddle } from "@/lib/format";
import Link from "next/link";
import { PageShell, PageHeader, ConnectGate } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Button, buttonVariants } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ProgressSteps } from "@/components/ui/ProgressSteps";
import { NoteImport } from "@/components/ui/NoteImport";
import { useToast } from "@/components/ui/Toast";
import * as StellarSdk from "@stellar/stellar-sdk";

type WithdrawStep =
  | "idle"
  | "checking_nullifier"
  | "building_tree"
  | "generating_proof"
  | "signing"
  | "submitting"
  | "done";

const STEP_LABELS: Record<WithdrawStep, string> = {
  idle: "",
  checking_nullifier: "Checking note status…",
  building_tree: "Syncing with the pool…",
  generating_proof: "Generating your private proof — this can take about a minute…",
  signing: "Waiting for your signature…",
  submitting: "Sending to the network…",
  done: "Done!",
};

// Finer-grained status shown during "generating_proof", which is by far the
// longest step. Proving runs in a Web Worker (see lib/prover.ts) so the UI
// stays responsive while these are displayed.
const PROOF_STAGE_LABELS: Record<ProofStage, string> = {
  executing: "Executing the circuit — this can take about a minute…",
  proving: "Creating the cryptographic proof…",
};

const PROGRESS_STEPS = [
  "checking_nullifier",
  "building_tree",
  "generating_proof",
  "signing",
  "submitting",
] as const;

interface NoteResult {
  note: ShieldedNote;
  status: "pending" | "processing" | "done" | "error";
  txHash?: string;
  error?: string;
}

export default function WithdrawPage() {
  const { address, signTransaction } = useWallet();
  const { toast } = useToast();
  const [step, setStep] = useState<WithdrawStep>("idle");
  const [proofStage, setProofStage] = useState<ProofStage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedCommitments, setSelectedCommitments] = useState<Set<string>>(new Set());
  const [recipient, setRecipient] = useState("");
  const [batchResults, setBatchResults] = useState<NoteResult[] | null>(null);
  const [, refresh] = useReducer((x: number) => x + 1, 0);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#note=")) return;
    const note = parseNote(decodeURIComponent(hash.slice("#note=".length)));
    if (!note) return;
    saveNoteIfNew(note);
    setSelectedCommitments(new Set([note.commitment]));
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    syncSpentNotes().then((n) => {
      if (n > 0) refresh();
    });
  }, []);

  const activeNotes = typeof window !== "undefined" ? getActiveNotes() : [];
  const allNotes = typeof window !== "undefined" ? getNotes() : [];

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

  const selectedNotes = activeNotes.filter((n) =>
    selectedCommitments.has(n.commitment),
  );

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

  async function withdrawNote(
    note: ShieldedNote,
    recipientAddr: string,
    onStep: (s: WithdrawStep) => void,
  ): Promise<string> {
    const poolId = note.poolId || POOL_CONTRACT_ID;
    if (!poolId) throw new Error("Pool address missing — refresh and try again.");

    onStep("checking_nullifier");
    const nullifierHash = await computeNullifierHash(note.nullifier);
    const nullifierHashClean = nullifierHash.replace(/^0x/, "");
    const isUsed = await queryContract(poolId, "is_nullifier_used", [
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(nullifierHashClean, "hex")),
    ]);
    if (isUsed && StellarSdk.scValToNative(isUsed) === true) {
      throw new Error("This note has already been withdrawn.");
    }

    onStep("building_tree");
    const rootVal = await queryContract(poolId, "get_root");
    if (!rootVal) throw new Error("No deposits in this pool yet.");
    const rootBytes = StellarSdk.scValToNative(rootVal) as Buffer;
    const onChainRoot = "0x" + Buffer.from(rootBytes).toString("hex");

    const chainCommitments = await fetchCommitmentsFromChain(poolId);
    let commitments: string[];
    if (chainCommitments && chainCommitments.length > 0) {
      commitments = chainCommitments;
    } else {
      await syncDepositsFromChain(poolId);
      commitments = getAllCommitments(note.poolId || POOL_CONTRACT_ID);
      if (commitments.length === 0) {
        throw new Error("Couldn't load the pool's deposit history. Use “Re-sync from network” below and try again.");
      }
    }

    const merkle = await buildMerkleTree(commitments, note.leafIndex);
    if (merkle.root.toLowerCase() !== onChainRoot.toLowerCase()) {
      throw new Error("Your local data is out of sync with the network. Use “Re-sync from network” below and try again.");
    }

    if (getUsdcSacId()) {
      if (recipientAddr === address) {
        await ensureUsdcTrustline(address!, signTransaction);
      } else if (!(await hasUsdcTrustline(recipientAddr))) {
        throw new Error(`Recipient can't receive USDC yet — ask them to add a USDC trustline.`);
      }
    }

    onStep("generating_proof");
    setProofStage(null);
    const recipientHash = await computeRecipientHash(recipientAddr);
    const { proof, publicInputs } = await proveWithdrawal(
      {
        nullifier: note.nullifier,
        secret: note.secret,
        root: onChainRoot,
        nullifierHash,
        recipientHash,
        pathSiblings: merkle.pathSiblings,
        pathBits: merkle.pathBits,
      },
      setProofStage,
    );
    setProofStage(null);

    onStep("submitting");
    const relayed = await relayWithdrawal({ poolId, recipient: recipientAddr, publicInputs, proof });
    if (relayed) {
      markNoteSpent(note.commitment);
      return relayed.hash;
    }

    onStep("signing");
    const tx = await buildContractCall(
      poolId,
      "withdraw",
      [
        StellarSdk.nativeToScVal(recipientAddr, { type: "address" }),
        StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
        StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
      ],
      address!,
    );
    const signedXdr = await signTransaction(tx.toXDR());
    onStep("submitting");
    const txHash = await submitTransaction(signedXdr);
    markNoteSpent(note.commitment);
    return txHash;
  }

  async function handleBatchWithdraw() {
    if (!address || selectedNotes.length === 0) return;
    const recipientAddr = recipient.trim() || address;

    setIsLoading(true);
    setStep("idle");

    const results: NoteResult[] = selectedNotes.map((note) => ({
      note,
      status: "pending",
    }));
    setBatchResults([...results]);

    for (let i = 0; i < results.length; i++) {
      results[i] = { ...results[i], status: "processing" };
      setBatchResults([...results]);

      try {
        const txHash = await withdrawNote(
          results[i].note,
          recipientAddr,
          setStep,
        );
        results[i] = { ...results[i], status: "done", txHash };
        setSelectedCommitments((prev) => {
          const next = new Set(prev);
          next.delete(results[i].note.commitment);
          return next;
        });
      } catch (err) {
        const msg = friendlyError(err);
        results[i] = { ...results[i], status: "error", error: msg };
        toast(`Note ${i + 1}/${results.length} failed: ${msg}`, "error");
      }

      setBatchResults([...results]);
    }

    setStep("idle");
    setIsLoading(false);

    const done = results.filter((r) => r.status === "done").length;
    const failed = results.filter((r) => r.status === "error").length;
    if (done > 0) {
      toast(
        failed > 0
          ? `${done} note${done > 1 ? "s" : ""} withdrawn, ${failed} failed.`
          : `${done} note${done > 1 ? "s" : ""} withdrawn successfully!`,
        failed > 0 ? "error" : "success",
      );
    }
    refresh();
  }

  async function handleClearCacheAndResync() {
    const poolId = selectedNotes[0]?.poolId || POOL_CONTRACT_ID;
    if (!poolId) {
      toast("Pool address is missing.", "error");
      return;
    }
    setIsLoading(true);
    try {
      clearDeposits(poolId);
      toast("Reloading deposit history from the network…");
      const synced = await syncDepositsFromChain(poolId);
      toast(`Synced ${synced} deposit${synced !== 1 ? "s" : ""} — try your withdrawal again.`, "success");
    } catch (err) {
      toast(`Couldn't re-sync — ${friendlyError(err)}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  if (!address) {
    return (
      <ConnectGate
        title="Withdraw"
        prompt="Connect your wallet to redeem your shielded notes."
      />
    );
  }

  const processingNote = batchResults?.find((r) => r.status === "processing")?.note;

  return (
    <PageShell>
      <PageHeader
        title="Withdraw"
        description="Choose the notes you want to redeem. DShield proves you own them without revealing which deposit was yours — nothing links the withdrawal back to you."
      />

      <div className="mt-8 space-y-6">
        {/* Note selector */}
        <Card>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-zinc-400">
              Your Notes ({activeNotes.length} available)
            </h3>
            <div className="flex items-center gap-3">
              {allNotes.length > 0 && (
                <button
                  type="button"
                  onClick={downloadAllNotes}
                  className="text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  Download all
                </button>
              )}
              {activeNotes.length > 0 && (
                <button
                  disabled={isLoading}
                  onClick={() =>
                    selectedCommitments.size === activeNotes.length
                      ? setSelectedCommitments(new Set())
                      : setSelectedCommitments(new Set(activeNotes.map((n) => n.commitment)))
                  }
                  className="text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:pointer-events-none"
                >
                  {selectedCommitments.size === activeNotes.length ? "Deselect all" : "Select all"}
                </button>
              )}
            </div>
          </div>

          {activeNotes.length === 0 ? (
            <div className="mt-3 py-4 text-center">
              <p className="text-sm text-zinc-500">
                You don&apos;t have any notes to withdraw yet.
              </p>
              <Link
                href="/deposit"
                className={buttonVariants({ variant: "outline", size: "sm", className: "mt-4" })}
              >
                Make a deposit
              </Link>
              <p className="mt-3 text-xs text-zinc-600">
                Received a note from someone? Import it below.
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              {activeNotes.map((note) => {
                const selected = selectedCommitments.has(note.commitment);
                const result = batchResults?.find((r) => r.note.commitment === note.commitment);
                return (
                  <button
                    key={note.commitment}
                    onClick={() => toggleNote(note)}
                    disabled={isLoading}
                    aria-pressed={selected}
                    className={`focus-ring w-full rounded-xl border px-4 py-3 text-left transition-all disabled:pointer-events-none ${
                      selected
                        ? "border-brand-500/50 bg-brand-950/30"
                        : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/40"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <div
                          className={`mt-0.5 h-4 w-4 shrink-0 rounded border transition-colors ${
                            selected
                              ? "border-brand-500 bg-brand-500"
                              : "border-zinc-600"
                          }`}
                        >
                          {selected && (
                            <svg viewBox="0 0 16 16" fill="white" className="h-4 w-4">
                              <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                            </svg>
                          )}
                        </div>
                        <span className="font-mono text-xs text-zinc-300">
                          {truncateMiddle(note.commitment, 14, 14)}
                        </span>
                      </div>

                      {/* Per-note result badge */}
                      {result && (
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                            result.status === "done"
                              ? "bg-green-950/60 text-green-400"
                              : result.status === "error"
                                ? "bg-red-950/60 text-red-400"
                                : result.status === "processing"
                                  ? "bg-brand-950/60 text-brand-400"
                                  : "bg-zinc-800 text-zinc-500"
                          }`}
                        >
                          {result.status === "done"
                            ? `✓ ${result.txHash ? truncateMiddle(result.txHash, 6, 4) : "done"}`
                            : result.status === "error"
                              ? "✗ failed"
                              : result.status === "processing"
                                ? "processing…"
                                : "queued"}
                        </span>
                      )}
                    </div>
                    <div className="ml-6 mt-1 flex gap-4 text-xs text-zinc-500">
                      <span>{new Date(note.createdAt).toLocaleDateString()}</span>
                      <span>Leaf #{note.leafIndex}</span>
                    </div>
                    {result?.error && (
                      <p className="ml-6 mt-1 text-xs text-red-400">{result.error}</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        {/* Import notes */}
        <NoteImport
          disabled={isLoading}
          onImport={(notes) => {
            const newSel = new Set(selectedCommitments);
            for (const note of notes) {
              saveNoteIfNew(note);
              newSel.add(note.commitment); // always select, even if note already existed in storage
            }
            setSelectedCommitments(newSel);
            refresh();
          }}
        />

        {/* Recipient + actions */}
        {selectedNotes.length > 0 && (
          <>
            <Card>
              <h3 className="mb-3 text-sm font-medium text-zinc-400">Recipient Address</h3>
              <Input
                type="text"
                mono
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                placeholder={address || "G..."}
                hint="Leave empty to withdraw to your connected wallet. Use a different address for unlinkable withdrawals."
              />
            </Card>

            <Button
              fullWidth
              size="lg"
              onClick={handleBatchWithdraw}
              disabled={isLoading}
            >
              {isLoading
                ? "Processing…"
                : selectedNotes.length === 1
                  ? "Generate Proof & Withdraw"
                  : `Generate Proofs & Withdraw ${selectedNotes.length} Notes`}
            </Button>

            <p className="text-center text-xs text-zinc-600">
              Withdrawal failing because your data is out of sync?{" "}
              <button
                type="button"
                onClick={handleClearCacheAndResync}
                disabled={isLoading}
                className="focus-ring rounded font-medium text-zinc-400 underline decoration-zinc-700 underline-offset-2 transition-colors hover:text-white disabled:pointer-events-none disabled:opacity-50"
              >
                Re-sync from network
              </button>
            </p>
          </>
        )}

        {/* Progress for current note */}
        {isLoading && processingNote && step !== "idle" && (
          <div className="space-y-2">
            {batchResults && batchResults.length > 1 && (
              <p className="text-xs text-zinc-500">
                Note {batchResults.findIndex((r) => r.status === "processing") + 1} of{" "}
                {batchResults.length}
              </p>
            )}
            <ProgressSteps
              label={
                step === "generating_proof" && proofStage
                  ? PROOF_STAGE_LABELS[proofStage]
                  : STEP_LABELS[step]
              }
              steps={PROGRESS_STEPS}
              current={step}
            />
          </div>
        )}
      </div>
    </PageShell>
  );
}
