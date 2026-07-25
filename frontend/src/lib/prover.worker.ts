import { runProof, type ProofStage } from "./prover-core";

export interface ProverWorkerRequest {
  id: number;
  circuit: Record<string, unknown>;
  inputs: Record<string, string | string[]>;
}

export type ProverWorkerResponse =
  | { id: number; type: "progress"; stage: ProofStage }
  | { id: number; type: "done"; proof: string; publicInputs: string }
  | { id: number; type: "error"; message: string };

self.onmessage = async (event: MessageEvent<ProverWorkerRequest>) => {
  const { id, circuit, inputs } = event.data;

  try {
    const result = await runProof(circuit, inputs, (stage) => {
      const message: ProverWorkerResponse = { id, type: "progress", stage };
      self.postMessage(message);
    });
    const message: ProverWorkerResponse = {
      id,
      type: "done",
      proof: result.proof,
      publicInputs: result.publicInputs,
    };
    self.postMessage(message);
  } catch (err) {
    const message: ProverWorkerResponse = {
      id,
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(message);
  }
};
