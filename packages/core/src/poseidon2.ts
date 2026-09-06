import { Noir } from "@noir-lang/noir_js";
import * as StellarSdk from "@stellar/stellar-sdk";
import hasherCircuit from "./circuits/hasher.json" with { type: "json" };

// Domain separation tags for Poseidon2 hashing (must match circuit definitions)
const LEAF_DOMAIN = "0x4c454146";
const NULLIFIER_DOMAIN = "0x4e554c4c";
const KYC_DOMAIN = "0x4b5943";

let noirInstance: InstanceType<typeof Noir> | null = null;

async function getHasher(): Promise<InstanceType<typeof Noir>> {
  if (!noirInstance) {
    noirInstance = new Noir(hasherCircuit as never);
  }
  return noirInstance;
}

/**
 * Left-pad a field element to a canonical 32-byte (64 hex char) 0x-prefixed
 * string. The Noir hasher returns field values WITHOUT leading-zero padding
 * (e.g. a root whose top byte is 0x00 comes back as "0x301b…" not "0x00301b…").
 * On-chain the same value is always a full 32-byte BytesN<32>, so comparing the
 * two as raw strings — or slicing them into a Buffer for an ScVal — silently
 * breaks (~1/256 of values) unless both sides are normalized to 32 bytes.
 */
export function normalizeField(v: string): string {
  const hex = v.replace(/^0x/, "").toLowerCase();
  if (hex.length > 64) {
    throw new Error(`field element exceeds 32 bytes: ${v}`);
  }
  return "0x" + hex.padStart(64, "0");
}

export async function poseidon2Hash(a: string, b: string): Promise<string> {
  const noir = await getHasher();
  const result = await noir.execute({ a, b });
  return normalizeField(result.returnValue as string);
}

/**
 * Order of the BN254 scalar field the circuits and the pool contract compute
 * in. Anything hashed as a `Field` has to be reduced into this range first.
 */
export const BN254_SCALAR_MODULUS = BigInt(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
);

/**
 * Derives the field element a note commits to for `asset`, from the SEP-41
 * token's 32-byte contract id.
 *
 * This MUST match the pool contract's `asset_id_from_address`, which reduces
 * the id modulo the BN254 scalar field before comparing it to the proof's
 * `asset` public input. The reduction is not a formality: the field's order is
 * a little over 2^254 while a contract id is a full 256 bits, so roughly four
 * out of five real Stellar contract addresses — the testnet XLM SAC among them
 * — are larger than the modulus. Skipping it produces a note whose leaf commits
 * to a different asset than the contract derives, and the pool rejects the
 * withdrawal with AssetMismatch: the funds are shielded and unspendable.
 *
 * Takes the raw contract id bytes rather than the C… string so the shared
 * package stays free of an SDK dependency at this layer; callers decode the
 * strkey (`StrKey.decodeContract`) first.
 */
export function assetFieldFromContractId(
  contractId: Uint8Array | Buffer,
): string {
  if (contractId.length !== 32) {
    throw new Error(
      `contract id must be 32 bytes, got ${contractId.length}`,
    );
  }
  const hex = Buffer.from(contractId).toString("hex");
  const reduced = BigInt("0x" + hex) % BN254_SCALAR_MODULUS;
  return normalizeField(reduced.toString(16));
}

/**
 * {@link assetFieldFromContractId} for an asset written as a Stellar contract
 * address (C…).
 *
 * A note that came back from the compact link format may instead carry a bare
 * field element, if its 32 bytes weren't a valid strkey; that is accepted too,
 * reduced the same way, so re-deriving such a note's commitment still works.
 */
export function assetToField(asset: string): string {
  try {
    return assetFieldFromContractId(StellarSdk.StrKey.decodeContract(asset));
  } catch {
    const value = BigInt(asset.startsWith("0x") ? asset : "0x" + asset);
    return normalizeField((value % BN254_SCALAR_MODULUS).toString(16));
  }
}

/**
 * Note commitment: `H(H(H(H(LEAF_DOMAIN, nullifier), secret), amount), asset)`.
 *
 * The chain of two-input hashes is not an approximation of a wider hash — it
 * is the definition, matched exactly by the Noir circuits' `hash_leaf` and by
 * the pool contract's `poseidon2_hash2`. All three must agree byte for byte or
 * a note becomes unspendable, so the shape is deliberately the lowest common
 * denominator: the only Poseidon2 primitive all three can compute is the
 * two-input one.
 *
 * `amount` is the note's value in the asset's base units, as a decimal string.
 * Binding it here is what lets one pool hold notes of any size and lets a spend
 * pay out part of a note.
 *
 * `asset` is the field element of the SEP-41 token's contract address (see
 * {@link assetFieldFromContractId}). Binding it is what lets a single pool hold
 * notes for many assets: a proof for asset A cannot open a note committing to
 * asset B, so notes of different assets stay isolated even while sharing one
 * tree and nullifier set.
 */
