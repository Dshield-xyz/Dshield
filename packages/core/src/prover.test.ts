import { describe, it, expect } from "vitest";
import {
  buildWithdrawalWitness,
  buildComplianceWitness,
  buildDisclosureWitness,
} from "./prover.js";

const WITHDRAWAL = {
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

describe("buildWithdrawalWitness", () => {
  it("0x-prefixes field inputs and stringifies path bits", () => {
    expect(buildWithdrawalWitness(WITHDRAWAL)).toEqual({
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

  it("passes amounts as plain decimals, never hex", () => {
    // Noir reads "0x400000" as 4194304, not 4000000. A hex-encoded amount would
    // make the circuit prove a payout different from the one the contract
    // decodes from the same public input, so both must agree on decimal.
    const witness = buildWithdrawalWitness({
      ...WITHDRAWAL,
      withdrawAmount: "0x64",
      amount: "0xc8",
    });
    expect(witness.withdraw_amount).toBe("100");
    expect(witness.amount).toBe("200");
  });
});

describe("buildComplianceWitness / buildDisclosureWitness", () => {
  const base = {
    kycPreimage: "1",
    nullifier: "2",
    secret: "3",
    amount: "1000000",
    auditorKey: "4",
    merkleRoot: "0x5",
    kycHash: "6",
    pathSiblings: ["7"],
    pathBits: [1],
  };

  it("maps compliance inputs with a decimal disclosed amount", () => {
    const w = buildComplianceWitness({ ...base, disclosedAmount: "0x64" });
    expect(w.kyc_preimage).toBe("0x1");
    expect(w.merkle_root).toBe("0x5");
    expect(w.disclosed_amount).toBe("100");
    expect(w.path_bits).toEqual(["1"]);
    expect(w.path_siblings).toEqual(["0x7"]);
  });

  it("maps disclosure inputs with a decimal threshold", () => {
    const w = buildDisclosureWitness({ ...base, threshold: "0x64" });
    expect(w.threshold).toBe("100");
    expect(w.auditor_key).toBe("0x4");
  });
});
