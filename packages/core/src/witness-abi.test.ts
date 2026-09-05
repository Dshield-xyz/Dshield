/**
 * Locks each witness builder to the circuit it feeds.
 *
 * Noir executes a circuit by name-matching the witness map against the ABI's
 * parameters: a missing field aborts witness generation, and an extra one is
 * rejected too. Neither failure shows up until someone actually tries to
 * withdraw, which is a minute of proving and a signed transaction later.
 *
 * This is not hypothetical. When `asset` (multi-asset notes) and `relayer_fee`
 * (fee abstraction) were added to circuits/shielded_pool, the contract and its
 * Rust tests were updated but these builders were not, and the compiled circuit
 * was never copied into the clients — so the app shipped a 12-input circuit and
 * a 12-field witness against a contract expecting 14 public inputs. Everything
 * was green: no test compared the two. This one does.
 */
import { describe, it, expect } from "vitest";
import poolCircuit from "./circuits/shielded_pool.json" with { type: "json" };
import complianceCircuit from "./circuits/compliance.json" with { type: "json" };
import disclosureCircuit from "./circuits/disclosure.json" with { type: "json" };
import {
  buildWithdrawalWitness,
  buildComplianceWitness,
  buildDisclosureWitness,
} from "./prover.js";

interface CircuitAbi {
  abi: { parameters: { name: string; visibility?: string }[] };
}

function parameterNames(circuit: unknown): string[] {
  return (circuit as CircuitAbi).abi.parameters.map((p) => p.name).sort();
}

const PATH = { pathSiblings: ["0x1", "0x2"], pathBits: [0, 1] };

const WITHDRAWAL = {
  nullifier: "1",
  secret: "2",
  amount: "1000000",
  asset: "0xabc",
  withdrawAmount: "400000",
  relayerFee: "0",
  changeNullifier: "8",
  changeSecret: "9",
  changeCommitment: "0xa",
  root: "0x3",
  nullifierHash: "4",
  recipientHash: "5",
  ...PATH,
};

const COMPLIANCE = {
  kycPreimage: "7",
  nullifier: "1",
  secret: "2",
  amount: "1000000",
  asset: "0xabc",
  auditorKey: "0xaa",
  merkleRoot: "0x3",
  kycHash: "0xbb",
  disclosedAmount: "1000000",
  ...PATH,
};

const DISCLOSURE = {
  kycPreimage: "7",
  nullifier: "1",
  secret: "2",
  amount: "1000000",
  asset: "0xabc",
  auditorKey: "0xaa",
  merkleRoot: "0x3",
  kycHash: "0xbb",
  threshold: "500000",
  ...PATH,
};

describe("witness builders match their compiled circuit ABI", () => {
  it.each([
    ["shielded_pool", poolCircuit, buildWithdrawalWitness(WITHDRAWAL)],
    ["compliance", complianceCircuit, buildComplianceWitness(COMPLIANCE)],
    ["disclosure", disclosureCircuit, buildDisclosureWitness(DISCLOSURE)],
  ])("%s", (_name, circuit, witness) => {
    expect(Object.keys(witness).sort()).toEqual(parameterNames(circuit));
  });
});

describe("shielded_pool circuit shape", () => {
  it("still takes the asset and relayer fee the pool contract expects", () => {
    // The contract parses a fixed-width public-input blob and reads `asset` and
    // `relayer_fee` out of it (PUBLIC_INPUT_BYTES = 7 * 32 in
    // contracts/pool/src/lib.rs), so dropping either from the circuit breaks
    // every withdrawal rather than just omitting a feature.
    const names = parameterNames(poolCircuit);
    expect(names).toContain("asset");
    expect(names).toContain("relayer_fee");
  });

  it("has exactly the seven public inputs the contract decodes", () => {
    const publicInputs = (poolCircuit as CircuitAbi).abi.parameters
      .filter((p) => p.visibility === "public")
      .map((p) => p.name);
    expect(publicInputs).toEqual([
      "root",
      "nullifier_hash",
      "recipient",
      "withdraw_amount",
      "relayer_fee",
      "change_commitment",
      "asset",
    ]);
  });
});
