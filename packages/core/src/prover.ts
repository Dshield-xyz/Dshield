import poolCircuit from "./circuits/shielded_pool.json" with { type: "json" };
import complianceCircuit from "./circuits/compliance.json" with { type: "json" };
import disclosureCircuit from "./circuits/disclosure.json" with { type: "json" };
import { runProof, type ProofResult, type ProofStage } from "./prover-core.js";

export type { ProofResult, ProofStage };

// The compiled circuits, exported so the frontend's Web-Worker wrapper and the
// CLI's direct runner both prove against the exact same bytecode.
export const POOL_CIRCUIT = poolCircuit as Record<string, unknown>;
export const COMPLIANCE_CIRCUIT = complianceCircuit as Record<string, unknown>;
export const DISCLOSURE_CIRCUIT = disclosureCircuit as Record<string, unknown>;

export interface WithdrawalProofInputs {
  nullifier: string;
  secret: string;
  amount: string;
  withdrawAmount: string;
  changeNullifier: string;
  changeSecret: string;
  changeCommitment: string;
  root: string;
  nullifierHash: string;
  recipientHash: string;
  pathSiblings: string[];
  pathBits: number[];
}

export interface ComplianceProofInputs {
  kycPreimage: string;
  nullifier: string;
  secret: string;
  amount: string;
  auditorKey: string;
  merkleRoot: string;
  kycHash: string;
  disclosedAmount: string;
  pathSiblings: string[];
  pathBits: number[];
}

export interface DisclosureProofInputs {
  kycPreimage: string;
  nullifier: string;
  secret: string;
  amount: string;
  auditorKey: string;
  merkleRoot: string;
  kycHash: string;
  threshold: string;
  pathSiblings: string[];
  pathBits: number[];
}

/**
 * Maps the withdrawal inputs to the exact Noir witness fields the shielded_pool
 * circuit expects. Separated from proof generation so the frontend worker and
 * the CLI feed the circuit an identical witness.
 */
export function buildWithdrawalWitness(
  inputs: WithdrawalProofInputs,
): Record<string, string | string[]> {
  return {
    nullifier: ensureHex(inputs.nullifier),
    secret: ensureHex(inputs.secret),
    amount: decimal(inputs.amount),
    change_nullifier: ensureHex(inputs.changeNullifier),
    change_secret: ensureHex(inputs.changeSecret),
    root: ensureHex(inputs.root),
    nullifier_hash: ensureHex(inputs.nullifierHash),
    recipient: ensureHex(inputs.recipientHash),
    withdraw_amount: decimal(inputs.withdrawAmount),
    change_commitment: ensureHex(inputs.changeCommitment),
    path_bits: inputs.pathBits.map(String),
    path_siblings: inputs.pathSiblings.map(ensureHex),
  };
}

export function buildComplianceWitness(
  inputs: ComplianceProofInputs,
): Record<string, string | string[]> {
  return {
    kyc_preimage: ensureHex(inputs.kycPreimage),
    nullifier: ensureHex(inputs.nullifier),
    secret: ensureHex(inputs.secret),
    amount: decimal(inputs.amount),
    auditor_key: ensureHex(inputs.auditorKey),
    merkle_root: ensureHex(inputs.merkleRoot),
    kyc_hash: ensureHex(inputs.kycHash),
    disclosed_amount: decimal(inputs.disclosedAmount),
    path_bits: inputs.pathBits.map(String),
    path_siblings: inputs.pathSiblings.map(ensureHex),
  };
}

export function buildDisclosureWitness(
  inputs: DisclosureProofInputs,
): Record<string, string | string[]> {
  return {
    kyc_preimage: ensureHex(inputs.kycPreimage),
    nullifier: ensureHex(inputs.nullifier),
    secret: ensureHex(inputs.secret),
    amount: decimal(inputs.amount),
    auditor_key: ensureHex(inputs.auditorKey),
    merkle_root: ensureHex(inputs.merkleRoot),
    kyc_hash: ensureHex(inputs.kycHash),
    threshold: decimal(inputs.threshold),
    path_bits: inputs.pathBits.map(String),
    path_siblings: inputs.pathSiblings.map(ensureHex),
  };
}

/**
 * Proves a spend of one note: `withdrawAmount` of its `amount` is paid out and
 * the remainder is re-shielded into a new note under `changeNullifier` /
 * `changeSecret`.
 *
 * A change note is always produced, even for a full withdrawal where the
 * remainder is zero, so that a full and a partial spend are indistinguishable
 * on-chain. The caller must therefore always store the change note before
 * submitting.
 *
 * Amounts are decimal strings of token base units. They must not be hex: Noir
 * would read a `0x`-prefixed amount as a different number than the contract's
 * big-endian byte decoding does, and the payout would silently disagree with
 * what the note is worth.
 */
export async function proveWithdrawal(
  inputs: WithdrawalProofInputs,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return runProof(POOL_CIRCUIT, buildWithdrawalWitness(inputs), onProgress);
}

export async function proveCompliance(
  inputs: ComplianceProofInputs,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return runProof(COMPLIANCE_CIRCUIT, buildComplianceWitness(inputs), onProgress);
}

export async function proveDisclosure(
  inputs: DisclosureProofInputs,
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return runProof(DISCLOSURE_CIRCUIT, buildDisclosureWitness(inputs), onProgress);
}

function ensureHex(v: string): string {
  if (v.startsWith("0x")) return v;
  return "0x" + v;
}

/** Normalizes an amount to the plain decimal form Noir reads as a number. */
function decimal(v: string): string {
  return BigInt(v).toString(10);
}
