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
  fetchWithdrawFeeQuote,
  POOL_CONTRACT_ID,
  type FeeQuote,
} from "@/lib/stellar";
import {
  getActiveNotes,
  getNotes,
  markNoteSpent,
  parseNote,
  saveNote,
  saveNoteIfNew,
  serializeNotes,
  generateRandomField,
  PENDING_LEAF_INDEX,
  type ShieldedNote,
} from "@/lib/notes";
import { getAllCommitments, clearDeposits } from "@/lib/deposits";
import {
  computeCommitment,
  computeNullifierHash,
  computeRecipientHash,
  buildMerkleTree,
  assetToField,
} from "@/lib/poseidon2";
import {
  syncDepositsFromChain,
  fetchCommitmentsFromChain,
  fetchMerkleProofFromService,
} from "@/lib/indexer";
import { proveWithdrawal, proveWithdrawalBatch, type ProofStage } from "@/lib/prover";
import { friendlyError } from "@/lib/errors";
import { resolvePendingLeafIndexes, syncSpentNotes } from "@/lib/sync";
import {
  formatAmount,
  formatAmountBare,
  truncateMiddle,
  usdcToStroops,
} from "@/lib/format";
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
  generating_proof:
    "Generating your private proof — this can take about a minute…",
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

/**
 * Mints the change note for a spend: a fresh note worth whatever the payout
 * and relayer fee left behind.
 *
 * Its secrets are never derived from the note being spent -- the change note
 * outlives this withdrawal, and reusing the nullifier would make it unspendable
 * the moment this spend is recorded. Its leaf index isn't knowable yet: the
 * withdrawal itself creates the leaf, and another transaction may take the next
 * slot first, so it is resolved from the chain once the spend confirms.
 *
 * At module scope rather than in the component: it draws randomness and reads
 * the clock, which the react-hooks/purity rule rightly keeps out of render.
 */
