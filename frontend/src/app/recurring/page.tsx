"use client";

import { useState, useEffect, useReducer } from "react";
import { useWallet } from "@/components/WalletProvider";
import {
  buildContractCall,
  submitTransaction,
  queryContract,
  relayWithdrawal,
  POOL_CONTRACT_ID,
} from "@/lib/stellar";
import {
  getActiveNotes,
  saveNote,
  generateRandomField,
  PENDING_LEAF_INDEX,
  markNoteSpent,
  getActiveRecurringAuths,
  saveRecurringAuth,
  markRecurringAuthRevoked,
  type ShieldedNote,
  type RecurringAuth,
} from "@/lib/notes";
import {
  computeCommitment,
  computeNullifierHash,
  computeRecipientHash,
  computeAuthCommitment,
  buildMerkleTree,
  assetToField,
} from "@/lib/poseidon2";
import { fetchCommitmentsFromChain, syncDepositsFromChain } from "@/lib/indexer";
import { getAllCommitments } from "@/lib/deposits";
import { proveRecurringAuthorization, type ProofStage } from "@/lib/prover";
import { resolvePendingLeafIndexes } from "@/lib/sync";
import {
  formatAmount,
  formatAmountBare,
  usdcToStroops,
  truncateMiddle,
  TOKEN_SYMBOL,
} from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { PageShell, PageHeader, ConnectGate } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { ProgressSteps } from "@/components/ui/ProgressSteps";
import { useToast } from "@/components/ui/Toast";
import * as StellarSdk from "@stellar/stellar-sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

type SetupStep =
  | "idle"
  | "checking_nullifier"
  | "building_tree"
  | "generating_proof"
  | "submitting"
  | "done";

const SETUP_STEP_LABELS: Record<SetupStep, string> = {
  idle: "",
  checking_nullifier: "Checking note status…",
  building_tree: "Syncing with the pool…",
  generating_proof: "Generating authorization proof — this takes about a minute…",
  submitting: "Sending to the network…",
  done: "Authorization created!",
};

const PROOF_STAGE_LABELS: Record<ProofStage, string> = {
  executing: "Executing the circuit — this can take about a minute…",
  proving: "Creating the cryptographic proof…",
};

