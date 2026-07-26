/**
 * Client-side ZK prover.
 *
 * Circuit artifacts (JSON) are loaded lazily — each import() fires only when
 * the matching prove* function is first called, so the three circuit files
 * (~10 KB each, ~36 KB total) are **not** bundled into the initial JS payload.
 * webpack will split them into separate async chunks that are fetched on demand.
 *
 * @aztec/bb.js and @noir-lang/noir_js are also imported lazily for the same
 * reason: the barretenberg WASM (~7 MB) should not block the initial page load.
 */

interface ProofResult {
  proof: string;
  publicInputs: string;
}

async function generateProof(
  circuit: Record<string, unknown>,
  inputs: Record<string, string | string[]>,
): Promise<ProofResult> {
  // Lazy-load the heavy ZK runtime only when a proof is actually requested.
  const [{ Noir }, { UltraHonkBackend }] = await Promise.all([
    import("@noir-lang/noir_js"),
    import("@aztec/bb.js"),
  ]);

  const noir = new Noir(circuit as never);
  const backend = new UltraHonkBackend(
    (circuit as { bytecode: string }).bytecode,
  );

  try {
    const { witness } = await noir.execute(inputs as never);
    // The verification key and on-chain verifier are built with
    // `--oracle_hash keccak` (see tests/e2e.sh). The proof MUST be generated
    // with the matching keccak Fiat-Shamir transform, otherwise the on-chain
    // UltraHonk verifier rejects it (Contract #4 / VerificationFailed).
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

export async function proveWithdrawal(inputs: {
  nullifier: string;
  secret: string;
  root: string;
  nullifierHash: string;
  recipientHash: string;
  pathSiblings: string[];
  pathBits: number[];
}): Promise<ProofResult> {
  // Lazy-load: only the withdraw page needs shielded_pool.json.
  const { default: poolCircuit } = await import(
    /* webpackChunkName: "circuit-shielded-pool" */
    "@/circuits/shielded_pool.json"
  );
  return generateProof(poolCircuit as Record<string, unknown>, {
    nullifier: ensureHex(inputs.nullifier),
    secret: ensureHex(inputs.secret),
    root: ensureHex(inputs.root),
    nullifier_hash: ensureHex(inputs.nullifierHash),
    recipient: ensureHex(inputs.recipientHash),
    path_bits: inputs.pathBits.map(String),
    path_siblings: inputs.pathSiblings.map(ensureHex),
  });
}

export async function proveCompliance(inputs: {
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
}): Promise<ProofResult> {
  // Lazy-load: only the compliance page needs compliance.json.
  const { default: complianceCircuit } = await import(
    /* webpackChunkName: "circuit-compliance" */
    "@/circuits/compliance.json"
  );
  return generateProof(complianceCircuit as Record<string, unknown>, {
    kyc_preimage: ensureHex(inputs.kycPreimage),
    nullifier: ensureHex(inputs.nullifier),
    secret: ensureHex(inputs.secret),
    amount: inputs.amount,
    auditor_key: ensureHex(inputs.auditorKey),
    merkle_root: ensureHex(inputs.merkleRoot),
    kyc_hash: ensureHex(inputs.kycHash),
    disclosed_amount: inputs.disclosedAmount,
    path_bits: inputs.pathBits.map(String),
    path_siblings: inputs.pathSiblings.map(ensureHex),
  });
}

export async function proveDisclosure(inputs: {
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
}): Promise<ProofResult> {
  // Lazy-load: only the compliance/disclosure page needs disclosure.json.
  const { default: disclosureCircuit } = await import(
    /* webpackChunkName: "circuit-disclosure" */
    "@/circuits/disclosure.json"
  );
  return generateProof(disclosureCircuit as Record<string, unknown>, {
    kyc_preimage: ensureHex(inputs.kycPreimage),
    nullifier: ensureHex(inputs.nullifier),
    secret: ensureHex(inputs.secret),
    amount: inputs.amount,
    auditor_key: ensureHex(inputs.auditorKey),
    merkle_root: ensureHex(inputs.merkleRoot),
    kyc_hash: ensureHex(inputs.kycHash),
    threshold: inputs.threshold,
    path_bits: inputs.pathBits.map(String),
    path_siblings: inputs.pathSiblings.map(ensureHex),
  });
}

function ensureHex(v: string): string {
  if (v.startsWith("0x")) return v;
  return "0x" + v;
}
