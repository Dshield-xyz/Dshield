# DShield Threat Model

This document separates properties enforced by DShield's Noir circuits from
properties enforced by Soroban contracts and from operational assumptions. It
describes the current variable-amount note design.

## Security boundaries

| Component | Enforced properties | External assumptions |
| --- | --- | --- |
| `shielded_pool` circuit | Note membership and opening; nullifier derivation; 64-bit note and withdrawal amounts; `withdraw_amount <= amount`; change commitment for `amount - withdraw_amount`. | Its public recipient field is not derived from a Stellar address. |
| Pool contract | Known-root check, nullifier uniqueness, recipient-address binding, proof verification, change insertion, and token transfer. | The configured verifier and token are trusted deployments. A relayer can censor or delay, but cannot redirect a valid withdrawal. |
| `compliance` circuit | KYC-preimage knowledge, note ownership, equality of the disclosed and committed amounts, 64-bit range, and auditor scoping. | KYC eligibility is an administrative policy decision. |
| `disclosure` circuit | KYC and note ownership plus `amount >= threshold`, without revealing the note amount. | The threshold's legal meaning and auditor-key ownership are external policy. |
| Compliance contract | Registered-KYC and approved-pool-root checks, proof verification, and administrator authorization for registry, pool, and key changes. | The administrator is trusted to register correct hashes, pools, and verification keys. |
| `hasher` circuit | One two-input Poseidon2 hash. | Domain separation and structure must be supplied correctly by callers. |

## Trust and data flow

```mermaid
flowchart LR
    User[User wallet] -->|note opening and Merkle path| Spend[shielded_pool circuit]
    User -->|KYC preimage and note opening| Disclosure[compliance or disclosure circuit]
    Spend -->|proof and public inputs| Relayer[Relayer]
    Relayer -->|recipient address and proof| Pool[Pool contract]
    Pool -->|verify| Verifier[Configured verifier]
    Pool -->|derive and compare recipient hash| Recipient[Stellar recipient]
    Pool -->|consume nullifier and append change| State[Persistent pool state]
    Pool -->|transfer public amount| Token[Configured token]
    Disclosure -->|proof, root, KYC hash, auditor scope| Registry[Compliance contract]
    Registry -->|confirm root| Pool
    Registry -->|verify| Verifier
    Admin[Administrator] -->|KYC hashes, pools, and keys| Registry
```

The relayer is outside the cryptographic trust boundary. It sees public
withdrawal data and can refuse to submit it, but cannot change the payout
address while retaining a valid proof.

## Amount integrity and value conservation

A note commits to its value as
`H(H(H(LEAF_DOMAIN, nullifier), secret), amount)`. The shielded-pool,
compliance, and disclosure circuits use the same construction, so a valid
Merkle-membership proof pins the private `amount` witness to the original note.

The shielded-pool circuit passes `amount` and `withdraw_amount` through
`constrain_u64`, verifies `withdraw_amount <= amount`, and commits the change
for `amount - withdraw_amount`. The round-trip assertion in `constrain_u64` is
load-bearing: a bare Noir `as u64` truncates without constraining the source.
Without it, a near-modulus field value could wrap to a small integer and make
field arithmetic disagree with the comparison. The pool also rejects public
amount inputs with nonzero bytes above the low 64 bits instead of truncating.

## Recipient binding

Recipient binding deliberately crosses the circuit/contract boundary:

1. The circuit exposes `recipient`, but `assert(recipient == recipient)` only
   prevents compiler elimination; it does not constrain a Stellar address.
2. The pool derives `recipient_hash_from_address` from the payout address and
   compares it with the proof's public recipient field.
3. A mismatch is rejected before the token transfer.

Anti-front-running therefore depends on this contract comparison. Removing it
would allow a proof to remain valid while the payout address changes.

## Nullifiers and replay protection

The circuit proves that the public nullifier hash derives from the private
nullifier, but cannot prove global uniqueness. The pool owns that stateful
guarantee: it rejects an existing persistent-storage entry and records each
successful spend. All withdrawals must use the same authoritative pool state.

## Circuit-specific guarantees

### Shielded pool

- Proves membership against the public root using a 20-level Merkle path and
  constrains each path selector to a bit.
- Binds nullifier, secret, and amount into the spent leaf.
- Enforces value conservation and a correctly formed change note.
- Leaves address binding to the pool contract.

### Compliance

- Binds the KYC preimage to the public KYC hash.
- Proves note ownership and that the disclosed amount equals its committed
  value.
- Depends on the contract to confirm KYC registration and an approved pool root.

### Disclosure

- Provides the same KYC and note-ownership guarantees as compliance.
- Proves the committed note amount meets the public threshold.
- Does not establish the policy meaning of KYC status or the threshold.

### Hasher

The hasher is a compatibility primitive. Security properties such as domain
separation and note structure come from how callers chain its hashes.

## Residual assumptions

- Verification keys, pool addresses, token addresses, and administrators are
  configured correctly.
- Users protect and retain note secrets, nullifiers, and KYC preimages.
- Frontend and relayer software encode public inputs exactly as contracts expect.
- Public token transfers reveal deposit and withdrawal amounts and addresses;
  privacy breaks the link between them rather than hiding either event.
- Poseidon2 implementations in Noir, the frontend, and Soroban remain
  byte-for-byte compatible.

See [SECURITY.md](../SECURITY.md) for browser-storage, rate-limiting, reporting,
and deployment limitations.
