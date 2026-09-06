import * as StellarSdk from "@stellar/stellar-sdk";
import {
  computeCommitment,
  computeNullifierHash,
  computeRecipientHash,
  buildMerkleTree,
  assetToField,
} from "@dshield/core/poseidon2";
import {
  parseNote,
  serializeNote,
  generateRandomField,
  PENDING_LEAF_INDEX,
  type ShieldedNote,
} from "@dshield/core/notes";
import { proveWithdrawal } from "@dshield/core/prover";
import { fetchAssetInfo } from "@dshield/core/assets";
import { toBaseUnits, formatUnits } from "@dshield/core/format";
import type { Context } from "../context";
import { loadWallet } from "../wallet";
import {
  ensureTrustline,
  fetchCommitments,
  getCommitmentIndex,
  getRoot,
  hasTrustline,
  invoke,
  isNullifierUsed,
} from "../stellar";

/**
 * Relayer fee carved out of the note by the circuit.
 *
 * Zero: the CLI submits from the user's own wallet, so there is no relayer to
 * pay. It is still a required circuit input — the constraint is
 * `payout + fee + change == amount` — and the change note's value below must be
 * computed with the same figure, or the proof simply won't verify.
 */
const RELAYER_FEE = BigInt(0);

export interface WithdrawOptions {
  /** A serialized note string. Mutually exclusive with --commitment. */
  note?: string;
  /** A stored note's commitment (0x-optional hex). */
  commitment?: string;
  /** Recipient G-address. Defaults to the signing wallet. */
  to?: string;
  /** Partial amount in USDC. Omit to withdraw the whole note. */
  amount?: string;
}