export async function computeCommitment(
  nullifier: string,
  secret: string,
  amount: string | bigint,
  asset: string,
): Promise<string> {
  const domainAndNullifier = await poseidon2Hash(LEAF_DOMAIN, toField(nullifier));
  const withSecret = await poseidon2Hash(domainAndNullifier, toField(secret));
  const withAmount = await poseidon2Hash(withSecret, toAmountField(amount));
  return poseidon2Hash(withAmount, toField(asset));
}

export async function computeNullifierHash(
  nullifier: string,
): Promise<string> {
  // H(H(NULLIFIER_DOMAIN, nullifier), 0)
  const domainAndNullifier = await poseidon2Hash(NULLIFIER_DOMAIN, toField(nullifier));
  return poseidon2Hash(domainAndNullifier, "0x00");
}

/** KYC commitment: `H(H(KYC_DOMAIN, preimage), 0)` — matches `hash_kyc`. */
export async function computeKycHash(preimage: string): Promise<string> {
  const domainAndPreimage = await poseidon2Hash(KYC_DOMAIN, toField(preimage));
  return poseidon2Hash(domainAndPreimage, "0x00");
}

/**
 * Encodes a token amount as a field element. Noir reads an unprefixed decimal
 * string as a number, so amounts are passed through as decimals rather than
 * hex — a hex-looking amount would be silently reinterpreted.
 */
export function toAmountField(amount: string | bigint): string {
  return BigInt(amount).toString(10);
}

function toField(hex: string): string {
  if (hex.startsWith("0x")) return hex;
  return "0x" + hex;
}

const TREE_DEPTH = 20;

let zeroHashesCache: string[] | null = null;

export async function getZeroHashes(): Promise<string[]> {
  if (zeroHashesCache) return zeroHashesCache;
  const zeroes: string[] = [];
  let cur = "0x" + "00".repeat(32);
  zeroes.push(cur);
  for (let i = 0; i < TREE_DEPTH; i++) {
    cur = await poseidon2Hash(cur, cur);
    zeroes.push(cur);
  }
  zeroHashesCache = zeroes;
  return zeroes;
}

export interface MerkleProof {
  root: string;
  pathSiblings: string[];
  pathBits: number[];
}

export async function buildMerkleTree(
  commitments: string[],
  targetIndex: number,
): Promise<MerkleProof> {
  const zeroes = await getZeroHashes();
  const n = commitments.length;

  const leaves: string[] = [];
  for (let i = 0; i < Math.max(n, targetIndex + 1); i++) {
    leaves.push(i < n ? ensureHex(commitments[i]) : zeroes[0]);
  }

  let currentLevel = leaves;
  const pathSiblings: string[] = [];
  const pathBits: number[] = [];
  let targetIdx = targetIndex;

  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    const bit = targetIdx & 1;
    pathBits.push(bit);

    const siblingIdx = targetIdx ^ 1;
    if (siblingIdx < currentLevel.length) {
      pathSiblings.push(currentLevel[siblingIdx]);
    } else {
      pathSiblings.push(zeroes[depth]);
    }

    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : zeroes[depth];
      nextLevel.push(await poseidon2Hash(left, right));
    }

    if (nextLevel.length === 0) {
      nextLevel.push(zeroes[depth + 1]);
    }

    currentLevel = nextLevel;
    targetIdx = targetIdx >> 1;
  }

  return {
    root: currentLevel[0],
    pathSiblings,
    pathBits,
  };
}

export async function computeRecipientHash(
  stellarAddress: string,
): Promise<string> {
  const StellarSdk = await import("@stellar/stellar-sdk");
  const keypair = StellarSdk.Keypair.fromPublicKey(stellarAddress);
  const rawKey = keypair.rawPublicKey();
  const lo = "0x00" + Buffer.from(rawKey.slice(0, 15)).toString("hex");
  const hi = "0x00" + Buffer.from(rawKey.slice(15)).toString("hex");
  return poseidon2Hash(lo, hi);
}

function ensureHex(v: string): string {
  if (v.startsWith("0x")) return v;
  return "0x" + v;
}
