# Going to mainnet

This document is the honest state of DShield's readiness for real funds, the
deployment procedure, and the things that are still open. It is deliberately
blunt: a privacy pool that loses funds is worse than one that never shipped.

## The short version

**Do not deploy this to mainnet yet.** The protocol works and is well covered
by tests, but it has never been audited by a third party, and the items under
[Blocking](#blocking) below are not optional. Everything else here is the
groundwork so that when those are closed, the deployment itself is boring.

## What changed to make mainnet plausible

Three defects were found and fixed while preparing this. All three were silent
— every test in the repository passed while they were live, because nothing
compared the layers to each other.

1. **The shipped circuits were stale.** `frontend/src/circuits/` and
   `packages/core/src/circuits/` held the pre-multi-asset, pre-relayer-fee
   circuit (12 inputs) while the pool contract decoded seven public inputs from
   the current one (14 parameters). The compiled artifact was simply never
   copied. `just sync-circuits` now does the copy as part of
   `just build-circuits`, and `just verify-circuit-sync` — wired into
   `just test` and CI — fails if a copy drifts again.

2. **The witness builders were missing circuit inputs.** None of the three
   builders passed `asset`; the withdrawal one also omitted `relayer_fee`. Noir
   matches a witness to the ABI by name, so every proof they built aborted
   during witness generation. `packages/core/src/witness-abi.test.ts` now pins
   each builder's field set against its compiled circuit's ABI, plus the pool
   circuit's exact public-input order.

3. **The asset field wasn't reduced modulo the BN254 scalar field.** The pool
   contract reduces a token's 32-byte contract id into the field; the clients
   used the raw bytes. The field's order is only just above 2^254 while a
   contract id is a full 256 bits, so **roughly four in five real addresses
   disagree** — including the testnet XLM SAC. Any note of such an asset would
   have been shielded and then rejected on withdrawal with `AssetMismatch`,
   with the funds unrecoverable. Both sides are now pinned by fixtures:
   `test_asset_field_matches_clients` in the pool contract and the
   `assetToField` cases in `@dshield/core`, covering one address that reduces
   and one that passes through.

The withdraw page and the CLI were also calling the contract with the
pre-multi-asset arity (three arguments where it takes seven), which no unit
test exercised. Both are fixed.

## Blocking

These must be closed before real funds touch this.

- [ ] **Third-party audit.** Nothing in this repository substitutes for one.
      The circuits, the Soroban contracts and the client-side proving all need
      it, and the three defects above are evidence that cross-layer agreement
      is where this system breaks.
- [ ] **Trusted-setup / VK provenance published.** Operators and users need to
      be able to rebuild the circuits and confirm the deployed verifier holds
      the matching key. `just verify-deployment` does the check; the
      reproducible-build instructions and published hashes do not exist yet.
- [ ] **Admin key is a multisig or the timelock, never a single hot key.** The
      deploy recipe takes `POOL_ADMIN` and does not generate it, but nothing
      enforces what it points at. Admin can pause the pool and allow-list
      assets; the timelock covers verifier/VK changes.
- [ ] **Relayer operational plan.** The relayer is a single point of censorship
      (not theft — recipient binding prevents redirection). Decide whether one
      runs at all on mainnet, and what happens when it is down: the app already
      falls back to wallet-signed withdrawals.
- [ ] **Incident procedure.** `pause()` exists. Who can call it, on what
      signal, and how users are told, does not.

## Deploying

```
just deploy-mainnet
```

Required environment:

| Variable         | Meaning                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| `CONFIRM`        | must be exactly `deploy-mainnet` — guards against an accidental run      |
| `DEPLOYER`       | name of an already-funded `stellar keys` identity                       |
| `POOL_ADMIN`     | address that will hold admin on pool + compliance (multisig or timelock) |
| `POOL_ASSETS`    | comma-separated SEP-41 contract ids; the first seeds the pool           |
| `TIMELOCK_DELAY` | optional, seconds before a queued governance change executes (default 86400) |

Derive asset ids with `just asset-id native mainnet` or
`just asset-id USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN mainnet`.

`deploy-mainnet` is a separate recipe from `deploy` on purpose. Almost
everything `deploy` does is wrong with real money at stake: it generates keys,
funds them from a friendbot that doesn't exist on pubnet, issues a test asset it
controls the issuer of, mints a million of them, and writes every one of those
secrets into `frontend/.env.local`. The mainnet recipe creates no keys, funds
nothing, issues nothing, and writes no secret to disk — it emits `.env.mainnet`
with contract ids only, deliberately not `.env.local`, so a development server
cannot silently end up pointed at real funds.

After deploying:

```
just verify-deployment mainnet <verifier-id> <compliance-id>
```

This confirms the on-chain verification keys are the ones your circuits build
to. It is the check that nothing else performs: the contracts, the circuits and
the clients can each be internally consistent while the deployed verifier still
holds an older circuit's key, and the only symptom is that every withdrawal
fails.

## What is disabled on mainnet

These fail safe regardless of configuration, so a misconfigured deploy cannot
reach them:

- **The faucet route** (`/api/faucet`) returns 403 when the network passphrase
  is pubnet's. There is no way to mint test funds against real assets.
- **The dev signing key** (`NEXT_PUBLIC_DEV_SECRET_KEY`) is ignored.
  `NEXT_PUBLIC_*` values are inlined into the client bundle by Next, so
  honouring one on mainnet would publish a spending key to every visitor.

Both are covered by tests (`frontend/src/lib/stellar.test.ts`,
`frontend/src/app/api/faucet/route.test.ts`).

## Operational notes

- **Assets are admin-gated.** `add_asset` / `remove_asset` control what the pool
  accepts. Removing an asset blocks new deposits and withdrawals of it but does
  *not* destroy existing notes — re-adding it makes them spendable again. It is
  a pause, not a confiscation, and `test_withdraw_rejects_asset_removed_from_allow_list`
  pins that behaviour.
- **Every asset shares one tree and one nullifier set.** That is the point:
  splitting per token would fragment the anonymity set. Isolation between
  assets is cryptographic (the leaf commits to the asset), not structural.
- **Adding an asset after launch is safe** but grows the anonymity set slowly —
  early notes in a new asset are a small crowd, and the amounts are visible on
  the transparent side of the pool.
- **Root history churns with withdrawals too**, since each spend appends a
  change leaf. A proof stays valid for roughly 30 state transitions, not 30
  deposits. Stale proofs surface as `RootMismatch`; the app offers a re-sync.

## What is and isn't hidden

Unchanged by multi-asset, and worth restating before anyone relies on it:
deposits and payouts are ordinary token transfers and are **visible on-chain**,
including their amounts and which asset they were in. What is hidden is the
*link* between a deposit and a later withdrawal, how much any given note holds,
and how much shielded value an address controls. Depositing an unusual amount
and immediately withdrawing all of it to the same address is trivially linkable
no matter what the cryptography does.
