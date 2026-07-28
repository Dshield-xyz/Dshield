export async function proveDisclosure(
  inputs: {
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
  },
  onProgress?: (stage: ProofStage) => void,
): Promise<ProofResult> {
  return generateProof(
    disclosureCircuit as Record<string, unknown>,
    {
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
    },
    onProgress,
  );
}