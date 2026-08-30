# DShield Threat Model

This document separates properties enforced by DShield's Noir circuits from
properties enforced by Soroban contracts and from operational assumptions. It
describes the current variable-amount note design.

The formal/symbolic CI harness in
[FORMAL_VERIFICATION.md](FORMAL_VERIFICATION.md) checks the named circuit
relations below against compiled Nargo artifacts. Its coverage is intentionally
limited; it is a guardrail for invariant drift, not a substitute for an
external audit.

## Security boundaries

| Component | Enforced properties | External assumptions |
| --- | --- | --- |
| `shielded_pool` circuit | Note membership and opening; nullifier derivation; 64-bit note and withdrawal amounts; `withdraw_amount <= amount`; change commitment for `amount - withdraw_amount`. | Its public recipient field is not derived from a Stellar address. |
| Pool contract | Known-root check, nullifier uniqueness, recipient-address binding, proof verification, change insertion, and token transfer. | The configured verifier and token are trusted deployments. A relayer can censor or delay, but cannot redirect a valid withdrawal. |
| `compliance` circuit | KYC-preimage knowledge, note ownership, equality of the disclosed and committed amounts, and 64-bit range. | KYC eligibility is an administrative policy decision. The `auditor_key` public input is not checked against a registry -- see [Auditor-key binding](#auditor-key-binding). |
| `disclosure` circuit | KYC and note ownership plus `amount >= threshold`, without revealing the note amount. | The threshold's legal meaning is external policy. The `auditor_key` public input is not checked against a registry -- see [Auditor-key binding](#auditor-key-binding). |
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
    Disclosure -->|proof, root, KYC hash, auditor key| Registry[Compliance contract]
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

---

## Recurring authorizations

`authorize_recurring` lets a user pre-prove ownership of a note and bind a
policy tuple `(recipient, max_amount, period_secs, max_uses)` to an on-chain
record.  Subsequent occurrences are triggered by the relayer (or any caller)
without a new ZK proof.

### What the proof guarantees

| Property | How it is enforced |
| --- | --- |
| Note ownership | Same Merkle-membership check as a normal withdrawal; source note nullifier is consumed during setup. |
| Recipient binding | Proof commits to `recipient`; contract recomputes `recipient_hash_from_address` and rejects mismatches before any state change. |
| Policy commitment | `auth_commitment = H(RECA, auth_nullifier, recipient, max_amount, period_secs, max_uses)`; verified in-circuit so no parameter can be altered after the proof is made. |
| Amount safety | `max_amount` and `amount` are both range-constrained to 64 bits; circuit asserts `max_amount ≤ amount`. |
| Change note | Circuit commits the re-shielded remainder `amount − max_amount`; inserted on-chain atomically during `authorize_recurring`. |

### What the contract enforces on every occurrence

The relayer calls `withdraw_recurring(auth_commitment, payout)`.  No proof is
verified at this point; the constraints below replace it:

- `payout ≤ auth.max_amount` — per-call cap.
- `now ≥ auth.last_withdraw_ts + auth.period_secs` — time-lock.
- `auth.uses_remaining > 0` — use-count guard.
- `!auth.revoked` — revocation flag.

These are on-chain state checks, not ZK proofs.  They are correct but weaker
than a per-call proof: a compromise of the contract (e.g. a future upgrade bug)
would bypass them.  The original setup proof is, by contrast, unforgeable.

### Exposure if the `auth_nullifier` secret leaks

The `auth_nullifier` is stored in the user's `localStorage` alongside the auth
record.  It is used only to call `revoke_recurring`, which requires a signed
transaction from the authorized `recipient` address anyway.  Leaking the
`auth_nullifier` alone does **not** enable an attacker to perform additional
withdrawals — it only enables early revocation.

Contrast with a leaked note secret in today's one-shot withdrawal flow: that
leaks the entire remaining note balance.  A recurring authorization leaks at
most `max_amount × uses_remaining` of future withdrawals, and only to the
pre-committed recipient.

### Worst-case exposure comparison

| Leaked secret | One-shot withdrawal | Recurring authorization |
| --- | --- | --- |
| Note nullifier + secret | Full note balance (unbounded) | Not applicable — note consumed at setup |
| `auth_nullifier` | N/A | Only revocation — no extra payout |
| Relayer account | Can censor/delay; cannot redirect funds | Same |

### Residual risks

- **Relayer liveness** — occurrences only execute if the relayer submits them.
  A stopped or censoring relayer delays payments but cannot steal them.  The
  owner can call `withdraw_recurring` directly at any time.
- **Scheduler over-firing** — a cron job that calls the relay route more
  frequently than `period_secs` receives `PeriodNotElapsed` (HTTP 200,
  `status: "skipped"`) and causes no harm.
- **`localStorage` XSS exposure** — the auth record, auth nullifier, and change
  note are stored in plaintext localStorage, subject to the same XSS caveat as
  all other DShield note secrets.  See the plaintext-localStorage warning in
  README.md and SECURITY.md.
- **No per-occurrence proof** — the relayer executes against pre-committed
  parameters.  It cannot forge additional occurrences or exceed the `max_amount`
  cap, but it can execute occurrences up to `max_uses` without the owner
  manually approving each one.  This is intentional (that is the whole point of
  the feature) and bounded by `max_uses` and the per-call `max_amount` cap.
- **Revocation latency** — `revoke_recurring` is a signed Stellar transaction.
  Between the time the owner decides to revoke and the ledger confirming that
  transaction, one more occurrence may execute if the relayer fires at exactly
  the right moment.  Owners should factor in one additional occurrence when
  deciding whether to revoke.
- **Auth commitment key collision** — `auth_commitment` is a Poseidon2 hash
  over all policy parameters.  Collisions are computationally infeasible under
  the BN254 security assumption.  A duplicate `auth_commitment` is rejected by
  `authorize_recurring` with `CommitmentExists`.
