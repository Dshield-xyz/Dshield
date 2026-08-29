import { describe, it, expect, vi, beforeEach } from "vitest";
import { proveWithdrawal } from "./prover";
import { POOL_CIRCUIT, buildWithdrawalWitness } from "@dshield/core/prover";

// The witness mapping + actual proving now live in @dshield/core (covered by
// its own tests). Here we test only the frontend wrapper: that it feeds the
// right circuit + witness into the shared runProof and forwards its result and
// progress. Mocking the runProof seam keeps this off the WASM prover.
const runProofMock = vi.fn();
vi.mock("@dshield/core/prover-core", () => ({
  runProof: (...args: unknown[]) => runProofMock(...args),
}));

const VALID_INPUTS = {
  nullifier: "1",
  secret: "2",
  amount: "1000000",
  withdrawAmount: "400000",
  changeNullifier: "8",
  changeSecret: "9",
  changeCommitment: "0xa",
  root: "0x3",
  nullifierHash: "4",
  recipientHash: "5",
  pathSiblings: ["6", "0x7"],
  pathBits: [0, 1],
};

describe("proveWithdrawal (frontend wrapper)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // No Worker global in this environment, so proveWithdrawal takes the inline
    // fallback and calls runProof directly.
    runProofMock.mockImplementation(
      async (
        _circuit: unknown,
        _inputs: unknown,
        onProgress?: (stage: string) => void,
      ) => {
        onProgress?.("executing");
        onProgress?.("proving");
        return { proof: "deadbeef", publicInputs: "abc" };
      },
    );
  });

  it("feeds the pool circuit and the core-built witness into runProof", async () => {
    await proveWithdrawal(VALID_INPUTS);

    expect(runProofMock).toHaveBeenCalledTimes(1);
    const [circuit, witness] = runProofMock.mock.calls[0];
    expect(circuit).toBe(POOL_CIRCUIT);
    expect(witness).toEqual(buildWithdrawalWitness(VALID_INPUTS));
  });

  it("forwards progress stages and returns runProof's result", async () => {
    const stages: string[] = [];
    const result = await proveWithdrawal(VALID_INPUTS, (s) => stages.push(s));

    expect(stages).toEqual(["executing", "proving"]);
    expect(result).toEqual({ proof: "deadbeef", publicInputs: "abc" });
  });

  it("propagates a proving failure", async () => {
    runProofMock.mockRejectedValueOnce(new Error("boom"));
    await expect(proveWithdrawal(VALID_INPUTS)).rejects.toThrow("boom");
  });
});
