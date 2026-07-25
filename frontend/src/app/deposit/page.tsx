"use client";

import { useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import {
  buildContractCall,
  submitTransaction,
  queryContract,
  getPoolTiers,
  ensureUsdcTrustline,
  faucetUsdc,
  getUsdcSacId,
  type PoolTier,
} from "@/lib/stellar";
import {
  saveNote,
  serializeNote,
  generateNoteLink,
  generateRandomField,
  type ShieldedNote,
} from "@/lib/notes";
import { saveDeposit } from "@/lib/deposits";
import { computeCommitment } from "@/lib/poseidon2";
import { TOKEN_DECIMALS, TOKEN_SYMBOL, formatStroops } from "@/lib/format";
import { friendlyError } from "@/lib/errors";
import { PageShell, PageHeader, ConnectGate } from "@/components/ui/Page";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { SelectButton } from "@/components/ui/SelectButton";
import {
  CopyIcon,
  TelegramIcon,
  WhatsAppIcon,
  XIcon,
} from "@/components/icons";
import { useToast } from "@/components/ui/Toast";
import * as StellarSdk from "@stellar/stellar-sdk";

export default function DepositPage() {
  const { address, signTransaction } = useWallet();
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [sessionNotes, setSessionNotes] = useState<ShieldedNote[]>([]);
  const [copiedKey, setCopiedKey] = useState<string>("");
  const [shareOpenKey, setShareOpenKey] = useState<string>("");
  const [customAmount, setCustomAmount] = useState<string>("");
  const [tiers] = useState<PoolTier[]>(() => getPoolTiers());
  const [selectedTier, setSelectedTier] = useState<PoolTier | null>(() => {
    const t = getPoolTiers();
    return t.length > 0 ? t[0] : null;
  });

  const noteCount = (() => {
    if (!customAmount || !selectedTier) return 1;
    const usdc = parseFloat(customAmount);
    if (isNaN(usdc) || usdc <= 0) return 0;
    const tierUsdc = selectedTier.amount / 10 ** TOKEN_DECIMALS;
    return Math.floor(usdc / tierUsdc);
  })();

  const totalNotes = customAmount ? noteCount : 1;

  async function handleDeposit() {
    if (!address || !selectedTier || totalNotes <= 0) return;

    setIsLoading(true);
    setSessionNotes([]);
    const total = totalNotes;
    const created: ShieldedNote[] = [];

    try {
      // Make sure the connected wallet can actually hold and pay USDC:
      // establish the trustline (wallet signs) and faucet test funds if short.
      // Both are no-ops once satisfied.
      const sac = getUsdcSacId();
      if (sac) {
        toast("Checking your USDC setup…");
        await ensureUsdcTrustline(address, signTransaction);

        const needed = selectedTier.amount * total;
        const balVal = await queryContract(sac, "balance", [
          StellarSdk.nativeToScVal(address, { type: "address" }),
        ]);
        const balance = balVal
          ? BigInt(StellarSdk.scValToNative(balVal) as string | number)
          : BigInt(0);
        if (balance < BigInt(needed)) {
          toast("Topping up your wallet with test USDC…");
          // Mint a generous buffer so subsequent deposits don't re-faucet.
          await faucetUsdc(address, BigInt(needed) * BigInt(2) - balance);
        }
      }

      // Generate every note's secrets and commitment up front. The leaf index
      // each note will land on is read once from the chain (the next free slot)
      // and assigned sequentially — exactly how the contract inserts them — so a
      // single batched deposit yields the same indices as repeated deposits.
      const nextIndexVal = await queryContract(
        selectedTier.id,
        "get_next_index",
      );
      const firstIndex = nextIndexVal
        ? Number(StellarSdk.scValToNative(nextIndexVal))
        : 0;

      const pending: ShieldedNote[] = [];
      for (let n = 0; n < total; n++) {
        const nullifier = generateRandomField();
        const secret = generateRandomField();
        const commitment = await computeCommitment(nullifier, secret);
        const commitmentClean = commitment.replace(/^0x/, "");
        pending.push({
          nullifier,
          secret,
          commitment: commitmentClean,
          leafIndex: firstIndex + n,
          amount: String(selectedTier.amount),
          spent: false,
          createdAt: Date.now(),
          poolId: selectedTier.id,
        });
      }

      const depositorScVal = StellarSdk.nativeToScVal(address, {
        type: "address",
      });
      const commitmentScVals = pending.map((note) =>
        StellarSdk.xdr.ScVal.scvBytes(Buffer.from(note.commitment, "hex")),
      );

      // One contract call → one signature, whether shielding 1 note or many.
      // `deposit_batch` transfers the full amount and inserts every commitment
      // atomically; a single-element batch behaves exactly like `deposit`.
      const tx =
        total === 1
          ? await buildContractCall(
              selectedTier.id,
              "deposit",
              [depositorScVal, commitmentScVals[0]],
              address,
            )
          : await buildContractCall(
              selectedTier.id,
              "deposit_batch",
              [depositorScVal, StellarSdk.xdr.ScVal.scvVec(commitmentScVals)],
              address,
            );

      toast(
        total > 1
          ? `Shielding ${total} notes — please sign once in your wallet…`
          : "Please sign the transaction in your wallet…",
      );
      const signedXdr = await signTransaction(tx.toXDR());

      toast("Sending to the network…");
      await submitTransaction(signedXdr);

      for (const note of pending) {
        saveNote(note);
        created.push(note);
        saveDeposit({
          commitment: note.commitment,
          leafIndex: note.leafIndex,
          timestamp: Date.now(),
          poolId: selectedTier.id,
        });
      }

      setSessionNotes(created);

      const totalUsdc = (total * selectedTier.amount) / 10 ** TOKEN_DECIMALS;
      toast(
        total > 1
          ? `${totalUsdc} ${TOKEN_SYMBOL} shielded across ${total} notes — save your notes below!`
          : `${totalUsdc} ${TOKEN_SYMBOL} is now shielded — save your note below!`,
        "success",
      );
    } catch (err) {
      console.error("Deposit error:", err);
      toast(friendlyError(err), "error");
    } finally {
      setIsLoading(false);
      setCustomAmount("");
    }
  }

  function copyText(text: string, key: string) {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((c) => (c === key ? "" : c)), 1500);
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
        description="Move USDC into the shielded pool. You'll receive a private note — the only key to withdrawing your funds later. Nothing on-chain links the deposit to your identity or balance."
      />

      <Card className="mt-8">
        <div className="mb-6">
          <h3 className="text-sm font-medium text-zinc-400">How it works</h3>
          <ol className="mt-3 space-y-2 text-sm text-zinc-500">
            <li>
              1. Choose an amount — deposits use fixed sizes so they blend in
              with everyone else&apos;s
            </li>
            <li>
              2. Your {TOKEN_SYMBOL} moves into the shielded pool in one signed
              transaction
            </li>
            <li>
              3. You receive a private note, saved on this device — back it up
              right away
            </li>
          </ol>
        </div>

        {tiers.length > 1 && (
          <div className="mb-4">
            <legend className="mb-2 block text-xs text-zinc-500">
              Select Denomination
            </legend>
            <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {tiers.map((tier) => (
                <SelectButton
                  key={tier.id}
                  selected={selectedTier?.id === tier.id}
                  onClick={() => setSelectedTier(tier)}
                  disabled={isLoading}
                  className="text-center font-medium"
                  aria-label={`${tier.label} denomination`}
                >
                  {tier.label}
                </SelectButton>
              ))}
            </fieldset>
          </div>
        )}

        {selectedTier && (
          <div className="mb-4">
            <Input
              type="number"
              label={`Amount (${TOKEN_SYMBOL})`}
              mono
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              placeholder={String(selectedTier.amount / 10 ** TOKEN_DECIMALS)}
              min={selectedTier.amount / 10 ** TOKEN_DECIMALS}
              step={selectedTier.amount / 10 ** TOKEN_DECIMALS}
              hint={(() => {
                if (!customAmount) {
                  return `Leave empty for a single ${formatStroops(selectedTier.amount)} deposit. Enter a larger amount to create multiple notes.`;
                }
                const usdc = parseFloat(customAmount);
                const tierUsdc = selectedTier.amount / 10 ** TOKEN_DECIMALS;
                if (isNaN(usdc) || usdc < tierUsdc) {
                  return `Minimum: ${tierUsdc} ${TOKEN_SYMBOL}`;
                }
                const shielded = noteCount * tierUsdc;
                const remainder = usdc - shielded;
                return (
                  <>
                    Creates{" "}
                    <span className="text-zinc-400">
                      {noteCount} note{noteCount > 1 ? "s" : ""}
                    </span>{" "}
                    of {formatStroops(selectedTier.amount)} each
                    {" = "}
                    <span className="text-zinc-400">
                      {shielded} {TOKEN_SYMBOL}
                    </span>{" "}
                    shielded
                    {remainder > 0 && (
                      <span className="text-yellow-500">
                        {" "}
                        ({remainder} {TOKEN_SYMBOL} remainder not shielded)
                      </span>
                    )}
                  </>
                );
              })()}
            />
          </div>
        )}

        <Button
          fullWidth
          size="lg"
          onClick={handleDeposit}
          disabled={
            isLoading || !selectedTier || (!!customAmount && noteCount <= 0)
          }
        >
          {isLoading
            ? "Processing..."
            : selectedTier
              ? customAmount && noteCount > 1
                ? `Shield ${(noteCount * selectedTier.amount) / 10 ** TOKEN_DECIMALS} ${TOKEN_SYMBOL} (${noteCount} notes)`
                : `Shield ${formatStroops(selectedTier.amount)}`
              : "Select a denomination"}
        </Button>

        {sessionNotes.length > 0 && (
          <div className="animate-fade-up mt-4 space-y-3">
            <div className="rounded-xl border border-yellow-600/40 bg-yellow-950/20 p-3">
              <p className="text-xs font-semibold text-yellow-300">
                Back up your shielded note
                {sessionNotes.length > 1 ? "s" : ""}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-yellow-200/70">
                This note is the <span className="font-medium">only</span> way
                to withdraw these funds. It&apos;s saved in this browser, but if
                you clear site data or switch devices it&apos;s gone for good.
                Copy it or download the backup and keep it somewhere safe and
                private — anyone with the note can spend it.
              </p>
            </div>

            {sessionNotes.map((note, i) => {
              const serialized = serializeNote(note);
              const shareLink = generateNoteLink(note);
              const shareOpen = shareOpenKey === note.commitment;
              const xText = encodeURIComponent(
                "Claim your DShield payment — open this link to withdraw:\n" +
                  shareLink,
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
                      · {formatStroops(Number(note.amount))}
                    </p>
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        type="button"
                        onClick={() => copyText(serialized, note.commitment)}
                        className="text-xs font-medium text-brand-400 hover:text-brand-300"
                      >
                        {copiedKey === note.commitment
                          ? "Copied!"
                          : "Copy note"}
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
                        Warning: this link contains your private note. Anyone
                        who opens it can withdraw the funds — share only with
                        the intended recipient via a private channel.
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
                        <a
                          href={`https://x.com/intent/tweet?text=${xText}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="X (public)"
                          className="rounded-lg border border-zinc-600 p-2 text-zinc-300 hover:border-zinc-400 hover:text-white"
                        >
                          <XIcon className="h-4 w-4" />
                        </a>
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
    </PageShell>
  );
}
