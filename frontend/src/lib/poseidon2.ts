import { Noir } from "@noir-lang/noir_js";
import hasherCircuit from "@/circuits/hasher.json";

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

export async function computeCommitment(
  nullifier: string,
  secret: string,
): Promise<string> {
  // Hash with domain separation: hash3(LEAF_DOMAIN, nullifier, secret)
  const noir = await getHasher();
  const result = await noir.execute({
    a: LEAF_DOMAIN,
    b: toField(nullifier)
  });
  const leafHashAndSecret = result.returnValue as string;

  // Now hash with secret: hash2(hash3(LEAF_DOMAIN, nullifier, secret), secret)
  // This simulates hash3 by doing hash2(hash2(domain, nullifier), secret)
  const finalResult = await noir.execute({
    a: normalizeField(leafHashAndSecret),
    b: toField(secret)
  });
  return normalizeField(finalResult.returnValue as string);
}

export async function computeNullifierHash(
  nullifier: string,
): Promise<string> {
  // Hash with domain separation: hash3(NULLIFIER_DOMAIN, nullifier, 0)
  const noir = await getHasher();
  const result = await noir.execute({
    a: NULLIFIER_DOMAIN,
    b: toField(nullifier)
  });
  const domainAndNullifier = result.returnValue as string;

  // Now hash with 0: hash2(hash2(domain, nullifier), 0)
  // This simulates hash3 by doing hash2(hash2(domain, nullifier), 0)
  const finalResult = await noir.execute({
    a: normalizeField(domainAndNullifier),
    b: "0"
  });
  return normalizeField(finalResult.returnValue as string);
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
