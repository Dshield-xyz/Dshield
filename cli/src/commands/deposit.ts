import * as StellarSdk from "@stellar/stellar-sdk";
import { computeCommitment, assetToField } from "@dshield/core/poseidon2";
import {
  generateRandomField,
  serializeNote,
  PENDING_LEAF_INDEX,
  type ShieldedNote,
} from "@dshield/core/notes";
import { fetchAssetInfo, isNativeAsset, type AssetInfo } from "@dshield/core/assets";
import { toBaseUnits, formatUnits, DEFAULT_DECIMALS } from "@dshield/core/format";
import type { Context } from "../context";
import { loadWallet, loadIssuerKeypair } from "../wallet";
import {
  assetBalance,
  ensureTrustline,
  fetchPoolAssets,
  getCommitmentIndex,
  getConfiguredAssetId,
  invoke,
  mintTestAsset,
} from "../stellar";

// Largest value a single note may carry, matching the pool contract's
// MAX_NOTE_AMOUNT (u64::MAX stroops).
const MAX_NOTE_STROOPS = BigInt(2) ** BigInt(64) - BigInt(1);

export interface DepositOptions {
  amount: string;
  /**
   * SEP-41 asset to shield (contract address, or a symbol matching one the pool
   * allow-lists). Defaults to the pool's first allow-listed asset.
   */
  asset?: string;
  dryRun?: boolean;
}

/**
 * Resolves which asset to shield.
 *
 * The pool's allow-list is the authority, so `--asset` is matched against it
 * rather than trusted: shielding into an asset the pool doesn't hold would mint
 * a note the pool will never pay out.
 *
 * `offline` skips every network call, for `--dry-run`, which is documented as
 * building a note without touching the network. In that mode the asset must be
 * named as a contract id (or come from the configured classic asset), since
 * resolving a symbol means reading the allow-list, and its precision falls back
 * to the 7-decimal SAC convention — so a dry run against a token of another
 * precision prints a differently-scaled figure than a real deposit would.
 */
export async function resolveDepositAsset(
  ctx: Context,
  requested: string | undefined,
  poolId: string | undefined,
  offline = false,
): Promise<AssetInfo> {
  const { config } = ctx;
  const chain = { rpcUrl: config.rpcUrl, networkPassphrase: config.networkPassphrase };

  if (offline) {
    const id = requested ?? getConfiguredAssetId(config);
    if (!id || !StellarSdk.StrKey.isValidContract(id)) {
      throw new Error(
        "--dry-run can't look up an asset by symbol (that needs the network). " +
          "Pass --asset <C…>, or configure a classic asset.",
      );
    }
    return {
      contractId: id,
      symbol: `${id.slice(0, 4)}…${id.slice(-4)}`,
      decimals: DEFAULT_DECIMALS,
      native: isNativeAsset(id, config.networkPassphrase),
    };
  }

  const allowed = poolId ? await fetchPoolAssets(config, poolId) : [];

  if (!requested) {
    const fallback = allowed[0] ?? getConfiguredAssetId(config);
    if (!fallback) {
      throw new Error(
        "Could not determine which asset to shield — pass --asset <C…> " +
          "(the pool's allow-list was empty or unreadable).",
      );
    }
    return fetchAssetInfo(chain, fallback);
  }

  // An address is used as given; anything else is matched by symbol against
  // the allow-list, so `--asset XLM` works without pasting a contract id.
  if (StellarSdk.StrKey.isValidContract(requested)) {
    if (allowed.length > 0 && !allowed.includes(requested)) {
      throw new Error(`This pool does not accept ${requested}.`);
    }
    return fetchAssetInfo(chain, requested);
  }

  const infos = await Promise.all(allowed.map((a) => fetchAssetInfo(chain, a)));
  const match = infos.find(
    (i) => i.symbol.toLowerCase() === requested.toLowerCase(),
  );
  if (!match) {
    const known = infos.map((i) => i.symbol).join(", ") || "none";
    throw new Error(
      `This pool does not accept "${requested}". Allow-listed assets: ${known}.`,
    );
  }
  return match;
}

export async function depositCommand(
  opts: DepositOptions,
  ctx: Context,
): Promise<void> {
  const { config, store, out } = ctx;

  const asset = await resolveDepositAsset(
    ctx,
    opts.asset,
    config.poolId,
    opts.dryRun,
  );
  const show = (units: string | bigint) =>
    formatUnits(units, asset.symbol, asset.decimals);

  // Parsed at the asset's own precision: this string is both hashed into the
  // commitment and transferred on-chain, and the two must agree exactly.
  const stroops = toBaseUnits(opts.amount, asset.decimals);
  if (BigInt(stroops) <= BigInt(0)) {
    throw new Error(`Enter an amount greater than zero (got "${opts.amount}").`);
  }
  if (BigInt(stroops) > MAX_NOTE_STROOPS) {
    throw new Error(
      `Too large — a single note holds at most ${show(MAX_NOTE_STROOPS)}.`,
    );
  }

  // The note's value is hashed into its commitment, so the amount passed to the
  // contract and the amount inside the commitment are the same string.
  const nullifier = generateRandomField();
  const secret = generateRandomField();
  const commitment = (
    await computeCommitment(nullifier, secret, stroops, assetToField(asset.contractId))
  ).replace(/^0x/, "");
  const note: ShieldedNote = {
    nullifier,
    secret,
    commitment,
    leafIndex: PENDING_LEAF_INDEX,
    amount: stroops,
    asset: asset.contractId,
    spent: false,
    createdAt: Date.now(),
    poolId: config.poolId || undefined,
  };

  if (opts.dryRun) {
    store.add(note);
    out.step(
      `Dry run — built and saved a ${show(stroops)} note offline; nothing was submitted.`,
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

  // Funding: establish the trustline (a no-op for XLM) and, on test networks,
  // mint the configured test asset when the balance is short — the same top-up
  // the app gets from its server-side faucet, signed by the issuer key this CLI
  // holds.
  out.step(`Checking ${asset.symbol} setup…`);
  await ensureTrustline(config, asset.contractId, wallet);
  const balance = await assetBalance(config, asset.contractId, wallet.publicKey);
  if (balance < BigInt(stroops)) {
    const issuer = loadIssuerKeypair(config);
    const mintable = asset.contractId === getConfiguredAssetId(config);
    if (!issuer || !mintable) {
      throw new Error(
        `Account holds ${show(balance)} but the deposit needs ${show(stroops)}. ` +
          (mintable
            ? "Fund it, or pass --issuer-secret to mint test funds."
            : `Fund the account with ${asset.symbol} first.`),
      );
    }
    const topUp = BigInt(stroops) * BigInt(2) - balance;
    out.step(`Minting ${show(topUp)} test ${asset.symbol}…`);
    await mintTestAsset(config, issuer, wallet.publicKey, topUp);
  }

  out.step(`Shielding ${show(stroops)}…`);
  const txHash = await invoke(config, wallet, config.poolId, "deposit", [
    StellarSdk.nativeToScVal(wallet.publicKey, { type: "address" }),
    StellarSdk.nativeToScVal(asset.contractId, { type: "address" }),
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

  out.step(`${show(stroops)} is now shielded.`);
  out.result(
    [
      `Deposited ${show(stroops)} — tx ${txHash}`,
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
      asset: asset.contractId,
      symbol: asset.symbol,
    },
  );
}
