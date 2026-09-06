# Multi-Asset Support

A single DShield pool instance holds shielded notes for many SEP-41 assets at
once — native XLM included — over one shared Merkle tree and nullifier set.

**Status: complete.** The acceptance criteria below are met and covered by
tests. This file is kept as the design record; for deployment, see
[MAINNET.md](MAINNET.md).

## How it works

The asset is bound into the note's leaf commitment alongside the amount:

```
commitment = H(H(H(H(LEAF_DOMAIN, nullifier), secret), amount), asset)
```

`asset` is the token's 32-byte SEP-41 contract id **reduced modulo the BN254
scalar field**. That reduction is load-bearing, not cosmetic: the field's order
is only just above 2^254 while a contract id is a full 256 bits, so about four
in five real Stellar addresses are larger than the modulus and reduce to a
different value. A client that skips it commits the note to an asset the
contract never derives, and the pool rejects every withdrawal of it with
`AssetMismatch` — funds shielded and unspendable. Three implementations must
agree byte for byte:

| Layer     | Implementation                                                    |
| --------- | ------------------------------------------------------------------ |
| Contract  | `asset_id_from_address` (`contracts/pool/src/lib.rs`)               |
| Clients   | `assetFieldFromContractId` / `assetToField` (`@dshield/core`)       |
| Circuit   | the `asset` public input, hashed into `hash_leaf`                   |

They are pinned against each other by `test_asset_field_matches_clients` (Rust)
and the `assetToField` cases in `packages/core/src/poseidon2.test.ts`, using one
address that reduces and one that passes through — so an implementation that
dropped the reduction cannot pass by luck.

## Why one pool rather than one per asset

Splitting per token would fragment the anonymity set three ways, exactly the
problem that dropping fixed denominations solved. Instead every asset shares one
tree and one nullifier set, and isolation between assets is cryptographic: a
proof built for asset A cannot open a note committing to asset B, because the
leaf it would have to reproduce is a different hash. The contract closes the
loop on-chain by re-deriving the asset field from the token it is about to pay
out and rejecting any mismatch, so the guarantee does not rest on the client
naming the right asset.

## Allow-list model

The pool keeps an admin-managed allow-list (`add_asset` / `remove_asset` /
`is_asset_supported` / `get_assets`). Deposits and withdrawals of anything else
are rejected with `AssetNotSupported`.

Removing an asset is a **pause, not a confiscation**: existing notes survive and
become spendable again if the asset is re-added. `add_asset` rejects an account
(`G…`) address, since one has no contract-id payload and so could never produce
an asset field a proof can name.

## Acceptance criteria

- [x] One pool instance holds notes for at least two distinct SEP-41 assets
      simultaneously — `test_pool_holds_two_assets_over_one_tree`
- [x] The tree and nullifier set are shared across assets — same test asserts
      both leaves land in one tree in deposit order
- [x] A proof for asset A cannot withdraw asset B —
      `test_withdraw_rejects_proof_for_a_different_asset`, which also checks the
      matching asset gets *past* the binding, so the rejection is the asset
      check and not an artefact of the fixture
- [x] Deposits of a non-allow-listed asset are rejected —
      `test_deposit_rejects_asset_not_on_allow_list`
- [x] `add_asset` / `remove_asset` / `get_assets` behave —
      `test_add_asset_is_idempotent_and_admin_gated`,
      `test_remove_asset_drops_it_from_the_list`,
      `test_add_asset_rejects_a_non_contract_address`
- [x] A de-listed asset's notes are not destroyed —
      `test_withdraw_rejects_asset_removed_from_allow_list`
- [x] The frontend lets users pick which asset to shield — asset picker on the
      deposit page, populated from the pool's on-chain allow-list
- [x] The CLI can target an asset — `dshield deposit --asset XLM`, matched
      against the allow-list rather than trusted

## Client behaviour

- **Asset metadata is read from the chain**, not hardcoded: `get_assets` on the
  pool, then `symbol()` / `decimals()` on each token. The SAC reports native
  XLM's symbol as the string `"native"`, which is mapped to `XLM` for display.
- **Nothing falls back to "probably USDC."** If the allow-list can't be read the
  deposit button stays disabled and says why — shielding into an asset the pool
  doesn't hold would mint a note it will never pay out.
- **Amounts are parsed and rendered at each asset's own precision.** A
  6-decimal token formatted at 7 shows every balance ten times too small, and an
  amount parsed at the wrong scale produces an unspendable note. `toBaseUnits` /
  `fromBaseUnits` / `formatUnits` take `decimals` explicitly; the USDC-shaped
  helpers remain only as deprecated wrappers.
- **Trustlines are per asset and skip XLM**, which needs none. When an asset
  needs a trustline the app can't open — a SAC's id is a hash, so only a
  configured classic asset can be turned back into a `changeTrust` — it says so
  rather than failing later inside the wallet.
- **Notes carry their asset** in both serialization formats (the dash-joined
  backup string and the compact link encoding), so a note is self-describing.

## Note format

Note version stays `v1`, now with 9 dash-joined fields:

```
dshield-v1-<poolId>-<leafIndex>-<amount>-<asset>-<commitment>-<nullifier>-<secret>
```

Notes from any earlier pool — fixed-denomination or single-asset — are not
portable, and neither is the 8-field format. This is intentional: an old note's
leaf commits to a different hash than the current circuit computes.
