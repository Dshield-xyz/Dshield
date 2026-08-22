"use client";

import { useRef, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import {
  buildContractCall,
  submitTransaction,
  queryContract,
  getPoolId,
  ensureUsdcTrustline,
  faucetUsdc,
  getUsdcSacId,
} from "@/lib/stellar";
import {
  saveNote,
  serializeNote,
  generateNoteLink,
  generateRandomField,
  setNoteLeafIndex,
  PENDING_LEAF_INDEX,
  type ShieldedNote,
} from "@/lib/notes";
import { saveDeposit } from "@/lib/deposits";
import { fetchLeafIndex } from "@/lib/sync";
import { computeCommitment } from "@/lib/poseidon2";
import {
  TOKEN_SYMBOL,
  formatAmount,
  formatAmountBare,
  usdcToStroops,
} from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { PageShell, PageHeader, ConnectGate } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  CopyIcon,
  TelegramIcon,
  WhatsAppIcon,
  XIcon,
} from "@/components/icons";
import { useToast } from "@/components/ui/Toast";
import * as StellarSdk from "@stellar/stellar-sdk";

// Largest value a single note may carry, matching the pool contract's
// MAX_NOTE_AMOUNT (u64::MAX stroops). Anything above it would be rejected
// on-chain, so it is caught here instead with an explanation.
const MAX_NOTE_STROOPS = (BigInt(2) ** BigInt(64) - BigInt(1)).toString();

/**
 * Mints a fresh note worth `amountStroops`.
 *
 * The leaf index is left pending: which slot the deposit lands on isn't
 * decided until it confirms, and any other deposit or withdrawal that gets
 * there first takes it. Reading `get_next_index` beforehand only predicts it.
 * The real index is read back from the pool afterwards, and a note carrying the
 * wrong one is unspendable — its Merkle proof would be built against someone
 * else's leaf.
 *
 * Lives at module scope, alongside the other non-render logic: it draws
 * randomness and reads the clock, neither of which belongs in a component body.
 */
async function buildNote(
  poolId: string,
  amountStroops: string,
): Promise<ShieldedNote> {
  const nullifier = generateRandomField();
  const secret = generateRandomField();
  const commitment = await computeCommitment(nullifier, secret, amountStroops);
  return {
    nullifier,
    secret,
    commitment: commitment.replace(/^0x/, ""),
    leafIndex: PENDING_LEAF_INDEX,
    amount: amountStroops,
    spent: false,
    createdAt: Date.now(),
    poolId,
  };
}

/** Records a confirmed deposit in the local commitment cache. */
function recordDeposit(note: ShieldedNote, leafIndex: number): void {
  saveDeposit({
    commitment: note.commitment,
    leafIndex,
    timestamp: Date.now(),
    poolId: note.poolId!,
  });
}

/**
 * Deposit confirmation modal. Defined at module scope rather than inside
 * DepositPage so its component type is stable across renders — a component
 * created during render is remounted on every parent update.
 */
