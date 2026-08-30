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

## 🚧 Remaining Work

### Frontend Integration

#### `frontend/src/app/deposit/page.tsx`

- ⏳ **TODO**: Add asset selector dropdown/input
- ⏳ **TODO**: Update `buildNote()` to accept and include `asset` parameter
- ⏳ **TODO**: Pass `asset` to `computeCommitment()` when building note
- ⏳ **TODO**: Pass `asset` to contract `deposit` call
- ⏳ **TODO**: Update UI to show which asset is being deposited
- ⏳ **TODO**: Handle asset validation errors from contract

#### `frontend/src/app/withdraw/page.tsx`

- ⏳ **TODO**: Display asset information for each note in the note list
- ⏳ **TODO**: Update `buildChangeNote()` to accept and include `asset` parameter
- ⏳ **TODO**: Pass note's `asset` to `computeCommitment()` when building change note
- ⏳ **TODO**: Pass note's `asset` to `proveWithdrawal()`
- ⏳ **TODO**: Pass note's `asset` to contract `withdraw` call
- ⏳ **TODO**: Update UI to show which asset is being withdrawn

#### `frontend/src/lib/stellar.ts`

- ⏳ **TODO**: Update `buildContractCall()` for deposits to handle per-asset token transfers
- ⏳ **TODO**: Add `getAssetSacId(asset: Address)` or similar to resolve asset addresses
- ⏳ **TODO**: Update trustline and faucet logic to handle multiple assets (if needed)
- ⏳ **TODO**: Consider adding `getPoolAssets()` to query allow-listed assets from contract

### Testing

#### Contract Tests

- ⏳ **TODO**: Test depositing two distinct assets into the same pool
- ⏳ **TODO**: Test withdrawing asset A with a proof (should succeed)
- ⏳ **TODO**: Test withdrawing asset B with a proof for asset A (should fail with `AssetMismatch`)
- ⏳ **TODO**: Test `add_asset()` / `remove_asset()` admin functions
- ⏳ **TODO**: Test rejection of unsupported asset deposits/withdrawals
- ⏳ **TODO**: Test `get_assets()` returns correct allow-list

#### Frontend Tests

- ⏳ **TODO**: Test note serialization/deserialization with asset field
- ⏳ **TODO**: Test compact encoding/decoding with asset field
- ⏳ **TODO**: Test `computeCommitment()` with asset parameter
- ⏳ **TODO**: Test `assetToField()` conversion

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
