import { describe, it, expect, vi, beforeEach } from "vitest";
import { proveWithdrawal, proveViewDisclosure } from "./prover";

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
  asset: "0xb",
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

    expect(executeMock).toHaveBeenCalledWith({
      nullifier: "0x1",
      secret: "0x2",
      amount: "1000000",
      asset: "0xb",
      change_nullifier: "0x8",
      change_secret: "0x9",
      root: "0x3",
      nullifier_hash: "0x4",
      recipient: "0x5",
      withdraw_amount: "400000",
      change_commitment: "0xa",
      path_bits: ["0", "1"],
      path_siblings: ["0x6", "0x7"],
    });
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

const VIEW_DISCLOSURE_INPUTS = {
  nullifier: "1",
  secret: "2",
  amount: "1000000",
  viewKey: "0x3",
  merkleRoot: "0x4",
  pathSiblings: ["6", "0x7"],
  pathBits: [0, 1],
};

describe("proveViewDisclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({ witness: new Uint8Array() });
    generateProofMock.mockResolvedValue({
      proof: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      publicInputs: ["0x1", "0xabc"],
    });
  });

  it("hex-prefixes note fields before passing them to Noir.execute", async () => {
    await proveViewDisclosure(VIEW_DISCLOSURE_INPUTS);

    expect(executeMock).toHaveBeenCalledWith({
      nullifier: "0x1",
      secret: "0x2",
      amount: "1000000",
      view_key: "0x3",
      merkle_root: "0x4",
      path_bits: ["0", "1"],
      path_siblings: ["0x6", "0x7"],
    });
  });

  it("never passes nullifier or secret as part of any public/output value", async () => {
    // The point of a viewing key is that a verifier only ever sees
    // merkle_root/view_key/amount. Nothing in this call path should leak
    // nullifier/secret into anything other than the private witness map.
    await proveViewDisclosure(VIEW_DISCLOSURE_INPUTS);

    const call = executeMock.mock.calls.at(-1)![0];
    expect(Object.keys(call).sort()).toEqual(
      ["amount", "merkle_root", "nullifier", "path_bits", "path_siblings", "secret", "view_key"].sort(),
    );
  });

  it("passes amount as a plain decimal, never hex", async () => {
    await proveViewDisclosure({ ...VIEW_DISCLOSURE_INPUTS, amount: "0xc8" });

    const call = executeMock.mock.calls.at(-1)![0];
    expect(call.amount).toBe("200");
  });

  it("destroys the backend even when proving fails", async () => {
    generateProofMock.mockRejectedValueOnce(new Error("boom"));

    await expect(proveViewDisclosure(VIEW_DISCLOSURE_INPUTS)).rejects.toThrow("boom");

    expect(destroyMock).toHaveBeenCalledOnce();
  });
});