function ConfirmDeposit({
  amountStroops,
  estimatedFee,
  isLoading,
  onCancel,
  onConfirm,
}: {
  amountStroops: string;
  estimatedFee: string;
  isLoading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Card className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm z-50">
      <div className="max-w-md w-full bg-zinc-900 p-6 rounded-xl border border-zinc-700 shadow-lg">
        <h2 className="text-lg font-semibold mb-4 text-zinc-200">
          Confirm Deposit
        </h2>
        <p className="text-sm text-zinc-400 mb-2">
          Shielding:{" "}
          <span className="font-medium text-zinc-200">
            {formatAmount(amountStroops)}
          </span>
        </p>
        <p className="text-sm text-zinc-400 mb-4">
          Estimated fee:{" "}
          <span className="font-medium text-zinc-200">
            {formatAmountBare(estimatedFee)} XLM
          </span>
        </p>
        <div className="flex gap-4 justify-end">
          <Button variant="outline" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isLoading}>
            Confirm
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function DepositPage() {
  const { address, signTransaction } = useWallet();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [sessionNotes, setSessionNotes] = useState<ShieldedNote[]>([]);
  const [copiedKey, setCopiedKey] = useState<string>("");
  const [shareOpenKey, setShareOpenKey] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const poolId = getPoolId();
  // New UI state for confirmation step
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedFee, setEstimatedFee] = useState<string>("");
  const [pendingTx, setPendingTx] = useState<StellarSdk.Transaction | null>(
    null,
  );
  // Note built during the deposit call, held until the user confirms and signs.
  const pendingNoteRef = useRef<ShieldedNote | null>(null);
  // Amount as of the moment the transaction was built. `amount` is cleared
  // before the user confirms, so the modal can't read it directly.
  const [confirmStroops, setConfirmStroops] = useState<string>("0");

  const amountStroops = usdcToStroops(amount);
  const amountTooLarge = BigInt(amountStroops) > BigInt(MAX_NOTE_STROOPS);
  const amountValid =
    amount.trim() !== "" && BigInt(amountStroops) > BigInt(0) && !amountTooLarge;

  /**
   * Build the transaction up to the point of signing, then store it for
   * confirmation. This performs all pre-sign checks, constructs the Stellar
   * transaction, extracts the fee, and presents a confirmation UI before the
   * wallet is prompted.
   */
  async function handleDeposit() {
    if (!address || !poolId || !amountValid) return;

    setIsLoading(true);
    setSessionNotes([]);
    const stroops = amountStroops;

    try {
      // --- Pre-sign setup (trustline, faucet) ---
      const sac = getUsdcSacId();
      if (sac) {
        toast("Checking your USDC setup…");
        await ensureUsdcTrustline(address, signTransaction);
        const balVal = await queryContract(sac, "balance", [
          StellarSdk.nativeToScVal(address, { type: "address" }),
        ]);
        const balance = balVal
          ? BigInt(StellarSdk.scValToNative(balVal) as string | number)
          : BigInt(0);
        if (balance < BigInt(stroops)) {
          toast("Topping up your wallet with test USDC…");
          await faucetUsdc(address, BigInt(stroops) * BigInt(2) - balance);
        }
      }

      // --- Prepare the note ---
      // The note's value is hashed into its commitment, so the amount passed to
      // the contract and the amount inside the commitment have to be the same
      // string. Both come from `stroops` for exactly that reason.
      const note = await buildNote(poolId, stroops);

      // Build the transaction (no signing yet)
      const tx = await buildContractCall(
        poolId,
        "deposit",
        [
          StellarSdk.nativeToScVal(address, { type: "address" }),
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(note.commitment, "hex")),
          StellarSdk.nativeToScVal(BigInt(stroops), { type: "i128" }),
        ],
        address,
      );

      setEstimatedFee(tx.fee.toString());
      setPendingTx(tx);
      pendingNoteRef.current = note;
      setConfirmStroops(stroops);
      setShowConfirm(true);
    } catch (err) {
      console.error("Deposit error:", err);
      toast(friendlyError(err), "error");
    } finally {
      setIsLoading(false);
      setAmount("");
    }
  }

  /**
   * Called after the user confirms the deposit. Signs the stored transaction,
   * submits it, and performs the existing post-sign logic.
   */
  async function signAndSubmit() {
    const note = pendingNoteRef.current;
    if (!pendingTx || !address || !note) return;
    setIsLoading(true);
    try {
      const signedXdr = await signTransaction(pendingTx.toXDR());
      toast("Sending to the network…");
      await submitTransaction(signedXdr);

      // Store first, then settle the leaf index from the chain: the note is
      // the only key to the funds, so it must exist locally before anything
      // that can fail.
      saveNote(note);
      const leafIndex = await fetchLeafIndex(note);
      if (leafIndex !== null) {
        setNoteLeafIndex(note.commitment, leafIndex);
        recordDeposit(note, leafIndex);
      }
      setSessionNotes([{ ...note, leafIndex: leafIndex ?? PENDING_LEAF_INDEX }]);

      toast(
        `${formatAmount(note.amount)} is now shielded — save your note below!`,
        "success",
      );
    } catch (err) {
      console.error("Deposit error:", err);
      toast(friendlyError(err), "error");
    } finally {
      setIsLoading(false);
      setShowConfirm(false);
      setPendingTx(null);
      pendingNoteRef.current = null;
    }
  }

  function copyText(text: string, key: string) {
    try {
      void navigator.clipboard?.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((c) => (c === key ? "" : c)), 1500);
    } catch (err) {
      console.error("Copy to clipboard failed:", err);
      toast("Couldn't copy to clipboard — please copy it manually.", "error");
    }
  }

  function downloadBackup() {
    const body = sessionNotes.map(serializeNote).join("\n") + "\n";
    const blob = new Blob([body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dshield-notes-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!address) {
    return (
      <ConnectGate
        title="Deposit"
        prompt="Connect your wallet to shield USDC and receive a private note."
      />
    );
  }

  return (
    <PageShell>
      <PageHeader
        title="Deposit"
        description="Move any amount of USDC into the shielded pool. You'll receive a private note — the only key to withdrawing those funds later. Nothing on-chain links the deposit to a later withdrawal."
      />

      <Card className="mt-8">
        <div className="mb-6">
          <h3 className="text-sm font-medium text-zinc-400">How it works</h3>
          <ol className="mt-3 space-y-2 text-sm text-zinc-500">
            <li>
              1. Enter any amount — the pool holds notes of every size, so
              there&apos;s nothing to round to
            </li>
            <li>
              2. Your {TOKEN_SYMBOL} moves into the shielded pool in one signed
              transaction
            </li>
            <li>
              3. You receive a private note, saved on this device — back it up
              right away
            </li>
            <li>
              4. Withdraw the whole note, or part of it — the remainder is
              re-shielded into a fresh note you can spend from again
            </li>
          </ol>
        </div>

        <div className="mb-4">
          <Input
            type="text"
            inputMode="decimal"
            label={`Amount (${TOKEN_SYMBOL})`}
            mono
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            hint={(() => {
              if (amount.trim() === "") {
                return "Any amount. You can withdraw it in as many pieces as you like.";
              }
              if (amountTooLarge) {
                return `Too large — a single note holds at most ${formatAmount(MAX_NOTE_STROOPS)}.`;
              }
              if (BigInt(amountStroops) <= BigInt(0)) {
                return "Enter an amount greater than zero.";
              }
              return (
                <>
                  Shields{" "}
                  <span className="text-zinc-400">
                    {formatAmount(amountStroops)}
                  </span>{" "}
                  into one note.
                </>
              );
            })()}
          />
        </div>

        <Button
          fullWidth
          size="lg"
          onClick={handleDeposit}
          disabled={isLoading || !poolId || !amountValid}
        >
          {isLoading
            ? "Processing..."
            : !poolId
              ? "Pool not configured"
              : amountValid
                ? `Shield ${formatAmount(amountStroops)}`
                : `Enter an amount`}
        </Button>

        {sessionNotes.length > 0 && (
          <div className="animate-fade-up mt-4 space-y-3">
            <div className="rounded-xl border border-yellow-600/40 bg-yellow-950/20 p-3">
              <p className="text-xs font-semibold text-yellow-300">
                Back up your shielded note
                {sessionNotes.length > 1 ? "s" : ""}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-yellow-200/70">
                This note is the <span className="font-medium">only</span> way to
                withdraw these funds. It&apos;s saved in this browser, but if you
                clear site data or switch devices it&apos;s gone for good. Copy it
                or download the backup and keep it somewhere safe and private —
                anyone with the note can spend it.
              </p>
            </div>

            {sessionNotes.map((note, i) => {
              const serialized = serializeNote(note);
              const shareLink = generateNoteLink(note);
              const shareOpen = shareOpenKey === note.commitment;
              const xText = encodeURIComponent(
                "Claim your DShield payment — open this link to withdraw:\n" + shareLink,
              );
              const tgUrl =
                "https://t.me/share/url?url=" +
                encodeURIComponent(shareLink) +
                "&text=" +
                encodeURIComponent("Your DShield payment — click to claim:");
              return (
                <div
                  key={note.commitment}
                  className="rounded-xl bg-zinc-800/80 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs text-zinc-500">
                      Shielded Note
                      {sessionNotes.length > 1
                        ? ` ${i + 1}/${sessionNotes.length}`
                        : ""}{" "}
                      · {formatAmount(note.amount)}
                    </p>
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        type="button"
                        onClick={() => copyText(serialized, note.commitment)}
                        className="text-xs font-medium text-brand-400 hover:text-brand-300"
                      >
                        {copiedKey === note.commitment ? "Copied!" : "Copy note"}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setShareOpenKey((k) =>
                            k === note.commitment ? "" : note.commitment,
                          )
                        }
                        className="text-xs font-medium text-zinc-400 hover:text-white"
                      >
                        {shareOpen ? "Close" : "Share"}
                      </button>
                    </div>
                  </div>
                  <p className="mt-1.5 break-all font-mono text-xs text-zinc-200">
                    {serialized}
                  </p>
                  <p className="mt-2 break-all font-mono text-[11px] text-zinc-600">
                    Commitment: {note.commitment}
                  </p>

                  {shareOpen && (
                    <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 p-3">
                      <p className="text-xs font-medium text-zinc-300">
                        Share to claim
                      </p>
                      <p className="mt-1 text-[11px] text-yellow-400/80">
                        Warning: this link contains your private note. Anyone who
                        opens it can withdraw the funds — share only with the
                        intended recipient via a private channel.
                      </p>
                      <p className="mt-2 break-all font-mono text-[11px] text-zinc-500">
                        {shareLink}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            copyText(shareLink, `link:${note.commitment}`)
                          }
                          title={
                            copiedKey === `link:${note.commitment}`
                              ? "Copied!"
                              : "Copy link"
                          }
                          className="rounded-lg border border-zinc-600 p-2 text-zinc-300 hover:border-zinc-400 hover:text-white"
                        >
                          <CopyIcon className="h-4 w-4" />
                        </button>
                        <a
                          href={tgUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Telegram"
                          className="rounded-lg border border-zinc-600 p-2 text-zinc-300 hover:border-zinc-400 hover:text-white"
                        >
                          <TelegramIcon className="h-4 w-4" />
                        </a>
                        <a
                          href={
                            "https://wa.me/?text=" +
                            encodeURIComponent(
                              "Your DShield payment — click to claim: " +
                                shareLink,
                            )
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          title="WhatsApp"
                          className="rounded-lg border border-zinc-600 p-2 text-zinc-300 hover:border-zinc-400 hover:text-white"
                        >
                          <WhatsAppIcon className="h-4 w-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => {
                            const confirmed = window.confirm(
                              "This will be PUBLIC on X — anyone who sees it can steal these funds. Continue?",
                            );
                            if (!confirmed) return;
                            window.open(
                              `https://x.com/intent/tweet?text=${xText}`,
                              "_blank",
                              "noopener,noreferrer",
                            );
                          }}
                          title="X (public) — posts your private note publicly"
                          className="rounded-lg border border-zinc-600 p-2 text-zinc-300 hover:border-zinc-400 hover:text-white"
                        >
                          <XIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            <Button variant="outline" fullWidth onClick={downloadBackup}>
              {sessionNotes.length > 1
                ? `Download all ${sessionNotes.length} notes (.txt)`
                : "Download note backup (.txt)"}
            </Button>
          </div>
        )}
      </Card>

      {showConfirm && (
        <ConfirmDeposit
          amountStroops={confirmStroops}
          estimatedFee={estimatedFee}
          isLoading={isLoading}
          onCancel={() => {
            // Discard the staged transaction and note: nothing was signed or
            // submitted, so these must not leak into a later confirmation.
            setShowConfirm(false);
            setPendingTx(null);
            pendingNoteRef.current = null;
          }}
          onConfirm={signAndSubmit}
        />
      )}
    </PageShell>
  );
}
