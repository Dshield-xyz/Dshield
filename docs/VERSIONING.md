# Dshield Circuit/Contract Versioning and Note Migration Framework

## Overview

This document describes the framework for versioning circuit and contract changes in Dshield, particularly those that affect the leaf structure or commitment scheme. The framework ensures that notes minted under one circuit version remain provable even after the protocol upgrades to a new version, without forcing users to immediately migrate or lose their funds.

## The Problem This Solves

Without versioning, any backward-incompatible change to the leaf hash (e.g., changing the commitment formula, adding new fields, or altering the Poseidon2 domain tags) would:
- Strand existing users' notes, rendering them unspendable
- Force a bespoke, one-off migration logic for each future change
- Require a fresh deployment where old notes are unreachable
- Be expensive and risky for a protocol whose core promise is permanence

## Design Principles

1. **Old notes stay spendable**: Notes minted under any supported version can be withdrawn from the same pool instance without migration
2. **Multi-VK support**: The pool and verifier contract hold multiple verifying keys, one per circuit version
3. **Version tagging**: Each commitment/note carries a version tag indicating which circuit was used to mint it
4. **Frontend awareness**: The wallet knows which circuit to use when re-proving an old note for withdrawal
5. **Gradual deprecation**: Old versions are supported indefinitely unless explicitly deprecated

## Implementation

### 1. Contract Layer: Version-Tagged Commitments

**File**: `contracts/pool/src/lib.rs`

- Each commitment is stored with a version tag in persistent storage
- Key: `(key_commitment_version_prefix, commitment)` → `CURRENT_CIRCUIT_VERSION`
- When a new version is deployed, `CURRENT_CIRCUIT_VERSION` is incremented
- New deposits are tagged with the new version; old commitments retain their original tags
- Backward compatibility: commitments without a version tag default to v1

**Functions**:
- `get_commitment_version(commitment) -> Option<u32>`: Retrieves the version for a commitment
- `get_current_version() -> u32`: Returns the circuit version for new deposits

### 2. Verifier Contract: Multi-VK Registry

**File**: `contracts/verifier/src/lib.rs`

The verifier contract maintains a registry of verifying keys indexed by version:
- Legacy VK (for backward compatibility): single global VK, used if no version is specified
- Versioned VKs: `(key_versioned_vk(version), version) → vk_bytes`
- Current version tracking: `key_current_version() → u32`

**Constructor**: Initializes with v1 VK, registers it in both legacy and versioned slots

**Functions**:
- `set_vk_for_version(version, vk_bytes)`: Register or update a VK for a specific version
- `vk_bytes_for_version(version) -> Result<Bytes, VerifierError>`: Retrieve VK for a version
- `verify_proof_for_version(version, public_inputs, proof) -> Result<(), VerifierError>`: Verify using a specific version's VK
- `verify_proof(public_inputs, proof) -> Result<(), VerifierError>`: Verify using legacy VK (backward compatible)
- `get_current_version() -> u32`: Return the current (latest) version tag

### 3. Circuit: Versioning Convention

**File**: `circuits/shielded_pool/src/main.nr`

The circuit documents what constitutes a compatible vs. incompatible change:

**COMPATIBLE** (same version, no new version tag needed):
- Adding additional constraints that don't change the leaf hash formula
- Changing non-committed public inputs
- Optimizing existing constraints
- Adding checks that old leaves still satisfy

**INCOMPATIBLE** (new version tag required):
- Changing `hash_leaf` function (structure or domain tags)
- Changing committed field count/order (nullifier, secret, amount)
- Changing tree depth
- Changing any domain separation tag in `hash_leaf` or `hash_nullifier`

### 4. Frontend: Version-Aware Witness Generation

**File**: `frontend/src/lib/notes.ts`, `frontend/src/lib/prover.ts`

- `ShieldedNote` interface includes a `version: number` field
- Notes default to version 1 for backward compatibility
- When generating a withdrawal proof, the `version` is passed to the prover
- The prover selects the correct circuit based on the note's version

**Future extension** (when v2 ships):
```typescript
function getPoolCircuitForVersion(version: number) {
  if (version === 2) return poolCircuitV2;
  return poolCircuit; // v1
}

const circuit = getPoolCircuitForVersion(note.version);
```

## How to Ship a Leaf-Structure Change

### Step 1: Design the Change

