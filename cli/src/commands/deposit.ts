import * as StellarSdk from "@stellar/stellar-sdk";
import { computeCommitment } from "@dshield/core/poseidon2";
import {
  generateRandomField,
  serializeNote,
  PENDING_LEAF_INDEX,
  type ShieldedNote,
} from "@dshield/core/notes";
import { usdcToStroops, formatAmount } from "@dshield/core/format";
import type { Context } from "../context";
import { loadWallet, loadIssuerKeypair } from "../wallet";
import {
  ensureUsdcTrustline,
  getCommitmentIndex,
  getUsdcSacId,
  invoke,
  mintUsdc,
  usdcBalance,
} from "../stellar";

// Largest value a single note may carry, matching the pool contract's
// MAX_NOTE_AMOUNT (u64::MAX stroops).
const MAX_NOTE_STROOPS = BigInt(2) ** BigInt(64) - BigInt(1);

export interface DepositOptions {
  amount: string;
  dryRun?: boolean;
}

export async function depositCommand(
  opts: DepositOptions,
  ctx: Context,
): Promise<void> {
  const { config, store, out } = ctx;

  const stroops = usdcToStroops(opts.amount);
  if (BigInt(stroops) <= BigInt(0)) {
    throw new Error(`Enter an amount greater than zero (got "${opts.amount}").`);
  }
  if (BigInt(stroops) > MAX_NOTE_STROOPS) {
    throw new Error(
      `Too large — a single note holds at most ${formatAmount(MAX_NOTE_STROOPS.toString())}.`,
    );
  }

  // The note's value is hashed into its commitment, so the amount passed to the
  // contract and the amount inside the commitment are the same string.
  const nullifier = generateRandomField();
  const secret = generateRandomField();
  const commitment = (await computeCommitment(nullifier, secret, stroops)).replace(
    /^0x/,
    "",
  );
  const note: ShieldedNote = {
    nullifier,
    secret,
    commitment,
    leafIndex: PENDING_LEAF_INDEX,
    amount: stroops,
    spent: false,
    createdAt: Date.now(),
    poolId: config.poolId || undefined,
  };

  if (opts.dryRun) {
    store.add(note);
    out.step(
      `Dry run — built and saved a ${formatAmount(stroops)} note offline; nothing was submitted.`,
    );
    out.result(
      [
        `Note (save this — it is the only key to the funds):`,
        serializeNote(note),
        ``,
        `Commitment: ${note.commitment}`,
      ].join("\n"),
      { dryRun: true, note: serializeNote(note), commitment: note.commitment, amount: stroops },
    );
    return;
  }

  if (!config.poolId) {
    throw new Error(
      "No pool configured. Pass --pool <C…>, set DSHIELD_POOL_ID, or run from a " +
        "repo with a deployed frontend/.env.local.",
    );
  }

  const wallet = loadWallet(config);

  // Funding: establish the trustline and, on test networks, mint test USDC when
  // the balance is short (mirrors the app's faucet, but signed by the issuer key
  // this CLI holds).
  if (getUsdcSacId(config)) {
    out.step("Checking USDC setup…");
    await ensureUsdcTrustline(config, wallet);
    const balance = await usdcBalance(config, wallet.publicKey);
    if (balance < BigInt(stroops)) {
      const issuer = loadIssuerKeypair(config);
      if (!issuer) {
        throw new Error(
          `Account holds ${formatAmount(balance.toString())} but the deposit needs ` +
            `${formatAmount(stroops)}. Fund it, or pass --issuer-secret to mint test USDC.`,
        );
      }
      const topUp = BigInt(stroops) * BigInt(2) - balance;
      out.step(`Minting ${formatAmount(topUp.toString())} test USDC…`);
      await mintUsdc(config, issuer, wallet.publicKey, topUp);
    }
  }

  out.step(`Shielding ${formatAmount(stroops)}…`);
  const txHash = await invoke(config, wallet, config.poolId, "deposit", [
    StellarSdk.nativeToScVal(wallet.publicKey, { type: "address" }),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(note.commitment, "hex")),
    StellarSdk.nativeToScVal(BigInt(stroops), { type: "i128" }),
  ]);

  // Store the note before anything else that can fail — it is the only key to
  // the funds now shielded on-chain.
  store.add(note);

  // Settle the real leaf index from the pool (the pre-sign prediction can be
  // taken by another transaction that confirms first).
  const leafIndex = await getCommitmentIndex(config, config.poolId, note.commitment);
  if (leafIndex !== null) {
    store.setLeafIndex(note.commitment, leafIndex);
    note.leafIndex = leafIndex;
  }

  out.step(`${formatAmount(stroops)} is now shielded.`);
  out.result(
    [
      `Deposited ${formatAmount(stroops)} — tx ${txHash}`,
      leafIndex !== null ? `Leaf index: ${leafIndex}` : `Leaf index: pending (re-sync later)`,
      ``,
      `Note (save this — it is the only key to the funds):`,
      serializeNote(note),
    ].join("\n"),
    {
      txHash,
      leafIndex,
      note: serializeNote(note),
      commitment: note.commitment,
      amount: stroops,
    },
  );
}
