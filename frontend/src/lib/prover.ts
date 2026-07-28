import poolCircuit from "@/circuits/shielded_pool.json";
import complianceCircuit from "@/circuits/compliance.json";
import disclosureCircuit from "@/circuits/disclosure.json";
import { runProof, type ProofResult, type ProofStage } from "./prover-core";
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

export async function proveWithdrawal(
  inputs: {
    nullifier: string;
    secret: string;
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
      root: ensureHex(inputs.root),
      nullifier_hash: ensureHex(inputs.nullifierHash),
      recipient: ensureHex(inputs.recipientHash),
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
      amount: inputs.amount,
      auditor_key: ensureHex(inputs.auditorKey),
      merkle_root: ensureHex(inputs.merkleRoot),
      kyc_hash: ensureHex(inputs.kycHash),
      disclosed_amount: inputs.disclosedAmount,
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
      amount: inputs.amount,
      auditor_key: ensureHex(inputs.auditorKey),
      merkle_root: ensureHex(inputs.merkleRoot),
      kyc_hash: ensureHex(inputs.kycHash),
      threshold: inputs.threshold,
      path_bits: inputs.pathBits.map(String),
      path_siblings: inputs.pathSiblings.map(ensureHex),
    },
    onProgress,
  );
}

function ensureHex(v: string): string {
  if (v.startsWith("0x")) return v;
  return "0x" + v;
}
