import { describe, it, expect, vi, beforeEach } from "vitest";
import { proveWithdrawal, proveViewDisclosure } from "./prover";

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
      amount: "1000000",
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

  it("passes amounts as plain decimals, never hex", async () => {
    // Noir reads "0x400000" as 4194304, not 4000000. A hex-encoded amount would
    // make the circuit prove a payout different from the one the contract
    // decodes from the same public input, so the two must agree on decimal.
    await proveWithdrawal({ ...VALID_INPUTS, withdrawAmount: "0x64", amount: "0xc8" });

    const call = executeMock.mock.calls.at(-1)![0];
    expect(call.withdraw_amount).toBe("100");
    expect(call.amount).toBe("200");
  });

  it("destroys the backend even when proving fails", async () => {
    generateProofMock.mockRejectedValueOnce(new Error("boom"));

    await expect(proveWithdrawal(VALID_INPUTS)).rejects.toThrow("boom");

    expect(destroyMock).toHaveBeenCalledOnce();
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
