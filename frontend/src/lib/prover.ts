import poolCircuit from "@/circuits/shielded_pool.json";
import complianceCircuit from "@/circuits/compliance.json";
import disclosureCircuit from "@/circuits/disclosure.json";
import viewDisclosureCircuit from "@/circuits/view_disclosure.json";
import { runProof, verifyProof, type ProofResult, type ProofStage } from "./prover-core";
import type { ProverWorkerRequest, ProverWorkerResponse } from "./prover.worker";

export type { ProofResult, ProofStage };

let worker: Worker | null = null;
let nextRequestId = 0;

function getWorker(): Worker | null {
  if (typeof Worker === "undefined") return null;
  if (!worker) {
    worker = new Worker(new URL("./prover.worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return worker;
}

/**
 * Runs proof generation in a Web Worker so the main thread (and the UI's
 * spinner/animations) stays responsive. Falls back to running inline when
 * Workers aren't available (SSR, unit tests).
 */
async function generateProof(
  circuit: Record<string, unknown>,
  inputs: Record<string, string | string[]>,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  const w = getWorker();
  if (!w) {
    return runProof(circuit, inputs, onProgress);
  }

  const id = ++nextRequestId;

  return new Promise<ProofResult>((resolve, reject) => {
    function onMessage(event: MessageEvent<ProverWorkerResponse>) {
      const data = event.data;
      if (data.id !== id) return;

      if (data.type === "progress") {
        onProgress?.(data.stage);
      } else if (data.type === "done") {
        cleanup();
        resolve({ proof: data.proof, publicInputs: data.publicInputs });
      } else if (data.type === "error") {
        cleanup();
        reject(new Error(data.message));
      }
    }

    function onError(event: ErrorEvent) {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error(event.message));
    }

    function cleanup() {
      w!.removeEventListener("message", onMessage);
      w!.removeEventListener("error", onError);
    }

    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);

    const request: ProverWorkerRequest = { id, circuit, inputs };
    w.postMessage(request);
  });
}

/**
 * Proves a spend of one note: `withdrawAmount` of its `amount` is paid out and
 * the remainder is re-shielded into a new note under `changeNullifier` /
 * `changeSecret`.
 *
 * A change note is always produced, even for a full withdrawal where the
 * remainder is zero, so that a full and a partial spend are indistinguishable
 * on-chain. The caller must therefore always store the change note — see the
 * withdraw page, which saves it before submitting.
 *
 * Amounts are decimal strings of token base units. They must not be hex: Noir
 * would read a `0x`-prefixed amount as a different number than the contract's
 * big-endian byte decoding does, and the payout would silently disagree with
 * what the note is worth.
 */
export async function proveWithdrawal(
  inputs: {
    nullifier: string;
    secret: string;
    amount: string;
    withdrawAmount: string;
    changeNullifier: string;
    changeSecret: string;
    changeCommitment: string;
    root: string;
    nullifierHash: string;
    recipientHash: string;
    pathSiblings: string[];
    pathBits: number[];
  },
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    poolCircuit as Record<string, unknown>,
    {
      nullifier: ensureHex(inputs.nullifier),
      secret: ensureHex(inputs.secret),
      amount: decimal(inputs.amount),
      change_nullifier: ensureHex(inputs.changeNullifier),
      change_secret: ensureHex(inputs.changeSecret),
      root: ensureHex(inputs.root),
      nullifier_hash: ensureHex(inputs.nullifierHash),
      recipient: ensureHex(inputs.recipientHash),
      withdraw_amount: decimal(inputs.withdrawAmount),
      change_commitment: ensureHex(inputs.changeCommitment),
      path_bits: inputs.pathBits.map(String),
      path_siblings: inputs.pathSiblings.map(ensureHex),
    },
    onProgress,
  );
}

export async function proveCompliance(
  inputs: {
    kycPreimage: string;
    nullifier: string;
    secret: string;
    amount: string;
    auditorKey: string;
    merkleRoot: string;
    kycHash: string;
    disclosedAmount: string;
    pathSiblings: string[];
    pathBits: number[];
  },
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    complianceCircuit as Record<string, unknown>,
    {
      kyc_preimage: ensureHex(inputs.kycPreimage),
      nullifier: ensureHex(inputs.nullifier),
      secret: ensureHex(inputs.secret),
      amount: decimal(inputs.amount),
      auditor_key: ensureHex(inputs.auditorKey),
      merkle_root: ensureHex(inputs.merkleRoot),
      kyc_hash: ensureHex(inputs.kycHash),
      disclosed_amount: decimal(inputs.disclosedAmount),
      path_bits: inputs.pathBits.map(String),
      path_siblings: inputs.pathSiblings.map(ensureHex),
    },
    onProgress,
  );
}

export async function proveDisclosure(
  inputs: {
    kycPreimage: string;
    nullifier: string;
    secret: string;
    amount: string;
    auditorKey: string;
    merkleRoot: string;
    kycHash: string;
    threshold: string;
    pathSiblings: string[];
    pathBits: number[];
  },
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    disclosureCircuit as Record<string, unknown>,
    {
      kyc_preimage: ensureHex(inputs.kycPreimage),
      nullifier: ensureHex(inputs.nullifier),
      secret: ensureHex(inputs.secret),
      amount: decimal(inputs.amount),
      auditor_key: ensureHex(inputs.auditorKey),
      merkle_root: ensureHex(inputs.merkleRoot),
      kyc_hash: ensureHex(inputs.kycHash),
      threshold: decimal(inputs.threshold),
      path_bits: inputs.pathBits.map(String),
      path_siblings: inputs.pathSiblings.map(ensureHex),
    },
    onProgress,
  );
}

/**
 * Proves a note's `amount` to whoever was handed `viewKey` out of band,
 * without revealing `nullifier`/`secret` or exposing spend capability. The
 * witness still needs `nullifier` to reconstruct the note's leaf and walk it
 * to `merkleRoot`, but the circuit never outputs or constrains it against
 * anything public — see circuits/view_disclosure/src/main.nr.
 */
export async function proveViewDisclosure(
  inputs: {
    nullifier: string;
    secret: string;
    amount: string;
    viewKey: string;
    merkleRoot: string;
    pathSiblings: string[];
    pathBits: number[];
  },
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    viewDisclosureCircuit as Record<string, unknown>,
    {
      nullifier: ensureHex(inputs.nullifier),
      secret: ensureHex(inputs.secret),
      amount: decimal(inputs.amount),
      view_key: ensureHex(inputs.viewKey),
      merkle_root: ensureHex(inputs.merkleRoot),
      path_bits: inputs.pathBits.map(String),
      path_siblings: inputs.pathSiblings.map(ensureHex),
    },
    onProgress,
  );
}

/**
 * Verifies a view-disclosure proof entirely client-side — no wallet, no
 * transaction, no pool indexer lookup. Used by the auditor-facing `/audit`
 * page, where the verifier may have nothing but the proof they were handed.
 */
export async function verifyViewDisclosure(
  proofHex: string,
  publicInputsHex: string,
): Promise<boolean> {
  return verifyProof(
    viewDisclosureCircuit as Record<string, unknown>,
    proofHex,
    publicInputsHex,
  );
}

function ensureHex(v: string): string {
  if (v.startsWith("0x")) return v;
  return "0x" + v;
}

/** Normalizes an amount to the plain decimal form Noir reads as a number. */
function decimal(v: string): string {
  return BigInt(v).toString(10);
}