export async function withdrawCommand(
  opts: WithdrawOptions,
  ctx: Context,
): Promise<void> {
  const { config, store, out } = ctx;

  // ── Resolve the note to spend ──
  let note: ShieldedNote | undefined;
  if (opts.note) {
    const parsed = parseNote(opts.note);
    if (!parsed) throw new Error("Could not parse the provided note string.");
    note = store.find(parsed.commitment) ?? parsed;
  } else if (opts.commitment) {
    note = store.find(opts.commitment);
    if (!note) {
      throw new Error(
        `No stored note with commitment ${opts.commitment}. Pass the note directly with --note.`,
      );
    }
  } else {
    throw new Error("Specify the note to withdraw with --note <string> or --commitment <hex>.");
  }

  const poolId = note.poolId || config.poolId;
  if (!poolId) throw new Error("No pool configured for this note (pass --pool <C…>).");

  const wallet = loadWallet(config);
  const recipient = opts.to?.trim() || wallet.publicKey;

  // ── Settle the leaf index if the note is still pending ──
  if (note.leafIndex < 0) {
    const idx = await getCommitmentIndex(config, poolId, note.commitment);
    if (idx === null) {
      throw new Error(
        "This note's deposit hasn't been confirmed on-chain yet (no leaf index). Try again shortly.",
      );
    }
    note = { ...note, leafIndex: idx };
  }

  // Amounts are read and printed at the note's own asset precision.
  const asset = await fetchAssetInfo(
    { rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase },
    note.asset,
  );
  const show = (units: string | bigint) =>
    formatUnits(units, asset.symbol, asset.decimals);

  const noteValue = BigInt(note.amount);
  const payout = opts.amount
    ? BigInt(toBaseUnits(opts.amount, asset.decimals))
    : noteValue;
  if (payout <= BigInt(0) || payout + RELAYER_FEE > noteValue) {
    throw new Error(
      `This note is worth ${show(note.amount)} — withdraw amount must be between 0 and that.`,
    );
  }
  const changeValue = (noteValue - payout - RELAYER_FEE).toString();

  // ── Pre-flight checks ──
  out.step("Checking note status…");
  const nullifierHash = await computeNullifierHash(note.nullifier);
  if (await isNullifierUsed(config, poolId, nullifierHash)) {
    throw new Error("This note has already been withdrawn.");
  }

  out.step("Syncing with the pool…");
  const onChainRoot = await getRoot(config, poolId);
  if (!onChainRoot) throw new Error("No deposits in this pool yet.");
  const commitments = await fetchCommitments(config, poolId);
  if (!commitments || commitments.length === 0) {
    throw new Error("Couldn't load the pool's commitment set from the network.");
  }
  const merkle = await buildMerkleTree(commitments, note.leafIndex);
  if (merkle.root.toLowerCase() !== onChainRoot.toLowerCase()) {
    throw new Error(
      "Local Merkle root disagrees with the pool — the note's leaf index may be stale.",
    );
  }

  // The recipient must be able to hold the note's own asset (skipped when
  // re-shielding a zero payout, which moves nothing out of the pool). Native
  // XLM needs no trustline, which ensureTrustline/hasTrustline handle.
  if (payout > BigInt(0)) {
    if (recipient === wallet.publicKey) {
      await ensureTrustline(config, note.asset, wallet);
    } else if (!(await hasTrustline(config, note.asset, recipient))) {
      throw new Error(
        `Recipient ${recipient} can't receive ${asset.symbol} yet — they need a trustline for it.`,
      );
    }
  }

  // ── Prove ──
  out.step("Generating the zero-knowledge proof — this can take about a minute…");
  const recipientHash = await computeRecipientHash(recipient);
  const changeNote = await buildChangeNote(poolId, changeValue, note.asset);

  const { proof, publicInputs } = await proveWithdrawal(
    {
      nullifier: note.nullifier,
      secret: note.secret,
      amount: note.amount,
      asset: assetToField(note.asset),
      withdrawAmount: payout.toString(),
      relayerFee: RELAYER_FEE.toString(),
      changeNullifier: changeNote.nullifier,
      changeSecret: changeNote.secret,
      changeCommitment: changeNote.commitment,
      root: onChainRoot,
      nullifierHash,
      recipientHash,
      pathSiblings: merkle.pathSiblings,
      pathBits: merkle.pathBits,
    },
    (stage) => out.step(stage === "executing" ? "Executing the circuit…" : "Creating the proof…"),
  );

  // Save the change note BEFORE submitting: the proof already commits to its
  // leaf, so the moment the tx lands the remainder exists on-chain and these
  // are the only keys to it.
  store.add(changeNote);

  // ── Submit ──
  out.step("Sending to the network…");
  // withdraw(recipient, asset, public_inputs, proof, fee_amount, fee_min_out,
  // fee_recipient). The asset is named so the contract can check it against the
  // one the proof commits to; the fee arguments are zero because this is a
  // self-submitted withdrawal (see RELAYER_FEE).
  const txHash = await invoke(config, wallet, poolId, "withdraw", [
    StellarSdk.nativeToScVal(recipient, { type: "address" }),
    StellarSdk.nativeToScVal(note.asset, { type: "address" }),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
    StellarSdk.nativeToScVal(BigInt(0), { type: "i128" }),
    StellarSdk.nativeToScVal(BigInt(0), { type: "i128" }),
    StellarSdk.nativeToScVal(wallet.publicKey, { type: "address" }),
  ]);

  // Settle local state: the spent note is retired, the change note gets its leaf.
  if (store.find(note.commitment)) store.markSpent(note.commitment);
  const changeIdx = await getCommitmentIndex(config, poolId, changeNote.commitment);
  if (changeIdx !== null) store.setLeafIndex(changeNote.commitment, changeIdx);

  const reshielded = BigInt(changeValue) > BigInt(0);
  out.result(
    [
      `Withdrew ${show(payout)} to ${recipient} — tx ${txHash}`,
      reshielded
        ? `${show(changeValue)} re-shielded into a new note (save it):\n${serializeNote(changeNote)}`
        : `Note fully spent (a zero-value change note was created for indistinguishability).`,
    ].join("\n"),
    {
      txHash,
      recipient,
      withdrawn: payout.toString(),
      change: changeValue,
      changeNote: reshielded ? serializeNote(changeNote) : null,
    },
  );
}

/** Mint the change note for a spend: a fresh note worth whatever the payout leaves. */
async function buildChangeNote(
  poolId: string,
  changeValue: string,
  asset: string,
): Promise<ShieldedNote> {
  const nullifier = generateRandomField();
  const secret = generateRandomField();
  const commitment = (
    await computeCommitment(nullifier, secret, changeValue, assetToField(asset))
  ).replace(
    /^0x/,
    "",
  );
  return {
    nullifier,
    secret,
    commitment,
    leafIndex: PENDING_LEAF_INDEX,
    amount: changeValue,
    // Change is always denominated in the asset that was spent — the circuit
    // hashes the same asset field into the change leaf, so it could not be
    // anything else.
    asset,
    spent: false,
    createdAt: Date.now(),
    poolId,
  };
}
