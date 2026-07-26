import { describe, it, expect, vi, beforeEach } from "vitest";
import { proveWithdrawal } from "./prover";

const executeMock = vi.fn();
const generateProofMock = vi.fn();
const destroyMock = vi.fn();

vi.mock("@noir-lang/noir_js", () => ({
  Noir: vi.fn().mockImplementation(function Noir() {
    return { execute: executeMock };
  }),
}));

vi.mock("@aztec/bb.js", () => ({
  UltraHonkBackend: vi.fn().mockImplementation(function UltraHonkBackend() {
    return { generateProof: generateProofMock, destroy: destroyMock };
  }),
}));

const VALID_INPUTS = {
  nullifier: "1",
  secret: "2",
  root: "0x3",
  nullifierHash: "4",
  recipientHash: "5",
  pathSiblings: ["6", "0x7"],
  pathBits: [0, 1],
};

describe("proveWithdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executeMock.mockResolvedValue({ witness: new Uint8Array() });
    generateProofMock.mockResolvedValue({
      proof: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      publicInputs: ["0x1", "0xabc"],
    });
  });

  // No Worker global exists in this test environment, so proveWithdrawal
  // takes the inline fallback path — this exercises the same runProof()
  // logic the Web Worker calls in the browser.
  it("reports 'executing' then 'proving' progress and returns the hex-encoded proof", async () => {
    const stages: string[] = [];

    const result = await proveWithdrawal(VALID_INPUTS, (stage) => stages.push(stage));

    expect(stages).toEqual(["executing", "proving"]);
    expect(result.proof).toBe("deadbeef");
    expect(result.publicInputs).toBe(
      "1".padStart(64, "0") + "abc".padStart(64, "0"),
    );
  });

  it("hex-prefixes note fields before passing them to Noir.execute", async () => {
    await proveWithdrawal(VALID_INPUTS);

    expect(executeMock).toHaveBeenCalledWith({
      nullifier: "0x1",
      secret: "0x2",
      root: "0x3",
      nullifier_hash: "0x4",
      recipient: "0x5",
      path_bits: ["0", "1"],
      path_siblings: ["0x6", "0x7"],
    });
  });

  it("destroys the backend even when proving fails", async () => {
    generateProofMock.mockRejectedValueOnce(new Error("boom"));

    await expect(proveWithdrawal(VALID_INPUTS)).rejects.toThrow("boom");

    expect(destroyMock).toHaveBeenCalledOnce();
  });
});
