# DShield Threat Model

This document separates properties enforced by DShield's Noir circuits from
properties enforced by Soroban contracts and from operational assumptions. It
describes the current variable-amount note design.

## Security boundaries

| Component | Enforced properties | External assumptions |
| --- | --- | --- |
| `shielded_pool` circuit | Note membership and opening; nullifier derivation; 64-bit note and withdrawal amounts; `withdraw_amount <= amount`; change commitment for `amount - withdraw_amount`. | Its public recipient field is not derived from a Stellar address. |
| Pool contract | Known-root check, nullifier uniqueness, recipient-address binding, proof verification, change insertion, token transfer, and timelock-only gating of verifier/admin changes. | The configured verifier and token are trusted deployments. A relayer can censor or delay, but cannot redirect a valid withdrawal. |
| `compliance` circuit | KYC-preimage knowledge, note ownership, equality of the disclosed and committed amounts, and 64-bit range. | KYC eligibility is an administrative policy decision. The `auditor_key` public input is not checked against a registry -- see [Auditor-key binding](#auditor-key-binding). |
| `disclosure` circuit | KYC and note ownership plus `amount >= threshold`, without revealing the note amount. | The threshold's legal meaning is external policy. The `auditor_key` public input is not checked against a registry -- see [Auditor-key binding](#auditor-key-binding). |
| Compliance contract | Registered-KYC and approved-pool-root checks, proof verification, administrator authorization for registry changes, and timelock-only gating of admin/disclosure-VK changes. | The administrator is trusted to register correct hashes and pools. The configured timelock is a trusted deployment -- see [Timelock governance](#timelock-governance). |
| Governance (timelock) contract | Queues a call (target, function, args) with a fixed delay set at deployment; executes only after the delay elapses and only if not cancelled; cancellation is admin-only. | The governance admin is trusted to queue only intended changes and to use cancellation responsibly -- see [Timelock governance](#timelock-governance). |
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
    Disclosure -->|proof, root, KYC hash, auditor key| Registry[Compliance contract]
    Registry -->|confirm root| Pool
    Registry -->|verify| Verifier
    Admin[Administrator] -->|KYC hashes and pools| Registry
    GovAdmin[Governance admin] -->|queue, cancel| Governance[Governance/timelock contract]
    Governance -->|execute after delay: set_verifier, admin rotation| Pool
    Governance -->|execute after delay: propose_admin, set_disclosure_vk| Registry
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

## Auditor-key binding

`compliance` and `disclosure` both take `auditor_key` as a public input and
reference it inside an unconstrained Poseidon2 hash whose result is discarded
(assigned to `let _auditor_key_referenced = ...`, never asserted). That hash
adds nothing on its own.

What actually holds, and why:

1. Because `auditor_key` is a `pub` argument to `main`, it is part of the
   public-input vector the proof is verified against. A proof generated for
   `auditor_key = A` fails verification if the public inputs are changed to
   `auditor_key = B` -- this is a property of the proof system binding proof
   validity to its exact public inputs, not something the circuit body has to
   additionally enforce.
2. What is *not* checked, at either the circuit or the compliance contract:
   that `auditor_key` corresponds to a real, registered auditor. The
   compliance contract's storage holds KYC hashes, approved pools, and the
   disclosure VK -- no auditor registry exists. A prover may set `auditor_key`
   to any `Field` value and produce a valid proof "addressed to" it.

So a disclosure proof cannot be silently redirected to a different auditor
after the fact, but nothing stops a user from generating one "for" an
auditor key nobody controls, and nothing on-chain distinguishes a real
auditor's key from an arbitrary one. Treat `auditor_key` as an opaque tag
carried through the system, not as an access-control mechanism.

## Timelock governance

Every privileged operation that can change what pool/compliance trust --
`set_verifier` and admin rotation on the pool, `propose_admin` and
`set_disclosure_vk` on compliance -- previously took effect the instant the
admin's transaction confirmed, with no delay or visibility window. A single
compromised or malicious admin key could swap in a bad verifier contract or
VK and have it live before any user could react.

These entry points are now gated behind a `contracts/governance` timelock
instead of a direct `admin.require_auth()`:

1. Pool and compliance are each configured (at construction) with the
   address of a deployed `GovernanceContract`. Their gated functions call
   `require_timelock`, which requires that the timelock contract itself is
   the caller (`timelock.require_auth()`) -- something only true when the
   call arrives via that contract's own `execute`, never a direct admin
   transaction.
2. Changing `set_verifier`, `propose_admin`, or `set_disclosure_vk` requires
   the governance admin to `queue` the call, wait out a fixed delay set at
   the governance contract's deployment, then `execute` it. `execute` is
   callable by anyone once the delay has elapsed, so the change doesn't
   depend on the admin remembering a second step.
3. A queued call can be `cancel`led by the governance admin at any time
   before it executes -- the safety valve if a queued change turns out to be
   wrong.

This bounds an admin-key compromise (or a bad-faith admin) to: the change is
visible on-chain for the full delay before it can take effect, and the
`cancel` path exists as long as the governance admin key itself isn't also
compromised. `pause`/`unpause` are deliberately **not** gated -- a circuit
breaker that itself has to wait out a delay before pausing a discovered bug
defeats the point of a circuit breaker.

The governance admin (who can queue and cancel) and the governance delay are
themselves trust assumptions this doesn't remove: a queued call is only as
trustworthy as whoever queued it, and the delay is a visibility window, not
a veto -- nothing on-chain stops the delay from elapsing and the call
executing if nobody acts on what they saw queued.

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
- Carries `auditor_key` as an opaque public input; does not check it against
  a registry -- see [Auditor-key binding](#auditor-key-binding).

### Disclosure

- Provides the same KYC and note-ownership guarantees as compliance.
- Proves the committed note amount meets the public threshold.
- Does not establish the policy meaning of KYC status or the threshold.
- Same unchecked `auditor_key` as compliance.

### Hasher

The hasher is a compatibility primitive. Security properties such as domain
separation and note structure come from how callers chain its hashes.

## Residual assumptions

- Verification keys, pool addresses, token addresses, and administrators are
  configured correctly.
- The governance timelock's delay and admin are configured correctly at
  deployment, and the governance admin key is not itself compromised -- see
  [Timelock governance](#timelock-governance).
- Users protect and retain note secrets, nullifiers, and KYC preimages. This
  is not purely a user-diligence assumption today: the deposit flow persists
  a note to `localStorage` only after `submitTransaction` resolves, with an
  unbounded confirmation poll in between, so a closed tab in that window can
  strand a confirmed deposit with no recoverable secret. Tracked as a bug,
  not a design assumption, in issue #63.
- No registry constrains `auditor_key` to real auditors -- see
  [Auditor-key binding](#auditor-key-binding).
- Frontend and relayer software encode public inputs exactly as contracts expect.
- Public token transfers reveal deposit and withdrawal amounts and addresses;
  privacy breaks the link between them rather than hiding either event.
- Poseidon2 implementations in Noir, the frontend, and Soroban remain
  byte-for-byte compatible.

See [SECURITY.md](../SECURITY.md) for browser-storage, rate-limiting, reporting,
and deployment limitations.