const SETUP_PROGRESS_STEPS = [
  "checking_nullifier",
  "building_tree",
  "generating_proof",
  "submitting",
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Period options in seconds. */
const PERIOD_OPTIONS = [
  { label: "Daily", value: 86_400 },
  { label: "Weekly", value: 7 * 86_400 },
  { label: "Monthly (30 days)", value: 30 * 86_400 },
  { label: "Custom", value: 0 },
];

function periodLabel(secs: number): string {
  const p = PERIOD_OPTIONS.find((o) => o.value === secs && o.value !== 0);
  if (p) return p.label;
  if (secs === 0) return "No cooldown";
  const days = Math.round(secs / 86_400);
  return days === 1 ? "Every day" : `Every ${days} days`;
}

function nextOccurrenceLabel(periodSecs: number, lastTs: number): string {
  if (lastTs === 0) return "Ready now";
  const nextMs = (lastTs + periodSecs) * 1000;
  if (Date.now() >= nextMs) return "Ready now";
  return `Next: ${new Date(nextMs).toLocaleString()}`;
}

/**
 * Builds the RecurringAuth record to persist. At module scope, like
 * buildChangeNote below, so the react-hooks/purity rule doesn't see
 * Date.now() as part of the component's render.
 */
function buildAuthRecord(
  fields: Omit<RecurringAuth, "createdAt" | "revoked">,
): RecurringAuth {
  return { ...fields, createdAt: Date.now(), revoked: false };
}

/** Build the change note for the authorization setup. */
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

// ── Component ─────────────────────────────────────────────────────────────────

export default function RecurringPage() {
  const { address, signTransaction } = useWallet();
  const { toast } = useToast();
  const [, refresh] = useReducer((x: number) => x + 1, 0);

  // Setup form state
  const [selectedNote, setSelectedNote] = useState<ShieldedNote | null>(null);
  const [recipient, setRecipient] = useState("");
  const [maxAmount, setMaxAmount] = useState("");
  const [maxUses, setMaxUses] = useState("12");
  const [periodPreset, setPeriodPreset] = useState(PERIOD_OPTIONS[2].value); // monthly
  const [customDays, setCustomDays] = useState("");

  // Progress
  const [step, setStep] = useState<SetupStep>("idle");
  const [proofStage, setProofStage] = useState<ProofStage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const activeNotes = typeof window !== "undefined" ? getActiveNotes() : [];
  const recurringAuths =
    typeof window !== "undefined" ? getActiveRecurringAuths() : [];

  useEffect(() => {
    resolvePendingLeafIndexes().then((n) => {
      if (n > 0) refresh();
    });
  }, []);

  // Derived
  const recipientAddr = recipient.trim() || address || "";
  const maxAmountStroops = maxAmount.trim() ? usdcToStroops(maxAmount) : "0";
  const maxUsesNum = parseInt(maxUses, 10);
  const periodSecs =
    periodPreset !== 0
      ? periodPreset
      : (parseInt(customDays, 10) || 0) * 86_400;

  const maxAmountValid =
    maxAmount.trim() !== "" &&
    BigInt(maxAmountStroops) > BigInt(0) &&
    selectedNote != null &&
    BigInt(maxAmountStroops) <= BigInt(selectedNote?.amount ?? "0");
  const maxUsesValid =
    !isNaN(maxUsesNum) && maxUsesNum >= 1 && maxUsesNum <= 255;
  const periodValid = periodSecs >= 0;
  const recipientValid =
    recipientAddr !== "" && StellarSdk.StrKey.isValidEd25519PublicKey(recipientAddr);

  const formValid =
    selectedNote != null &&
    maxAmountValid &&
    maxUsesValid &&
    periodValid &&
    recipientValid;

  // ── Setup handler ──────────────────────────────────────────────────────────

  async function handleSetup() {
    if (!address || !selectedNote || !formValid) return;
    const poolId = selectedNote.poolId || POOL_CONTRACT_ID;
    if (!poolId) {
      toast("Pool address missing — refresh and try again.", "error");
      return;
    }

    setIsLoading(true);
    setStep("idle");

    try {
      // 1. Check nullifier
      setStep("checking_nullifier");
      const nullifierHash = await computeNullifierHash(selectedNote.nullifier);
      const nullifierHashClean = nullifierHash.replace(/^0x/, "");
      const isUsed = await queryContract(poolId, "is_nullifier_used", [
        StellarSdk.xdr.ScVal.scvBytes(Buffer.from(nullifierHashClean, "hex")),
      ]);
      if (isUsed && StellarSdk.scValToNative(isUsed) === true) {
        throw new Error("This note has already been withdrawn.");
      }

      // 2. Build tree
      setStep("building_tree");
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
        commitments = getAllCommitments(selectedNote.poolId || POOL_CONTRACT_ID);
        if (commitments.length === 0) {
          throw new Error(
            "Couldn't load the pool's deposit history. Use \"Re-sync from network\" and try again.",
          );
        }
      }

      const merkle = await buildMerkleTree(commitments, selectedNote.leafIndex);
      if (merkle.root.toLowerCase() !== onChainRoot.toLowerCase()) {
        throw new Error(
          "Your local data is out of sync with the network. Refresh the page and try again.",
        );
      }

      // 3. Generate proof
      setStep("generating_proof");
      setProofStage(null);

      const recipientHash = await computeRecipientHash(recipientAddr);

      // The change note holds (note.amount - maxAmountStroops).
      const changeValue = (
        BigInt(selectedNote.amount) - BigInt(maxAmountStroops)
      ).toString();
      const changeNote = await buildChangeNote(poolId, changeValue, selectedNote.asset);

      // Auth nullifier: a fresh random secret for this authorization.
      const authNullifier = generateRandomField();

      // Compute the auth commitment locally so we can save the record
      // before submitting.  The circuit computes the same hash in-circuit.
      // hash_auth = H(H(H(H(H(RECA, auth_nullifier), recipient), max_amount), period_secs), max_uses)
      const authCommitmentHex = await computeAuthCommitment(
        authNullifier,
        recipientHash,
        maxAmountStroops,
        String(periodSecs),
        String(maxUsesNum),
      );
      const authCommitment = authCommitmentHex.replace(/^0x/, "");

      const { proof, publicInputs } = await proveRecurringAuthorization(
        {
          nullifier: selectedNote.nullifier,
          secret: selectedNote.secret,
          amount: selectedNote.amount,
          authNullifier,
          recipient: recipientHash,
          maxAmount: maxAmountStroops,
          periodSecs: String(periodSecs),
          maxUses: String(maxUsesNum),
          changeNullifier: changeNote.nullifier,
          changeSecret: changeNote.secret,
          changeCommitment: changeNote.commitment,
          root: onChainRoot,
          nullifierHash,
          pathSiblings: merkle.pathSiblings,
          pathBits: merkle.pathBits,
        },
        setProofStage,
      );
      setProofStage(null);

      // Save the auth record and change note BEFORE submitting — if the tab
      // closes after submission but before this, the change note is lost.
      const authRecord = buildAuthRecord({
        authCommitment,
        authNullifier,
        recipient: recipientAddr,
        maxAmount: maxAmountStroops,
        periodSecs,
        maxUses: maxUsesNum,
        changeCommitment: changeNote.commitment,
        poolId,
      });
      await saveRecurringAuth(authRecord);
      await saveNote(changeNote);

      // 4. Submit
      setStep("submitting");
      const relayed = await relayWithdrawal({
        poolId,
        recipient: recipientAddr,
        publicInputs,
        proof,
        asset: selectedNote.asset,
      }).catch(() => null);

      if (!relayed) {
        // Fallback: wallet-signed submission (no relayer configured)
        const tx = await buildContractCall(
          poolId,
          "authorize_recurring",
          [
            StellarSdk.nativeToScVal(recipientAddr, { type: "address" }),
            StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
            StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
          ],
          address,
        );
        const signedXdr = await signTransaction(tx.toXDR());
        await submitTransaction(signedXdr);
      }

      markNoteSpent(selectedNote.commitment);
      await resolvePendingLeafIndexes();

      setStep("done");
      toast(
        `Recurring authorization created — up to ${formatAmount(maxAmountStroops)} per occurrence, ${maxUsesNum} time${maxUsesNum !== 1 ? "s" : ""}.`,
        "success",
      );

      // Reset form
      setSelectedNote(null);
      setMaxAmount("");
      setMaxUses("12");
      setRecipient("");
      refresh();
    } catch (err) {
      const msg = friendlyError(err);
      toast(`Authorization failed: ${msg}`, "error");
      setStep("idle");
    } finally {
      setIsLoading(false);
    }
  }

  // ── Revoke handler ─────────────────────────────────────────────────────────

  async function handleRevoke(auth: RecurringAuth) {
    if (!address) return;
    const poolId = auth.poolId || POOL_CONTRACT_ID;
    setIsLoading(true);
    try {
      const tx = await buildContractCall(
        poolId,
        "revoke_recurring",
        [
          StellarSdk.xdr.ScVal.scvBytes(
            Buffer.from(auth.authCommitment, "hex"),
          ),
        ],
        address,
      );
      const signedXdr = await signTransaction(tx.toXDR());
      await submitTransaction(signedXdr);
      await markRecurringAuthRevoked(auth.authCommitment);
      toast("Authorization revoked — no further withdrawals will execute.", "success");
      refresh();
    } catch (err) {
      toast(`Revoke failed: ${friendlyError(err)}`, "error");
    } finally {
      setIsLoading(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (!address) {
    return (
      <ConnectGate
        title="Recurring Withdrawals"
        prompt="Connect your wallet to set up pre-authorized recurring payments."
      />
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Recurring Withdrawals"
        description={
          <>
            Pre-authorize a bounded series of withdrawals from one shielded note — useful
            for subscriptions, scheduled disbursements, or payroll. A single ZK proof sets
            up the authorization; each subsequent payment happens without a new proof or your
            manual involvement.{" "}
            <span className="text-yellow-400/80">
              The source note is consumed upfront.
            </span>
          </>
        }
      />

      <div className="mt-8 space-y-6">
        {/* ── Setup form ── */}
        <Card>
          <h2 className="mb-4 text-sm font-semibold text-zinc-300">
            New Authorization
          </h2>

          {/* Note selector */}
          <div className="mb-4">
            <p className="mb-2 text-xs font-medium text-zinc-400">
              Source Note ({activeNotes.length} available)
            </p>
            {activeNotes.length === 0 ? (
              <p className="text-sm text-zinc-500">
                No spendable notes — make a deposit first.
              </p>
            ) : (
              <div className="space-y-2">
                {activeNotes.map((note) => {
                  const selected = selectedNote?.commitment === note.commitment;
                  return (
                    <button
                      key={note.commitment}
                      onClick={() => {
                        if (!isLoading) {
                          setSelectedNote(selected ? null : note);
                          setMaxAmount("");
                        }
                      }}
                      disabled={isLoading}
                      aria-pressed={selected}
                      className={`focus-ring w-full rounded-xl border px-4 py-3 text-left transition-all disabled:pointer-events-none ${
                        selected
                          ? "border-brand-500/50 bg-brand-950/30"
                          : "border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/40"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-4 w-4 shrink-0 rounded-full border transition-colors ${
                            selected
                              ? "border-brand-500 bg-brand-500"
                              : "border-zinc-600"
                          }`}
                        />
                        <div>
                          <span className="text-sm font-medium text-zinc-200">
                            {formatAmount(note.amount)}
                          </span>
                          <span className="ml-2 font-mono text-xs text-zinc-500">
                            {truncateMiddle(note.commitment, 8, 8)}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {selectedNote && (
            <div className="space-y-4">
              {/* Recipient */}
              <Input
                type="text"
                mono
                label="Recipient Address"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value.trim())}
                placeholder={address}
                hint="The Stellar address that will receive each scheduled payment. Leave empty to use your connected wallet."
                disabled={isLoading}
              />

              {/* Max amount per occurrence */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label className="text-xs font-medium text-zinc-400">
                    Max per occurrence ({TOKEN_SYMBOL})
                  </label>
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() =>
                      setMaxAmount(formatAmountBare(selectedNote.amount))
                    }
                    className="focus-ring rounded text-xs text-zinc-500 hover:text-zinc-300 disabled:pointer-events-none"
                  >
                    Max ({formatAmount(selectedNote.amount)})
                  </button>
                </div>
                <Input
                  type="text"
                  inputMode="decimal"
                  mono
                  value={maxAmount}
                  onChange={(e) => setMaxAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading}
                  hint={(() => {
                    if (!maxAmount.trim()) {
                      return "Each occurrence may draw up to this amount from the source note.";
                    }
                    if (BigInt(maxAmountStroops) <= BigInt(0)) {
                      return "Enter an amount greater than zero.";
                    }
                    if (
                      BigInt(maxAmountStroops) > BigInt(selectedNote.amount)
                    ) {
                      return `This note only holds ${formatAmount(selectedNote.amount)}.`;
                    }
                    const change =
                      BigInt(selectedNote.amount) - BigInt(maxAmountStroops);
                    return (
                      <>
                        First occurrence pays{" "}
                        <span className="text-zinc-300">
                          {formatAmount(maxAmountStroops)}
                        </span>
                        ; remaining{" "}
                        <span className="text-zinc-300">
                          {formatAmount(change.toString())}
                        </span>{" "}
                        is re-shielded as a change note.
                      </>
                    );
                  })()}
                />
              </div>

              {/* Period */}
              <div>
                <label className="mb-2 block text-xs font-medium text-zinc-400">
                  Period
                </label>
                <div className="flex flex-wrap gap-2">
                  {PERIOD_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      disabled={isLoading}
                      onClick={() => setPeriodPreset(opt.value)}
                      className={`focus-ring rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:pointer-events-none ${
                        periodPreset === opt.value
                          ? "border-brand-500/60 bg-brand-950/40 text-brand-300"
                          : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                {periodPreset === 0 && (
                  <div className="mt-2">
                    <Input
                      type="text"
                      inputMode="numeric"
                      mono
                      value={customDays}
                      onChange={(e) => setCustomDays(e.target.value)}
                      placeholder="30"
                      hint="Number of days between occurrences (0 = no cooldown)."
                      disabled={isLoading}
                    />
                  </div>
                )}
              </div>

              {/* Max uses */}
              <Input
                type="text"
                inputMode="numeric"
                label="Total occurrences (1–255)"
                mono
                value={maxUses}
                onChange={(e) => setMaxUses(e.target.value)}
                placeholder="12"
                hint={
                  maxUsesValid
                    ? `Authorization expires automatically after ${maxUsesNum} payment${maxUsesNum !== 1 ? "s" : ""}.`
                    : "Must be a whole number between 1 and 255."
                }
                disabled={isLoading}
              />

              {/* Summary */}
              {formValid && (
                <div className="rounded-xl border border-zinc-700/60 bg-zinc-800/30 px-4 py-3 text-xs text-zinc-400 space-y-1">
                  <p>
                    <span className="font-medium text-zinc-200">
                      {formatAmount(maxAmountStroops)}
                    </span>{" "}
                    per occurrence ·{" "}
                    <span className="font-medium text-zinc-200">
                      {maxUsesNum}
                    </span>{" "}
                    total ·{" "}
                    <span className="font-medium text-zinc-200">
                      {periodLabel(periodSecs)}
                    </span>
                  </p>
                  <p>
                    Recipient:{" "}
                    <span className="font-mono text-zinc-300">
                      {truncateMiddle(recipientAddr, 10, 8)}
                    </span>
                  </p>
                  <p className="text-yellow-400/70">
                    The source note is consumed during setup. You will receive a
                    change note worth the remainder.
                  </p>
                </div>
              )}

              <Button
                fullWidth
                size="lg"
                onClick={handleSetup}
                disabled={isLoading || !formValid}
              >
                {isLoading ? "Processing…" : "Generate Proof & Authorize"}
              </Button>
            </div>
          )}
        </Card>

        {/* Progress */}
        {isLoading && step !== "idle" && (
          <ProgressSteps
            label={
              step === "generating_proof" && proofStage
                ? PROOF_STAGE_LABELS[proofStage]
                : SETUP_STEP_LABELS[step]
            }
            steps={SETUP_PROGRESS_STEPS}
            current={step}
          />
        )}

        {/* ── Management view ── */}
        {recurringAuths.length > 0 && (
          <Card>
            <h2 className="mb-4 text-sm font-semibold text-zinc-300">
              Active Authorizations ({recurringAuths.length})
            </h2>
            <div className="space-y-3">
              {recurringAuths.map((auth) => (
                <RecurringAuthCard
                  key={auth.authCommitment}
                  auth={auth}
                  onRevoke={() => handleRevoke(auth)}
                  isLoading={isLoading}
                />
              ))}
            </div>
          </Card>
        )}

        {/* Info box */}
        <Card>
          <h3 className="mb-3 text-sm font-medium text-zinc-400">
            How recurring withdrawals work
          </h3>
          <ol className="space-y-2 text-sm text-zinc-500">
            <li>
              1. You generate one ZK proof upfront that authorizes a bounded
              series of payouts from a single note.
            </li>
            <li>
              2. The pool contract records the authorization on-chain (amount
              cap, period, and use count). Your source note is consumed; a
              change note holds the remainder.
            </li>
            <li>
              3. The relayer executes each occurrence on schedule — no new proof,
              no wallet interaction required.
            </li>
            <li>
              4. You can revoke at any time with a signed transaction. Revocation
              takes effect immediately; no further payments will execute.
            </li>
          </ol>
          <p className="mt-3 text-xs text-yellow-400/70">
            The relayer cannot steal funds — it can only trigger the authorized
            amount to the committed recipient. If the relayer stops working, you
            can trigger occurrences yourself via the contract.
          </p>
        </Card>
      </div>
    </PageShell>
  );
}

// ── RecurringAuthCard sub-component ───────────────────────────────────────────

function RecurringAuthCard({
  auth,
  onRevoke,
  isLoading,
}: {
  auth: RecurringAuth;
  onRevoke: () => void;
  isLoading: boolean;
}) {
  const [onChainState, setOnChainState] = useState<{
    usesRemaining: number;
    lastTs: number;
  } | null>(null);

  useEffect(() => {
    const poolId = auth.poolId || POOL_CONTRACT_ID;
    if (!poolId) return;
    queryContract(poolId, "get_recurring_auth", [
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(auth.authCommitment, "hex")),
    ])
      .then((val) => {
        if (!val) return;
        const native = StellarSdk.scValToNative(val) as Record<string, unknown>;
        setOnChainState({
          usesRemaining: Number(native.uses_remaining ?? 0),
          lastTs: Number(native.last_withdraw_ts ?? 0),
        });
      })
      .catch(() => null);
  }, [auth]);

  return (
    <div className="rounded-xl border border-zinc-800 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">
            {formatAmount(auth.maxAmount)}{" "}
            <span className="font-normal text-zinc-400">
              × {auth.maxUses} · {periodLabel(auth.periodSecs)}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            Recipient:{" "}
            <span className="font-mono">{truncateMiddle(auth.recipient, 10, 8)}</span>
          </p>
          {onChainState && (
            <p className="mt-0.5 text-xs text-zinc-500">
              {onChainState.usesRemaining} occurrence
              {onChainState.usesRemaining !== 1 ? "s" : ""} remaining ·{" "}
              {nextOccurrenceLabel(auth.periodSecs, onChainState.lastTs)}
            </p>
          )}
          <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
            {truncateMiddle(auth.authCommitment, 10, 10)}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onRevoke}
          disabled={isLoading}
          className="shrink-0"
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}