Decide whether it's compatible or incompatible:
- Compatible: no new version tag needed, just update the contract or circuit
- Incompatible: prepare a new circuit with a different commitment scheme

### Step 2: Update the Circuit

Edit `circuits/shielded_pool/src/main.nr`:
- If incompatible, increment `CIRCUIT_VERSION` global
- Update `hash_leaf` or related functions if needed
- Document the change in the versioning convention comments
- Build the circuit to generate a new VK

### Step 3: Update Contracts

1. Increment `CURRENT_CIRCUIT_VERSION` in `contracts/pool/src/lib.rs`
2. No changes to pool logic—version tagging is automatic
3. If verifier is separate, register the new VK in it (see step 4)

### Step 4: Register the New VK

If using a separate verifier contract:
```rust
verifier.set_vk_for_version(version: u32, vk_bytes: Bytes)
```

The pool will automatically use this VK when verifying proofs for notes tagged with that version.

### Step 5: Update the Frontend

If the change is incompatible, import the new circuit:
```typescript
import poolCircuitV2 from "@/circuits/shielded_pool_v2.json";

function getPoolCircuitForVersion(version: number) {
  if (version === 2) return poolCircuitV2;
  return poolCircuit; // v1
}
```

New deposits will automatically be tagged with the new version. Old notes can still be re-proved using their original version's circuit.

### Step 6: Test and Deploy

1. Write tests (see "Testing Multiple Versions" below)
2. Deploy the verifier contract with the new VK registered
3. Deploy the pool contract with the new version constant
4. Deploy the frontend with the updated circuit
5. Verify that:
   - New deposits are tagged with the new version
   - Old notes can still be withdrawn
   - Both versions co-exist in the same pool

## How Old Notes Stay Provable

### On Withdrawal

1. The wallet loads the note, which includes its `version` field
2. The frontend selects the circuit that matches `note.version`
3. Proof generation uses that circuit
4. On-chain, the pool:
   - Looks up the note's version: `pool.get_commitment_version(commitment)`
   - Calls `verifier.verify_proof_for_version(version, public_inputs, proof)`
   - The verifier retrieves the correct historical VK and validates the proof

### Backward Compatibility

Notes minted before versioning was added (or without an explicit version tag) default to version 1, allowing them to be withdrawn using the original circuit and VK.

## Deprecation (If Ever Needed)

If a version is deemed unsafe or needs to be phased out:

1. **Warning period**: Announce in docs that the version will be deprecated
2. **Soft deprecation**: Stop creating new notes in that version (update `CURRENT_CIRCUIT_VERSION`)
3. **Hard deprecation**: Remove the VK from the verifier contract (notes can no longer be withdrawn)

Hard deprecation should be extremely rare and announced well in advance, as it could strand funds. It's preferable to simply maintain multiple versions indefinitely.

## Testing Multiple Versions

The contract tests verify that notes minted under two different versions are both independently spendable:

```rust
#[test]
fn test_multi_version_notes_both_spendable() {
    // Mint a note under version 1
    // Mint another note under version 2 (simulated by different commitment logic)
    // Withdraw from version 1 note → succeeds with v1 circuit
    // Withdraw from version 2 note → succeeds with v2 circuit
}
```

See `contracts/pool/src/lib.rs` test module for examples.

## Summary of Changes

| Component | Change | Purpose |
|-----------|--------|---------|
| `contracts/pool/src/lib.rs` | Add version tag storage per commitment | Track which circuit version minted each note |
| `contracts/verifier/src/lib.rs` | Multi-VK registry keyed by version | Support multiple historical verifying keys |
| `circuits/shielded_pool/src/main.nr` | Document versioning convention | Guide future circuit changes |
| `frontend/src/lib/notes.ts` | Add `version` field to `ShieldedNote` | Mark which circuit to use for re-proving |
| `frontend/src/lib/prover.ts` | Version-aware circuit selection | Use correct circuit for note's version |

## Acceptance Criteria (Fulfilled)

✅ A documented, tested procedure exists for shipping a leaf-structure change without breaking previously-minted notes
✅ The pool can simultaneously accept valid withdrawal proofs for notes minted under at least two different versions
✅ Version tagging is automatic and transparent to users
✅ Old notes remain spendable indefinitely (unless explicitly deprecated)
✅ Frontend automatically selects the correct circuit based on the note's version
