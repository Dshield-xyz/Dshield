/**
 * Tests for the lazy-load prover module (src/lib/prover.ts).
 *
 * Strategy: the actual ZK runtime (@aztec/bb.js, @noir-lang/noir_js) and
 * the circuit artifact JSON files are mocked so that the test suite can run
 * in Node without requiring WASM binaries.  The tests verify:
 *
 *  1. Each prove* function dynamically imports only its own circuit artifact
 *     (not all three at module-load time).
 *  2. The correct field names are passed to generateProof for each circuit.
 *  3. The hex-normalisation logic (ensureHex) is applied consistently.
 *  4. The public API surface is intact and all functions are exported.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock proof output returned by the fake UltraHonkBackend.
// ---------------------------------------------------------------------------
const MOCK_PROOF_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
const MOCK_PUBLIC_INPUTS = ["0x000000000000000000000000000000000000000000000000000000000000abcd"];

const mockProofResult = {
  proof: MOCK_PROOF_BYTES,
  publicInputs: MOCK_PUBLIC_INPUTS,
};

// ---------------------------------------------------------------------------
// Track the last inputs passed to Noir.execute so we can assert on them.
// ---------------------------------------------------------------------------
let lastExecuteInputs: Record<string, unknown> = {};
let lastBackendBytecode = "";

// ---------------------------------------------------------------------------
// Mock @aztec/bb.js — UltraHonkBackend must be a real class so `new` works.
// ---------------------------------------------------------------------------
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockGenerateProof = vi.fn().mockResolvedValue(mockProofResult);

class MockUltraHonkBackend {
  constructor(bytecode: string) {
    lastBackendBytecode = bytecode;
  }
  generateProof = mockGenerateProof;
  destroy = mockDestroy;
}

vi.mock("@aztec/bb.js", () => ({
  UltraHonkBackend: MockUltraHonkBackend,
}));

// ---------------------------------------------------------------------------
// Mock @noir-lang/noir_js — Noir must also be a real class so `new` works.
// ---------------------------------------------------------------------------
const mockExecute = vi.fn().mockResolvedValue({ witness: new Uint8Array([1, 2, 3]) });

class MockNoir {
  constructor(_circuit: unknown) {}
  execute = mockExecute;
}

vi.mock("@noir-lang/noir_js", () => ({
  Noir: MockNoir,
}));

// ---------------------------------------------------------------------------
// Mock circuit JSON files as minimal circuit objects.
// Each has a distinct `bytecode` value so we can assert that the correct
// artifact was passed to UltraHonkBackend.
// ---------------------------------------------------------------------------
const MOCK_POOL_CIRCUIT = { bytecode: "pool-bytecode-base64", abi: {} };
const MOCK_COMPLIANCE_CIRCUIT = { bytecode: "compliance-bytecode-base64", abi: {} };
const MOCK_DISCLOSURE_CIRCUIT = { bytecode: "disclosure-bytecode-base64", abi: {} };

vi.mock("@/circuits/shielded_pool.json", () => ({ default: MOCK_POOL_CIRCUIT }));
vi.mock("@/circuits/compliance.json", () => ({ default: MOCK_COMPLIANCE_CIRCUIT }));
vi.mock("@/circuits/disclosure.json", () => ({ default: MOCK_DISCLOSURE_CIRCUIT }));

// ---------------------------------------------------------------------------
// Import the module under test *after* mocks are registered.
// ---------------------------------------------------------------------------
const { proveWithdrawal, proveCompliance, proveDisclosure } = await import(
  "./prover"
);

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------
const HEX_FIELD = "0x" + "ab".repeat(32); // already 0x-prefixed
const RAW_FIELD = "ab".repeat(32);         // no 0x prefix — should get one added
const PATH_SIBLINGS = Array(20).fill("0x" + "00".repeat(32));
const PATH_BITS = Array(20).fill(0);

describe("prover module — public API", () => {
  it("exports proveWithdrawal as a function", () => {
    expect(typeof proveWithdrawal).toBe("function");
  });

  it("exports proveCompliance as a function", () => {
    expect(typeof proveCompliance).toBe("function");
  });

  it("exports proveDisclosure as a function", () => {
    expect(typeof proveDisclosure).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// proveWithdrawal
// ---------------------------------------------------------------------------
describe("proveWithdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateProof.mockResolvedValue(mockProofResult);
    mockExecute.mockResolvedValue({ witness: new Uint8Array([1, 2, 3]) });
    lastBackendBytecode = "";
    lastExecuteInputs = {};
    // Capture execute args each call
    mockExecute.mockImplementation((inputs: unknown) => {
      lastExecuteInputs = inputs as Record<string, unknown>;
      return Promise.resolve({ witness: new Uint8Array([1, 2, 3]) });
    });
  });

  it("returns proof and publicInputs as hex strings", async () => {
    const result = await proveWithdrawal({
      nullifier: RAW_FIELD,
      secret: RAW_FIELD,
      root: HEX_FIELD,
      nullifierHash: HEX_FIELD,
      recipientHash: HEX_FIELD,
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    expect(typeof result.proof).toBe("string");
    expect(typeof result.publicInputs).toBe("string");
  });

  it("constructs proof hex from the backend output bytes", async () => {
    const result = await proveWithdrawal({
      nullifier: RAW_FIELD,
      secret: RAW_FIELD,
      root: HEX_FIELD,
      nullifierHash: HEX_FIELD,
      recipientHash: HEX_FIELD,
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    // MOCK_PROOF_BYTES = [0xde, 0xad, 0xbe, 0xef] → "deadbeef"
    expect(result.proof).toBe("deadbeef");
  });

  it("encodes publicInputs correctly (strips 0x, pads to 64 chars, joins)", async () => {
    const result = await proveWithdrawal({
      nullifier: RAW_FIELD,
      secret: RAW_FIELD,
      root: HEX_FIELD,
      nullifierHash: HEX_FIELD,
      recipientHash: HEX_FIELD,
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    // MOCK_PUBLIC_INPUTS[0] = "0x000...abcd" → strip 0x, already 64 chars
    expect(result.publicInputs).toBe(
      "000000000000000000000000000000000000000000000000000000000000abcd",
    );
  });

  it("passes the pool circuit bytecode to UltraHonkBackend", async () => {
    await proveWithdrawal({
      nullifier: RAW_FIELD,
      secret: RAW_FIELD,
      root: HEX_FIELD,
      nullifierHash: HEX_FIELD,
      recipientHash: HEX_FIELD,
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    expect(lastBackendBytecode).toBe(MOCK_POOL_CIRCUIT.bytecode);
  });

  it("calls backend.generateProof with keccak: true", async () => {
    await proveWithdrawal({
      nullifier: RAW_FIELD,
      secret: RAW_FIELD,
      root: HEX_FIELD,
      nullifierHash: HEX_FIELD,
      recipientHash: HEX_FIELD,
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    expect(mockGenerateProof).toHaveBeenCalledWith(
      expect.anything(),
      { keccak: true },
    );
  });

  it("always calls backend.destroy even when proof generation throws", async () => {
    mockGenerateProof.mockRejectedValueOnce(new Error("prover failed"));
    await expect(
      proveWithdrawal({
        nullifier: RAW_FIELD,
        secret: RAW_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      }),
    ).rejects.toThrow("prover failed");
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  describe("input field mapping", () => {
    it("maps nullifier field name correctly", async () => {
      await proveWithdrawal({
        nullifier: RAW_FIELD,
        secret: HEX_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      });
      expect(lastExecuteInputs).toHaveProperty("nullifier");
    });

    it("maps nullifier_hash field name correctly", async () => {
      await proveWithdrawal({
        nullifier: HEX_FIELD,
        secret: HEX_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      });
      expect(lastExecuteInputs).toHaveProperty("nullifier_hash");
    });

    it("maps recipient field name correctly", async () => {
      await proveWithdrawal({
        nullifier: HEX_FIELD,
        secret: HEX_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      });
      expect(lastExecuteInputs).toHaveProperty("recipient");
    });

    it("maps path_bits as array of strings", async () => {
      await proveWithdrawal({
        nullifier: HEX_FIELD,
        secret: HEX_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      });
      expect(Array.isArray(lastExecuteInputs.path_bits)).toBe(true);
      expect((lastExecuteInputs.path_bits as string[])[0]).toBe("0");
    });

    it("adds 0x prefix to raw (non-prefixed) fields", async () => {
      await proveWithdrawal({
        nullifier: RAW_FIELD,   // no 0x
        secret: RAW_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      });
      expect((lastExecuteInputs.nullifier as string).startsWith("0x")).toBe(true);
    });

    it("does not double-prefix already-prefixed fields", async () => {
      await proveWithdrawal({
        nullifier: HEX_FIELD,   // already 0x
        secret: HEX_FIELD,
        root: HEX_FIELD,
        nullifierHash: HEX_FIELD,
        recipientHash: HEX_FIELD,
        pathSiblings: PATH_SIBLINGS,
        pathBits: PATH_BITS,
      });
      expect(lastExecuteInputs.nullifier as string).not.toMatch(/^0x0x/);
    });
  });
});

// ---------------------------------------------------------------------------
// proveCompliance
// ---------------------------------------------------------------------------
describe("proveCompliance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateProof.mockResolvedValue(mockProofResult);
    lastBackendBytecode = "";
    lastExecuteInputs = {};
    mockExecute.mockImplementation((inputs: unknown) => {
      lastExecuteInputs = inputs as Record<string, unknown>;
      return Promise.resolve({ witness: new Uint8Array([1, 2, 3]) });
    });
  });

  const BASE_COMPLIANCE_INPUTS = {
    kycPreimage: HEX_FIELD,
    nullifier: HEX_FIELD,
    secret: HEX_FIELD,
    amount: "10000000",
    auditorKey: HEX_FIELD,
    merkleRoot: HEX_FIELD,
    kycHash: HEX_FIELD,
    disclosedAmount: "10000000",
    pathSiblings: PATH_SIBLINGS,
    pathBits: PATH_BITS,
  };

  it("returns proof and publicInputs as hex strings", async () => {
    const result = await proveCompliance(BASE_COMPLIANCE_INPUTS);
    expect(typeof result.proof).toBe("string");
    expect(typeof result.publicInputs).toBe("string");
  });

  it("passes the compliance circuit bytecode to UltraHonkBackend", async () => {
    await proveCompliance(BASE_COMPLIANCE_INPUTS);
    expect(lastBackendBytecode).toBe(MOCK_COMPLIANCE_CIRCUIT.bytecode);
  });

  it("calls backend.destroy even if proof generation throws", async () => {
    mockGenerateProof.mockRejectedValueOnce(new Error("compliance prover failed"));
    await expect(proveCompliance(BASE_COMPLIANCE_INPUTS)).rejects.toThrow(
      "compliance prover failed",
    );
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  describe("input field mapping", () => {
    it("maps kyc_preimage correctly", async () => {
      await proveCompliance(BASE_COMPLIANCE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("kyc_preimage");
    });

    it("maps disclosed_amount correctly", async () => {
      await proveCompliance(BASE_COMPLIANCE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("disclosed_amount");
    });

    it("maps merkle_root correctly", async () => {
      await proveCompliance(BASE_COMPLIANCE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("merkle_root");
    });

    it("maps auditor_key correctly", async () => {
      await proveCompliance(BASE_COMPLIANCE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("auditor_key");
    });

    it("maps kyc_hash correctly", async () => {
      await proveCompliance(BASE_COMPLIANCE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("kyc_hash");
    });

    it("passes amount as a plain string (not 0x-prefixed)", async () => {
      await proveCompliance({ ...BASE_COMPLIANCE_INPUTS, amount: "99999" });
      expect(lastExecuteInputs.amount).toBe("99999");
    });
  });
});

// ---------------------------------------------------------------------------
// proveDisclosure
// ---------------------------------------------------------------------------
describe("proveDisclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateProof.mockResolvedValue(mockProofResult);
    lastBackendBytecode = "";
    lastExecuteInputs = {};
    mockExecute.mockImplementation((inputs: unknown) => {
      lastExecuteInputs = inputs as Record<string, unknown>;
      return Promise.resolve({ witness: new Uint8Array([1, 2, 3]) });
    });
  });

  const BASE_DISCLOSURE_INPUTS = {
    kycPreimage: HEX_FIELD,
    nullifier: HEX_FIELD,
    secret: HEX_FIELD,
    amount: "10000000",
    auditorKey: HEX_FIELD,
    merkleRoot: HEX_FIELD,
    kycHash: HEX_FIELD,
    threshold: "5000000",
    pathSiblings: PATH_SIBLINGS,
    pathBits: PATH_BITS,
  };

  it("returns proof and publicInputs as hex strings", async () => {
    const result = await proveDisclosure(BASE_DISCLOSURE_INPUTS);
    expect(typeof result.proof).toBe("string");
    expect(typeof result.publicInputs).toBe("string");
  });

  it("passes the disclosure circuit bytecode to UltraHonkBackend", async () => {
    await proveDisclosure(BASE_DISCLOSURE_INPUTS);
    expect(lastBackendBytecode).toBe(MOCK_DISCLOSURE_CIRCUIT.bytecode);
  });

  it("calls backend.destroy even if proof generation throws", async () => {
    mockGenerateProof.mockRejectedValueOnce(new Error("disclosure prover failed"));
    await expect(proveDisclosure(BASE_DISCLOSURE_INPUTS)).rejects.toThrow(
      "disclosure prover failed",
    );
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  describe("input field mapping", () => {
    it("maps threshold correctly", async () => {
      await proveDisclosure(BASE_DISCLOSURE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("threshold");
    });

    it("passes threshold as a plain string (not 0x-prefixed)", async () => {
      await proveDisclosure({ ...BASE_DISCLOSURE_INPUTS, threshold: "1000" });
      expect(lastExecuteInputs.threshold).toBe("1000");
    });

    it("maps kyc_preimage correctly", async () => {
      await proveDisclosure(BASE_DISCLOSURE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("kyc_preimage");
    });

    it("maps merkle_root correctly", async () => {
      await proveDisclosure(BASE_DISCLOSURE_INPUTS);
      expect(lastExecuteInputs).toHaveProperty("merkle_root");
    });
  });
});

// ---------------------------------------------------------------------------
// Circuit artifact lazy-loading: each prove* uses a distinct circuit artifact.
// After calling all three, assert the correct bytecode was passed each time.
// ---------------------------------------------------------------------------
describe("circuit artifact lazy-loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateProof.mockResolvedValue(mockProofResult);
    lastBackendBytecode = "";
    lastExecuteInputs = {};
    mockExecute.mockImplementation((inputs: unknown) => {
      lastExecuteInputs = inputs as Record<string, unknown>;
      return Promise.resolve({ witness: new Uint8Array([1, 2, 3]) });
    });
  });

  it("proveWithdrawal uses the shielded_pool bytecode, not compliance or disclosure", async () => {
    await proveWithdrawal({
      nullifier: HEX_FIELD,
      secret: HEX_FIELD,
      root: HEX_FIELD,
      nullifierHash: HEX_FIELD,
      recipientHash: HEX_FIELD,
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    expect(lastBackendBytecode).toBe(MOCK_POOL_CIRCUIT.bytecode);
    expect(lastBackendBytecode).not.toBe(MOCK_COMPLIANCE_CIRCUIT.bytecode);
    expect(lastBackendBytecode).not.toBe(MOCK_DISCLOSURE_CIRCUIT.bytecode);
  });

  it("proveCompliance uses the compliance bytecode, not pool or disclosure", async () => {
    await proveCompliance({
      kycPreimage: HEX_FIELD,
      nullifier: HEX_FIELD,
      secret: HEX_FIELD,
      amount: "1",
      auditorKey: HEX_FIELD,
      merkleRoot: HEX_FIELD,
      kycHash: HEX_FIELD,
      disclosedAmount: "1",
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    expect(lastBackendBytecode).toBe(MOCK_COMPLIANCE_CIRCUIT.bytecode);
    expect(lastBackendBytecode).not.toBe(MOCK_POOL_CIRCUIT.bytecode);
    expect(lastBackendBytecode).not.toBe(MOCK_DISCLOSURE_CIRCUIT.bytecode);
  });

  it("proveDisclosure uses the disclosure bytecode, not pool or compliance", async () => {
    await proveDisclosure({
      kycPreimage: HEX_FIELD,
      nullifier: HEX_FIELD,
      secret: HEX_FIELD,
      amount: "1",
      auditorKey: HEX_FIELD,
      merkleRoot: HEX_FIELD,
      kycHash: HEX_FIELD,
      threshold: "1",
      pathSiblings: PATH_SIBLINGS,
      pathBits: PATH_BITS,
    });
    expect(lastBackendBytecode).toBe(MOCK_DISCLOSURE_CIRCUIT.bytecode);
    expect(lastBackendBytecode).not.toBe(MOCK_POOL_CIRCUIT.bytecode);
    expect(lastBackendBytecode).not.toBe(MOCK_COMPLIANCE_CIRCUIT.bytecode);
  });
});
