# Multi-Asset Support Implementation Status

## Overview

This document tracks the implementation of multi-asset support, allowing a single DShield pool instance to hold shielded notes for multiple SEP-41 assets simultaneously.

## ✅ Completed Items

### Backend (Contracts & Circuits)

#### `contracts/pool/src/lib.rs`

- ✅ Asset allow-list storage with `key_asset_prefix()` and `key_asset_list()`
- ✅ `add_asset()` - Admin function to allow-list new assets
- ✅ `remove_asset()` - Admin function to remove assets from allow-list
- ✅ `is_asset_supported()` - Check if asset is on allow-list
- ✅ `get_assets()` - Retrieve all allow-listed assets
- ✅ `asset_id_from_address()` - Convert SEP-41 token address to field element
- ✅ `deposit()` - Takes explicit `asset` parameter and validates against allow-list
- ✅ `deposit_batch()` - Takes explicit `asset` parameter for batch deposits
- ✅ `withdraw()` - Takes explicit `asset` parameter and validates proof's asset matches
- ✅ Asset binding enforcement in withdrawal proof verification
- ✅ New error types: `AssetNotSupported`, `AssetMismatch`, `UnsupportedAsset`
- ✅ Events: `AssetAddedEvent`, `AssetRemovedEvent`

#### `circuits/shielded_pool/src/main.nr`

- ✅ `asset` added as 6th public input to the circuit
- ✅ `hash_leaf()` updated to include `asset` in the commitment chain: `H(H(H(H(LEAF_DOMAIN, nullifier), secret), amount), asset)`
- ✅ Asset binding ensures proof for asset A cannot withdraw asset B

#### `circuits/compliance/src/main.nr`

- ✅ `asset` added as private witness
- ✅ `hash_leaf()` updated to match shielded_pool circuit
- ✅ Merkle membership proves the note is worth exactly `amount` of `asset`

#### `circuits/disclosure/src/main.nr`

- ✅ `asset` added as private witness
- ✅ `hash_leaf()` updated to match shielded_pool circuit
- ✅ Threshold comparison applies to the real asset the note holds

### Frontend

#### `frontend/src/lib/poseidon2.ts`

