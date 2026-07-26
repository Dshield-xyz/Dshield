import { Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";

export interface ProofResult {
  proof: string;
  publicInputs: string;
}

/** Stages reported via `onProgress` while a proof is generated. */
export type ProofStage = "executing" | "proving";

/**
 * Runs the actual Noir witness execution + UltraHonk proof generation.
 * Both steps are CPU-intensive WASM calls that block whatever thread calls
 * them, so this is meant to be invoked from inside a Web Worker (see
 * `prover.worker.ts`) rather than directly from the UI thread.
 */
export async function runProof(
  circuit: Record<string, unknown>,
  inputs: Record<string, string | string[]>,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  const noir = new Noir(circuit as never);
  const backend = new UltraHonkBackend(
    (circuit as { bytecode: string }).bytecode,
  );

  try {
    onProgress?.("executing");
    const { witness } = await noir.execute(inputs as never);

    // The verification key and on-chain verifier are built with
    // `--oracle_hash keccak` (see tests/e2e.sh). The proof MUST be generated
    // with the matching keccak Fiat-Shamir transform, otherwise the on-chain
    // UltraHonk verifier rejects it (Contract #4 / VerificationFailed).
    onProgress?.("proving");
    const proof = await backend.generateProof(witness, { keccak: true });

    const proofHex = Buffer.from(proof.proof).toString("hex");
    const publicInputsHex = proof.publicInputs
      .map((pi: string) => pi.replace(/^0x/, "").padStart(64, "0"))
      .join("");

    return { proof: proofHex, publicInputs: publicInputsHex };
  } finally {
    await backend.destroy();
  }
}
