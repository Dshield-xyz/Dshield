import {
  POOL_CIRCUIT,
  COMPLIANCE_CIRCUIT,
  DISCLOSURE_CIRCUIT,
  buildWithdrawalWitness,
  buildComplianceWitness,
  buildDisclosureWitness,
  type ProofResult,
  type ProofStage,
  type WithdrawalProofInputs,
  type ComplianceProofInputs,
  type DisclosureProofInputs,
} from "@dshield/core/prover";
import { runProof } from "@dshield/core/prover-core";
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
 *
 * The circuits and the witness field mapping both come from @dshield/core, so
 * the browser and the `dshield` CLI feed the exact same circuit an identical
 * witness — only the execution host (Worker here, direct call in the CLI)
 * differs.
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
 * `changeSecret`. See {@link WithdrawalProofInputs} in @dshield/core for the
 * field contract (amounts are decimal strings, not hex).
 */
export async function proveWithdrawal(
  inputs: WithdrawalProofInputs,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(POOL_CIRCUIT, buildWithdrawalWitness(inputs), onProgress);
}

export async function proveCompliance(
  inputs: ComplianceProofInputs,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    COMPLIANCE_CIRCUIT,
    buildComplianceWitness(inputs),
    onProgress,
  );
}

export async function proveDisclosure(
  inputs: DisclosureProofInputs,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    DISCLOSURE_CIRCUIT,
    buildDisclosureWitness(inputs),
    onProgress,
  );
}
