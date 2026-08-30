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

/**
 * Verifies a proof entirely client-side, against the same circuit bytecode
 * `runProof` used to generate it. Lets a verifier (an auditor who was handed
 * a view-disclosure proof out of band) check it with no wallet, no gas, and
 * no trust in whoever relays it — only the circuit's own math.
 *
 * `proofHex`/`publicInputsHex` are the same hex encoding `runProof` returns:
 * `publicInputsHex` is the public inputs packed back-to-back as 32-byte (64
 * hex char) chunks with no separators, so it is split back into individual
 * field elements here.
 */
export async function verifyProof(
  circuit: Record<string, unknown>,
  proofHex: string,
  publicInputsHex: string,
): Promise<boolean> {
  const backend = new UltraHonkBackend(
    (circuit as { bytecode: string }).bytecode,
  );
  try {
    const proof = Uint8Array.from(Buffer.from(proofHex, "hex"));
    const publicInputs: string[] = [];
    for (let i = 0; i < publicInputsHex.length; i += 64) {
      publicInputs.push("0x" + publicInputsHex.slice(i, i + 64));
    }
    return await backend.verifyProof({ proof, publicInputs }, { keccak: true });
  } finally {
    await backend.destroy();
  }
}
