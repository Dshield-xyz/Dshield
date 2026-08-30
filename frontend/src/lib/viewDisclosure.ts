import * as StellarSdk from "@stellar/stellar-sdk";
import { POOL_CONTRACT_ID, queryContract } from "./stellar";
import { deriveViewingKey, type ShieldedNote } from "./notes";
import { fetchCommitmentsFromChain } from "./indexer";
import { buildMerkleTree } from "./poseidon2";
import { proveViewDisclosure, verifyViewDisclosure, type ProofStage } from "./prover";

/**
 * Everything a note holder hands to a chosen verifier (an auditor, a
 * bookkeeper, a co-signer) to prove one note's amount. Deliberately omits
 * `nullifier`/`secret` — see docs/THREAT_MODEL.md's key-separation section —
 * so sharing this bundle can never expose spend capability over the note.
 */
export interface ViewDisclosureBundle {
  v: 1;
  poolId: string;
  merkleRoot: string;
  viewKey: string;
  amount: string;
  proof: string;
  publicInputs: string;
  generatedAt: number;
}

/**
 * Builds a view-disclosure proof bundle for `note`. Requires the note's full
 * secret material (this function runs on the note holder's device, never the
 * verifier's) to reconstruct its Merkle membership, but the circuit itself
 * never outputs `nullifier` — the bundle this returns is safe to hand to
 * anyone the holder has shared `viewKey` with out of band.
 */
export async function buildViewDisclosureProof(
  note: ShieldedNote,
  onProgress?: (stage: ProofStage) => void,
): Promise<ViewDisclosureBundle> {
  const poolId = note.poolId || POOL_CONTRACT_ID;
  if (!poolId) throw new Error("No pool configured for this note.");
  if (note.leafIndex < 0) {
    throw new Error("This note's leaf index hasn't been resolved yet — wait for it to confirm on-chain.");
  }

  const viewKey = await deriveViewingKey(note.secret);

  const commitments = await fetchCommitmentsFromChain(poolId);
  if (!commitments || commitments.length === 0) {
    throw new Error("Couldn't load the pool's deposit history.");
  }

  const merkle = await buildMerkleTree(commitments, note.leafIndex);

  const { proof, publicInputs } = await proveViewDisclosure(
    {
      nullifier: note.nullifier,
      secret: note.secret,
      amount: note.amount,
      viewKey,
      merkleRoot: merkle.root,
      pathSiblings: merkle.pathSiblings,
      pathBits: merkle.pathBits,
    },
    onProgress,
  );

  return {
    v: 1,
    poolId,
    merkleRoot: merkle.root,
    viewKey,
    amount: note.amount,
    proof,
    publicInputs,
    generatedAt: Date.now(),
  };
}

/** Inverse of `JSON.stringify` on a {@link ViewDisclosureBundle}. Returns null if malformed. */
export function parseViewDisclosureBundle(json: string): ViewDisclosureBundle | null {
  try {
    const parsed = JSON.parse(json);
    if (
      parsed &&
      parsed.v === 1 &&
      typeof parsed.poolId === "string" &&
      typeof parsed.merkleRoot === "string" &&
      typeof parsed.viewKey === "string" &&
      typeof parsed.amount === "string" &&
      typeof parsed.proof === "string" &&
      typeof parsed.publicInputs === "string"
    ) {
      return parsed as ViewDisclosureBundle;
    }
    return null;
  } catch {
    return null;
  }
}

export interface ViewDisclosureVerification {
  /** Whether the ZK proof itself verifies against the view_disclosure circuit. */
  proofValid: boolean;
  /**
   * Whether `merkleRoot` is a root the pool contract actually reached, or
   * null if that check couldn't be completed (RPC unreachable, unknown pool).
   * A valid proof against an unknown root only proves internal consistency,
   * not that the note is real — this is what turns it into a statement about
   * an actual DShield pool.
   */
  rootKnown: boolean | null;
}

/**
 * Verifies a shared {@link ViewDisclosureBundle} entirely from public data:
 * the proof itself (client-side, via the circuit's own verifier) and the
 * claimed Merkle root (against the pool contract's on-chain state). Safe to
 * run with nothing but what the bundle contains — no wallet, no secrets.
 */
export async function verifyViewDisclosureBundle(
  bundle: ViewDisclosureBundle,
): Promise<ViewDisclosureVerification> {
  const proofValid = await verifyViewDisclosure(bundle.proof, bundle.publicInputs);

  let rootKnown: boolean | null = null;
  try {
    const rootHex = bundle.merkleRoot.replace(/^0x/, "");
    const result = await queryContract(bundle.poolId, "is_known_root", [
      StellarSdk.xdr.ScVal.scvBytes(Buffer.from(rootHex, "hex")),
    ]);
    if (result) rootKnown = StellarSdk.scValToNative(result) === true;
  } catch {
    rootKnown = null;
  }

  return { proofValid, rootKnown };
}
