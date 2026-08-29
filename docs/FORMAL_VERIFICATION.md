# Formal Verification Harness

DShield uses a lightweight formal/symbolic harness for Noir circuits in
`scripts/verify-circuits.mjs`. The harness reads machine-checkable
specifications from `circuits/formal/specs/*.json` and checks them against
compiled Nargo artifacts.

## Tool Selection

The selected tool is a repository-local symbolic relation checker over Nargo's
compiled artifact format:

- it requires an ACIR bytecode payload in the artifact and verifies it can be
  decoded from the compressed `bytecode` field;
- it validates the ABI declared by the compiled artifact;
- it verifies the source embedded in the artifact `file_map`, which is the
  source Nargo compiled into the ACIR payload;
- it compares freshly compiled target artifacts with the checked-in source so
  stale target artifacts fail CI;
- it runs a mutation self-test that deliberately breaks
  `shielded_pool` value conservation and requires the harness to reject it.

This choice avoids depending on an external SMT/ACIR parser that is not already
maintained in the project, while still making the intended circuit relations
executable in CI. The JSON specs are intentionally declarative so they can be
replaced or extended by a deeper ACIR-to-SMT backend later without changing the
documented properties.

## Covered Properties

`shielded_pool`:

- `amount` and `withdraw_amount` are round-trip constrained to `u64`;
- `withdraw_amount <= amount`;
- `change = amount - withdraw_amount`;
- `change_commitment` is exactly `hash_leaf(change_nullifier, change_secret,
  change)`;
- the spent note leaf commits to `nullifier`, `secret`, and `amount`;
- the computed Merkle root and nullifier hash are asserted against public
  inputs.

`compliance`:

- the KYC preimage hashes to the public KYC hash;
- the note leaf commits to `nullifier`, `secret`, and `amount`;
- Merkle membership is asserted against the public root;
- `amount` and `disclosed_amount` are `u64`;
- `amount == disclosed_amount`.

`disclosure`:

- the KYC preimage hashes to the public KYC hash;
- the note leaf commits to `nullifier`, `secret`, and `amount`;
- Merkle membership is asserted against the public root;
- `amount` and `threshold` are `u64`;
- `amount >= threshold`.

`hasher`:

- the public result is `Poseidon2::hash([a, b], 2)`.

## Not Covered

This harness is not a replacement for an external audit or a complete proof of
ACIR constraint equivalence. In particular, it does not prove:

- the mathematical security of Poseidon2;
- soundness of Noir, ACIR generation, Barretenberg, or the verifier contracts;
- global nullifier uniqueness, because that is stateful and enforced by the
  pool contract;
- recipient-address binding, because that crosses the circuit/contract
  boundary;
- KYC policy correctness or auditor registry semantics;
- frontend, relayer, deployment, or operational security.

The harness should be read as a CI guard for named circuit invariants. It closes
the gap where a constraint is accidentally removed or rewired, but it does not
remove the need for code review, adversarial testing, and independent audit.

## Running Locally

After compiling circuits with Nargo:

```bash
bash scripts/verify-circuits.sh --self-test
```

Without local Nargo artifacts, the script can read the checked-in frontend
artifacts as a convenience smoke test. CI always compiles fresh
`circuits/*/target/*.json` artifacts before running the formal harness.