async function buildChangeNote(
  poolId: string,
  changeValue: string,
  asset: string,
): Promise<ShieldedNote> {
  const nullifier = generateRandomField();
  const secret = generateRandomField();
  const assetField = await assetToField(asset);
  const commitment = await computeCommitment(
    nullifier,
    secret,
    changeValue,
    assetField,
  );
  return {
    nullifier,
    secret,
    commitment: commitment.replace(/^0x/, ""),
    leafIndex: PENDING_LEAF_INDEX,
    amount: changeValue,
    asset,
    spent: false,
    createdAt: Date.now(),
    poolId,
  };
}

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
  const [selectedCommitments, setSelectedCommitments] = useState<Set<string>>(
    new Set(),
  );
  const [recipient, setRecipient] = useState("");
  // Map of note commitment -> custom recipient for multi-recipient batches.
  // Empty/missing means use the default recipient.
  const [customRecipients, setCustomRecipients] = useState<Map<string, string>>(new Map());
  // Only meaningful when exactly one note is selected: how much of it to pay
  // out. Empty means the whole note. Spending several notes at once always
  // spends each in full — there is no sensible way to split one figure across
  // notes of different sizes.
  const [partialAmount, setPartialAmount] = useState("");
  // Relayer fee in stroops. Default to 0.05 USDC (500k stroops), a reasonable
  // fee that covers gas costs without being excessive.
  const [relayerFeeStroops, setRelayerFeeStroops] = useState("500000");
  const [batchResults, setBatchResults] = useState<NoteResult[] | null>(null);
  const [, refresh] = useReducer((x: number) => x + 1, 0);
  // Effective relayer-fee quote for the selected withdrawal, shown before the
  // user signs so "you never need XLM" is visibly true (issue #149). Fetched
  // fresh whenever the selection changes; null means "no fee configured" (the
  // withdrawal proceeds exactly as before this feature) rather than loading.
  const [feeQuote, setFeeQuote] = useState<FeeQuote | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#note=")) return;
    const note = parseNote(decodeURIComponent(hash.slice("#note=".length)));
    if (!note) return;
    void saveNoteIfNew(note);
    setSelectedCommitments(new Set([note.commitment]));
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    // Settle any change note left pending by an earlier withdrawal (a closed
    // tab, a slow confirmation) before checking what is still spendable.
    resolvePendingLeafIndexes()
      .then((resolved) => syncSpentNotes().then((spent) => resolved + spent))
      .then((n) => {
        if (n > 0) refresh();
      });
  }, []);

  const activeNotes = typeof window !== "undefined" ? getActiveNotes() : [];
  const allNotes = typeof window !== "undefined" ? getNotes() : [];

  /**
   * Every selection change goes through here so the typed partial amount is
   * always dropped with it. That figure was entered against one specific note;
   * carrying it over to a different selection would withdraw the wrong amount,
   * and it is worth nothing to keep.
   */
  function changeSelection(
    update: (current: Set<string>) => Set<string>,
  ): void {
    if (isLoading) return;
    setPartialAmount("");
    setSelectedCommitments((prev) => update(new Set(prev)));
  }

  function toggleNote(note: ShieldedNote) {
    changeSelection((next) => {
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

  const selectedTotal = selectedNotes.reduce(
    (sum, n) => sum + BigInt(n.amount),
    BigInt(0),
  );
  // Partial withdrawal applies to a single selected note; with several
  // selected, each is spent in full.
  const partialNote = selectedNotes.length === 1 ? selectedNotes[0] : null;
  const partialStroops = partialAmount.trim()
    ? usdcToStroops(partialAmount)
    : (partialNote?.amount ?? "0");
  const partialExceedsNote =
    !!partialNote && BigInt(partialStroops) > BigInt(partialNote.amount);
  const partialIsZero =
    !!partialNote &&
    !!partialAmount.trim() &&
    BigInt(partialStroops) <= BigInt(0);
  const partialInvalid = partialExceedsNote || partialIsZero;

  // Validate relayer fee is reasonable.
  const feeValue = BigInt(relayerFeeStroops || "0");
  const MIN_FEE = BigInt(100_000); // 0.01 USDC
  const MAX_FEE = BigInt(10_000_000); // 1 USDC
  const feeOutOfBounds = feeValue < MIN_FEE || feeValue > MAX_FEE;

  const changeAfterPartial = partialNote
    ? (
        BigInt(partialNote.amount) -
        BigInt(partialStroops) -
        feeValue
      ).toString()
    : "0";
  const feeExceedsNote =
    partialNote &&
    BigInt(partialStroops) + feeValue > BigInt(partialNote.amount);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (selectedNotes.length === 0) {
      setFeeQuote(null);
      return;
    }
    const poolId = selectedNotes[0].poolId || POOL_CONTRACT_ID;
    if (!poolId) {
      setFeeQuote(null);
      return;
    }
    let cancelled = false;
    fetchWithdrawFeeQuote(poolId, selectedNotes[0].asset).then((quote) => {
      if (!cancelled) setFeeQuote(quote);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCommitments]);
  /* eslint-enable react-hooks/set-state-in-effect */

  /** How much of `note` this run should pay out. */
  function payoutFor(note: ShieldedNote): string {
    if (partialNote && note.commitment === partialNote.commitment) {
      return partialStroops;
    }
    return note.amount;
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

  // NOTE: withdrawNote is kept for reference but not used in batched withdrawal flow
  // The batch withdrawal logic is now consolidated in handleBatchWithdraw()
  /*
  async function withdrawNote(
    note: ShieldedNote,
    recipientAddr: string,
    withdrawStroops: string,
    relayerFeeStroops: string,
    onStep: (s: WithdrawStep) => void,
  ): Promise<string> {
    const poolId = note.poolId || POOL_CONTRACT_ID;
    if (!poolId)
      throw new Error("Pool address missing — refresh and try again.");

    const noteValue = BigInt(note.amount);
    const payout = BigInt(withdrawStroops);
    const fee = BigInt(relayerFeeStroops);
    const totalOut = payout + fee;

    if (payout < BigInt(0) || totalOut > noteValue) {
      throw new Error(
        `This note is worth ${formatAmount(note.amount)} — you can't withdraw more than that (including the relayer fee).`,
      );
    }
    const changeValue = (noteValue - totalOut).toString();

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

    // Prefer a self-hosted indexer service if one is configured — it skips
    // both the RPC round trips and the in-browser tree rebuild. Never a
    // trust boundary: whatever it returns is checked against onChainRoot
    // below exactly like the locally-rebuilt path is, so a stale or
    // misbehaving service just falls through to direct RPC scanning.
    let merkle = await fetchMerkleProofFromService(poolId, note.leafIndex);

    if (!merkle) {
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
      merkle = await buildMerkleTree(commitments, note.leafIndex);
    }

    if (merkle.root.toLowerCase() !== onChainRoot.toLowerCase()) {
      throw new Error(
        "Your local data is out of sync with the network. Use “Re-sync from network” below and try again.",
      );
    }

    if (getUsdcSacId() && payout > BigInt(0)) {
      if (recipientAddr === address) {
        await ensureUsdcTrustline(address!, signTransaction);
      } else if (!(await hasUsdcTrustline(recipientAddr))) {
        throw new Error(
          `Recipient can't receive USDC yet — ask them to add a USDC trustline.`,
        );
      }
    }

    onStep("generating_proof");
    setProofStage(null);
    const recipientHash = await computeRecipientHash(recipientAddr);

    const changeNote = await buildChangeNote(poolId, changeValue, note.asset);
    const assetField = await assetToField(note.asset);

    const { proof, publicInputs } = await proveWithdrawal(
      {
        nullifier: note.nullifier,
        secret: note.secret,
        amount: note.amount,
        asset: assetField,
        withdrawAmount: withdrawStroops,
        relayerFee: relayerFeeStroops,
        changeNullifier: changeNote.nullifier,
        changeSecret: changeNote.secret,
        changeCommitment: changeNote.commitment,
        root: onChainRoot,
        nullifierHash,
        recipientHash,
        pathSiblings: merkle.pathSiblings,
        pathBits: merkle.pathBits,
      },
      setProofStage,
    );
    setProofStage(null);

    // Saved before submission: past this point the remainder exists on-chain as
    // soon as the transaction lands, and these are the only keys to it.
    saveNote(changeNote);

    async function settle(): Promise<void> {
      markNoteSpent(note.commitment);
      await resolvePendingLeafIndexes();
    }

    onStep("submitting");
    const relayed = await relayWithdrawal({
      poolId,
      recipient: recipientAddr,
      publicInputs,
      proof,
      asset: note.asset,
    });
    if (relayed) {
      await settle();
      return relayed.hash;
    }

    onStep("signing");
    // No relayer configured, so this is submitted directly by the user's
    // wallet with no fee carve-out to abstract away.
    const tx = await buildContractCall(
      poolId,
      "withdraw",
      [
        StellarSdk.nativeToScVal(recipientAddr, { type: "address" }),
        StellarSdk.nativeToScVal(note.asset, { type: "address" }),
        StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
        StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
        StellarSdk.nativeToScVal(BigInt(0), { type: "i128" }),
        StellarSdk.nativeToScVal(BigInt(0), { type: "i128" }),
        StellarSdk.nativeToScVal(recipientAddr, { type: "address" }),
      ],
      address!,
    );
    const signedXdr = await signTransaction(tx.toXDR());
    onStep("submitting");
    const txHash = await submitTransaction(signedXdr);
    await settle();
    return txHash;
  }
  */

  async function handleBatchWithdraw() {
    if (!address || selectedNotes.length === 0 || partialInvalid) return;
    
    const defaultRecipient = recipient.trim() || address;
    const wasPartial = !!partialNote && BigInt(changeAfterPartial) > BigInt(0);
    const poolId = selectedNotes[0].poolId || POOL_CONTRACT_ID;

    setIsLoading(true);
    setStep("idle");

    const results: NoteResult[] = selectedNotes.map((note) => ({
      note,
      status: "pending",
    }));
    setBatchResults([...results]);

    try {
      // Build proof inputs for all notes in batch.
      const proofInputsArray = [];
      const changeNotes: ShieldedNote[] = [];

      setStep("checking_nullifier");
      // Verify all nullifiers are not yet used (batch-level check).
      for (const note of selectedNotes) {
        const nullifierHash = await computeNullifierHash(note.nullifier);
        const nullifierHashClean = nullifierHash.replace(/^0x/, "");
        const isUsed = await queryContract(poolId, "is_nullifier_used", [
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(nullifierHashClean, "hex")),
        ]);
        if (isUsed && StellarSdk.scValToNative(isUsed) === true) {
          throw new Error(`Note ${selectedNotes.indexOf(note) + 1} has already been withdrawn.`);
        }
      }

      setStep("building_tree");
      // Build merkle tree once for all notes.
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
        commitments = getAllCommitments(poolId);
        if (commitments.length === 0) {
          throw new Error("Couldn't load the pool's deposit history. Use \"Re-sync from network\" below and try again.");
        }
      }

      // Prepare all change notes and proof inputs upfront.
      for (const note of selectedNotes) {
        const noteValue = BigInt(note.amount);
        const payout = BigInt(payoutFor(note));
        if (payout < BigInt(0) || payout > noteValue) {
          throw new Error(`Note worth ${formatAmount(note.amount)} can't withdraw ${formatAmount(payout.toString())}.`);
        }
        const changeValue = (noteValue - payout).toString();

        // Determine recipient for this note.
        const noteRecipient = defaultRecipient;

        if (getUsdcSacId() && payout > BigInt(0)) {
          if (noteRecipient === address) {
            await ensureUsdcTrustline(address!, signTransaction);
          } else if (!(await hasUsdcTrustline(noteRecipient))) {
            throw new Error(`Recipient ${truncateMiddle(noteRecipient, 6, 4)} can't receive USDC — ask them to add a trustline.`);
          }
        }

        const merkle = await buildMerkleTree(commitments, note.leafIndex);
        if (merkle.root.toLowerCase() !== onChainRoot.toLowerCase()) {
          throw new Error("Your local data is out of sync with the network. Use \"Re-sync from network\" below and try again.");
        }

        const recipientHash = await computeRecipientHash(noteRecipient);
        const changeNote = await buildChangeNote(poolId, changeValue);
        changeNotes.push(changeNote);

        proofInputsArray.push({
          nullifier: note.nullifier,
          secret: note.secret,
          amount: note.amount,
          withdrawAmount: payoutFor(note),
          changeNullifier: changeNote.nullifier,
          changeSecret: changeNote.secret,
          changeCommitment: changeNote.commitment,
          root: onChainRoot,
          nullifierHash: await computeNullifierHash(note.nullifier),
          recipientHash,
          pathSiblings: merkle.pathSiblings,
          pathBits: merkle.pathBits,
        });
      }

      // Generate all proofs in parallel.
      setStep("generating_proof");
      setProofStage(null);
      const proofs = await proveWithdrawalBatch(proofInputsArray, (noteIdx, stage) => {
        setProofStage(stage);
      });
      setProofStage(null);

      // Save all change notes before submission.
      for (const changeNote of changeNotes) {
        await saveNote(changeNote);
      }

      setStep("signing");
      // Build and sign batch call if multiple notes, or single call if one note.
      const recipients = selectedNotes.map((note) => defaultRecipient);

      let txHash: string;
      if (selectedNotes.length === 1) {
        // Single withdrawal: use withdraw() contract method.
        const tx = await buildContractCall(
          poolId,
          "withdraw",
          [
            StellarSdk.nativeToScVal(recipients[0], { type: "address" }),
            StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proofs[0].publicInputs, "hex")),
            StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proofs[0].proof, "hex")),
          ],
          address!,
        );
        const signedXdr = await signTransaction(tx.toXDR());
        setStep("submitting");
        txHash = await submitTransaction(signedXdr);
      } else {
        // Batch withdrawal: use withdraw_batch() contract method.
        const recipientScVals = recipients.map((r) =>
          StellarSdk.nativeToScVal(r, { type: "address" }),
        );
        const publicInputsVec = proofs.map((p) =>
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(p.publicInputs, "hex")),
        );
        const proofVec = proofs.map((p) =>
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(p.proof, "hex")),
        );

        const tx = await buildContractCall(
          poolId,
          "withdraw_batch",
          [
            StellarSdk.xdr.ScVal.scvVec(recipientScVals),
            StellarSdk.xdr.ScVal.scvVec(publicInputsVec),
            StellarSdk.xdr.ScVal.scvVec(proofVec),
          ],
          address!,
        );
        const signedXdr = await signTransaction(tx.toXDR());
        setStep("submitting");
        txHash = await submitTransaction(signedXdr);
      }

      // Mark notes spent and resolve pending indices.
      for (const note of selectedNotes) {
        markNoteSpent(note.commitment);
      }
      await resolvePendingLeafIndexes();

      // Update results to success.
      setBatchResults(
        selectedNotes.map((note) => ({
          note,
          status: "done" as const,
          txHash,
        })),
      );

      setSelectedCommitments(new Set());
      setCustomRecipients(new Map());

      const done = selectedNotes.length;
      if (wasPartial && selectedNotes.length === 1) {
        toast(
          `Withdrew ${formatAmount(partialStroops)} — ${formatAmount(changeAfterPartial)} re-shielded into a new note.`,
          "success",
        );
      } else {
        toast(
          `${done} note${done > 1 ? "s" : ""} withdrawn successfully in one transaction!`,
          "success",
        );
      }
    } catch (err) {
      const msg = friendlyError(err);
      toast(`Batch withdrawal failed: ${msg}`, "error");
      setBatchResults(
        selectedNotes.map((note) => ({
          note,
          status: "error" as const,
          error: msg,
        })),
      );
    }

    setStep("idle");
    setIsLoading(false);
    setPartialAmount("");
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
      toast(
        `Synced ${synced} deposit${synced !== 1 ? "s" : ""} — try your withdrawal again.`,
        "success",
      );
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

  const processingNote = batchResults?.find(
    (r) => r.status === "processing",
  )?.note;

  return (
    <PageShell>
      <PageHeader
        title="Withdraw"
        description="Choose a note to redeem. Take all of it, or take part and the rest is re-shielded into a fresh note you can spend from again. DShield proves you own the note without revealing which deposit was yours — nothing links the withdrawal back to you."
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
                    changeSelection(() =>
                      selectedCommitments.size === activeNotes.length
                        ? new Set()
                        : new Set(activeNotes.map((n) => n.commitment)),
                    )
                  }
                  className="text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:pointer-events-none"
                >
                  {selectedCommitments.size === activeNotes.length
                    ? "Deselect all"
                    : "Select all"}
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
                className={buttonVariants({
                  variant: "outline",
                  size: "sm",
                  className: "mt-4",
                })}
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
                const result = batchResults?.find(
                  (r) => r.note.commitment === note.commitment,
                );
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
                            <svg
                              viewBox="0 0 16 16"
                              fill="white"
                              className="h-4 w-4"
                            >
                              <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z" />
                            </svg>
                          )}
                        </div>
                        <div>
                          <span className="text-sm font-medium text-zinc-200">
                            {formatAmount(note.amount)}
                          </span>
                          <span className="ml-2 font-mono text-xs text-zinc-500">
                            {truncateMiddle(note.commitment, 10, 10)}
                          </span>
                        </div>
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
                      <span>
                        {new Date(note.createdAt).toLocaleDateString()}
                      </span>
                      <span>Leaf #{note.leafIndex}</span>
                    </div>
                    {result?.error && (
                      <p className="ml-6 mt-1 text-xs text-red-400">
                        {result.error}
                      </p>
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
            for (const note of notes) saveNoteIfNew(note);
            changeSelection((next) => {
              // Always select, even if the note already existed in storage.
              for (const note of notes) next.add(note.commitment);
              return next;
            });
            refresh();
          }}
        />

        {/* Amount + recipient + actions */}
        {selectedNotes.length > 0 && (
          <>
            {partialNote ? (
              <Card>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-zinc-400">
                    Amount to withdraw
                  </h3>
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() =>
                      setPartialAmount(formatAmountBare(partialNote.amount))
                    }
                    className="focus-ring rounded text-xs text-zinc-500 transition-colors hover:text-zinc-300 disabled:pointer-events-none"
                  >
                    Max ({formatAmount(partialNote.amount)})
                  </button>
                </div>
                <Input
                  type="text"
                  inputMode="decimal"
                  mono
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                  placeholder={formatAmountBare(partialNote.amount)}
                  disabled={isLoading}
                  hint={(() => {
                    if (partialExceedsNote) {
                      return `This note only holds ${formatAmount(partialNote.amount)}.`;
                    }
                    if (partialIsZero) {
                      return "Enter an amount greater than zero.";
                    }
                    if (BigInt(changeAfterPartial) > BigInt(0)) {
                      return (
                        <>
                          <span className="text-zinc-400">
                            {formatAmount(changeAfterPartial)}
                          </span>{" "}
                          stays shielded as a new note, saved to this device.
                          You can withdraw from it later, as many times as you
                          like.
                        </>
                      );
                    }
                    return `Withdraws the whole note. Leave empty for the same thing.`;
                  })()}
                />
              </Card>
            ) : (
              <Card>
                <p className="text-sm text-zinc-400">
                  Withdrawing{" "}
                  <span className="font-medium text-zinc-200">
                    {formatAmount(selectedTotal.toString())}
                  </span>{" "}
                  across {selectedNotes.length} notes, each in full.
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  Select a single note to withdraw only part of it.
                </p>
              </Card>
            )}

            <Card>
              <h3 className="mb-3 text-sm font-medium text-zinc-400">
                Recipient Address
              </h3>
              <Input
                type="text"
                mono
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                placeholder={address || "G..."}
                hint="Leave empty to withdraw to your connected wallet. Use a different address for unlinkable withdrawals."
              />
            </Card>

            {feeQuote && BigInt(feeQuote.feeAmount) > BigInt(0) && (
              <Card>
                <h3 className="mb-2 text-sm font-medium text-zinc-400">
                  Network Fee
                </h3>
                <p className="text-sm text-zinc-300">
                  <span className="font-medium">
                    {formatAmount(feeQuote.feeAmount)}
                  </span>{" "}
                  is deducted from your withdrawal and swapped for XLM to
                  cover the network cost.
                </p>
                <p className="mt-1 text-xs text-zinc-600">
                  You never need to hold XLM yourself — the swap happens
                  on-chain as part of this withdrawal.
                </p>
              </Card>
            )}

            <Button
              fullWidth
              size="lg"
              onClick={handleBatchWithdraw}
              disabled={
                isLoading ||
                partialInvalid ||
                feeOutOfBounds ||
                !!feeExceedsNote
              }
            >
              {isLoading
                ? "Processing…"
                : selectedNotes.length > 1
                  ? `Generate Proofs & Withdraw ${selectedNotes.length} Notes`
                  : partialNote
                    ? `Generate Proof & Withdraw ${formatAmount(partialStroops)}`
                    : `Generate Proof & Withdraw ${formatAmount(selectedTotal.toString())}`}
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
                Note{" "}
                {batchResults.findIndex((r) => r.status === "processing") + 1}{" "}
                of {batchResults.length}
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