- ✅ `computeCommitment()` updated to take 4th parameter `asset` and hash it: `H(H(H(H(LEAF_DOMAIN, nullifier), secret), amount), asset)`
- ✅ `assetToField()` - New function to convert SEP-41 contract address to field element (matches contract's `asset_id_from_address`)

#### `frontend/src/lib/notes.ts`

- ✅ `ShieldedNote` interface updated with `asset: string` field
- ✅ `serializeNote()` updated to include asset (v1 format now 9 fields instead of 8)
- ✅ `parseNoteV1()` updated to parse 9-field format with asset
- ✅ Compact encoding updated: `COMPACT_LENGTH` increased by 32 bytes for asset field
- ✅ `encodeNoteCompact()` updated to encode asset field
- ✅ `decodeNoteCompact()` updated to decode asset field

#### `frontend/src/lib/prover.ts`

- ✅ `proveWithdrawal()` updated to take `asset` input and pass it to circuit
- ✅ `proveCompliance()` updated to take `asset` input
- ✅ `proveDisclosure()` updated to take `asset` input

## ✅ Also completed (previously listed under Remaining Work)

The initial version of this migration left the contract and its test suite in
a state that did not compile (two missing braces and an enum discriminant
collision in `contracts/pool/src/lib.rs`, ~100 test call sites and the
`Prover.toml` circuit fixtures never updated for the new `asset` parameter),
and the frontend pages/tests below were still calling the old, pre-asset
signatures. That has since been fixed so the whole repo builds and tests
green again:

- `frontend/src/app/deposit/page.tsx`: `buildNote()` takes and hashes `asset`;
  the `deposit` contract call passes it; the button disables with an
  "Asset not configured" state if none is available.
- `frontend/src/app/withdraw/page.tsx`: `buildChangeNote()`, `computeCommitment()`,
  `proveWithdrawal()`, and the `withdraw` contract call (both the relayed and
  direct wallet-signed paths) all thread the spent note's `asset` through.
- `frontend/src/lib/stellar.ts` / the `relay-withdraw*` API routes: resolve the
  withdrawn asset from the client-supplied `asset` field instead of the
  now-removed `get_token` view (replaced by the allow-list's `get_assets`).
- `contracts/pool/src/lib.rs`'s test suite (~100 call sites) and
  `circuits/{shielded_pool,compliance,disclosure}/Prover.toml` (recomputed
  `root`/`change_commitment` fixtures with a real `asset` value) now build and
  pass against the current signatures.
- `frontend/src/lib/poseidon2.test.ts`, `prover.test.ts`, `notes.test.ts`,
  `viewDisclosure.test.ts`, `stellar.test.ts` updated for the `asset`
  parameter/field everywhere it's now required.

None of the above adds an asset **selector** — every one of these call sites
still resolves to this deployment's single configured USDC SAC
(`getUsdcSacId()`). What's genuinely still missing is the UI to choose among
several allow-listed assets; see below.

## 🚧 Remaining Work

### Frontend Integration

#### `frontend/src/app/deposit/page.tsx`

- ⏳ **TODO**: Add asset selector dropdown/input (currently always deposits into `getUsdcSacId()`)
- ⏳ **TODO**: Update UI to show which asset is being deposited
- ⏳ **TODO**: Handle asset validation errors from contract (e.g. `AssetNotSupported`) with a friendly message

#### `frontend/src/app/withdraw/page.tsx`

- ⏳ **TODO**: Display asset information for each note in the note list
- ⏳ **TODO**: Update UI to show which asset is being withdrawn

#### `frontend/src/lib/stellar.ts`

- ⏳ **TODO**: Add `getAssetSacId(asset: Address)` or similar to resolve arbitrary asset addresses, not just the demo USDC SAC
- ⏳ **TODO**: Update trustline and faucet logic to handle multiple assets (if needed)
- ⏳ **TODO**: Consider adding `getPoolAssets()` to query allow-listed assets from contract, to populate an asset selector

### Testing

#### Contract Tests

- ⏳ **TODO**: Test depositing two distinct assets into the same pool
- ⏳ **TODO**: Test withdrawing asset A with a proof (should succeed)
- ⏳ **TODO**: Test withdrawing asset B with a proof for asset A (should fail with `AssetMismatch`)
- ⏳ **TODO**: Test `add_asset()` / `remove_asset()` admin functions
- ⏳ **TODO**: Test rejection of unsupported asset deposits/withdrawals
- ⏳ **TODO**: Test `get_assets()` returns correct allow-list

#### Frontend Tests

- ✅ Note serialization/deserialization with asset field (`notes.test.ts`)
- ✅ Compact encoding/decoding with asset field (`notes.test.ts`)
- ✅ `computeCommitment()` with asset parameter, including asset-binding (`poseidon2.test.ts`)
- ⏳ **TODO**: Test `assetToField()` conversion directly

### Documentation

- ⏳ **TODO**: Update `README.md` to explain multi-asset support
- ⏳ **TODO**: Update `DESIGN.md` to remove single-denomination/single-asset descriptions
- ⏳ **TODO**: Add examples of how to use multiple assets in the same pool

## Key Design Decisions

1. **Asset Binding in Leaf**: The asset is bound into the leaf commitment alongside the amount: `H(H(H(H(LEAF_DOMAIN, nullifier), secret), amount), asset)`. This ensures a proof for one asset cannot open a note of another.

2. **Field Element Conversion**: Assets are identified by their SEP-41 contract address (C...), which is converted to a BN254 field element by reducing the 32-byte contract ID modulo the scalar field. This matches across frontend, circuit, and contract.

3. **Allow-List Model**: The pool maintains an admin-managed allow-list of supported assets. This prevents arbitrary assets from being deposited and provides a control mechanism.

4. **Shared Tree & Nullifier Set**: All assets share the same Merkle tree and nullifier set, maximizing the anonymity set rather than fragmenting it per-asset.

5. **Backward Compatibility**: The note format version remains v1 but now has 9 fields instead of 8. Old 8-field notes won't parse with the new code (intentionally, as they lack the required asset field).

## Acceptance Criteria

- [ ] A single deployed pool instance can hold shielded notes for at least two distinct SEP-41 assets simultaneously
- [ ] The tree and nullifier set are shared across all assets
- [ ] A proof generated for asset A cannot be used to withdraw asset B (enforced by circuit constraints)
- [ ] The contract rejects withdrawals where the proof's asset doesn't match the requested payout asset
- [ ] Frontend allows users to select which asset to deposit/withdraw
- [ ] All tests pass with multi-asset scenarios

## Next Steps

1. **Implement Frontend UI Changes**
   - Add asset selector to deposit page
   - Update note display to show asset information
   - Wire up asset parameter through the deposit/withdraw flows

2. **Update stellar.ts for Multi-Asset Support**
   - Handle per-asset token client resolution
   - Update trustline/faucet logic if needed

3. **Write Tests**
   - Contract-level tests for multi-asset scenarios
   - Frontend tests for note handling with assets

4. **Update Documentation**
   - README with multi-asset examples
   - DESIGN.md to reflect new architecture

## Notes

- The circuits already include the asset field as expected by the updated implementation
- The pool contract is fully ready for multi-asset operations
- Most frontend infrastructure is in place; main work is UI integration
- The asset allow-list model provides flexibility while maintaining security
