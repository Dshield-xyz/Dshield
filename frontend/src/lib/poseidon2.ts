import { Noir } from "@noir-lang/noir_js";
import hasherCircuit from "@/circuits/hasher.json";

// Domain separation tags for Poseidon2 hashing (must match circuit definitions)
const LEAF_DOMAIN = "0x4c454146";
const NULLIFIER_DOMAIN = "0x4e554c4c";
const KYC_DOMAIN = "0x4b5943";
const VIEW_DOMAIN = "0x56494557";

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
 * Note commitment: `H(H(H(LEAF_DOMAIN, nullifier), secret), amount)`.
 *
 * The chain of two-input hashes is not an approximation of a wider hash — it
 * is the definition, matched exactly by the Noir circuits' `hash_leaf` and by
 * the pool contract's `poseidon2_hash2`. All three must agree byte for byte or
 * a note becomes unspendable, so the shape is deliberately the lowest common
 * denominator: the only Poseidon2 primitive all three can compute is the
 * two-input one.
 *
 * `amount` is the note's value in token base units (stroops), as a decimal
 * string. Binding it here is what lets one pool hold notes of any size and lets
 * a spend pay out part of a note.
 */
export async function computeCommitment(
  nullifier: string,
  secret: string,
  amount: string | bigint,
): Promise<string> {
  const domainAndNullifier = await poseidon2Hash(LEAF_DOMAIN, toField(nullifier));
  const withSecret = await poseidon2Hash(domainAndNullifier, toField(secret));
  return poseidon2Hash(withSecret, toAmountField(amount));
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
 * Viewing key: `H(H(VIEW_DOMAIN, secret), 0)` — matches the `view_disclosure`
 * circuit's `hash_view_key`. Deliberately a function of `secret` alone, never
 * `nullifier`, so handing this value to an auditor or bookkeeper can never
 * expose spend-capable material — see docs/THREAT_MODEL.md.
 */
export async function computeViewKey(secret: string): Promise<string> {
  const domainAndSecret = await poseidon2Hash(VIEW_DOMAIN, toField(secret));
  return poseidon2Hash(domainAndSecret, "0x00");
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
