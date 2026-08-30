use dep::poseidon::poseidon2::Poseidon2;

global TREE_DEPTH: u32 = 20;

// Domain separation tags — must stay byte-for-byte identical to shielded_pool
// and the frontend's poseidon2 helpers.
global LEAF_DOMAIN: Field        = 0x4c454146;  // "LEAF"
global NULLIFIER_DOMAIN: Field   = 0x4e554c4c;  // "NULL"
global RECURRING_DOMAIN: Field   = 0x52454341;  // "RECA" (RECurring Authorization)

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// Matches shielded_pool's hash_leaf exactly.
fn hash_leaf(nullifier: Field, secret: Field, amount: Field) -> Field {
    hash2(hash2(hash2(LEAF_DOMAIN, nullifier), secret), amount)
}

/// Nullifier hash used to detect double-use of the source note.
fn hash_nullifier(nullifier: Field) -> Field {
    hash2(hash2(NULLIFIER_DOMAIN, nullifier), 0)
}

/// Recurring-authorization commitment.
///
/// Binds every policy parameter into one opaque hash stored on-chain so that
/// the contract can tie a recurring-withdrawal call back to a specific, already-
/// verified authorization without re-running the full proof.
///
/// auth_nullifier  — random per-authorization secret (like a note nullifier,
///                   but for the auth itself).  Stored privately; lets the
///                   owner revoke by revealing it.
/// recipient       — same field encoding as shielded_pool's recipient hash.
/// max_amount      — maximum tokens per occurrence (stroops, 64-bit).
/// period_secs     — minimum seconds between occurrences.
/// max_uses        — total number of permitted withdrawals (1..=255).
fn hash_auth(
    auth_nullifier: Field,
    recipient: Field,
    max_amount: Field,
    period_secs: Field,
    max_uses: Field,
) -> Field {
    // Chain two-input hashes so the frontend can recompute with the same
    // two-input Poseidon2 primitive it already ships.
    hash2(
        hash2(
            hash2(
                hash2(hash2(RECURRING_DOMAIN, auth_nullifier), recipient),
                max_amount,
            ),
            period_secs,
        ),
        max_uses,
    )
}

/// Range-constrains `v` to 64 bits, matching shielded_pool's constrain_u64.
fn constrain_u64(v: Field) -> u64 {
    let narrowed = v as u64;
    assert(narrowed as Field == v);
    narrowed
}

fn constrain_bit(bit: Field) {
    assert(bit * (1 - bit) == 0);
}

fn compute_root(
    leaf: Field,
    path_siblings: [Field; TREE_DEPTH],
    path_bits: [Field; TREE_DEPTH],
) -> Field {
    let mut cur = leaf;
    for i in 0..TREE_DEPTH {
        let sib = path_siblings[i];
        let bit = path_bits[i];
        constrain_bit(bit);
        if bit == 0 {
            cur = hash2(cur, sib);
        } else {
            cur = hash2(sib, cur);
        }
    }
    cur
}

/// Pre-authorizes a bounded recurring withdrawal series from one note.
///
/// Public inputs (verified on-chain by the pool contract):
///   root             — Merkle root proving note membership.
///   note_nullifier_hash — Consumed by the first occurrence; prevents the
///                       authorizing note from being spent again via the
///                       ordinary `withdraw` path.
///   auth_commitment  — H(RECA, auth_nullifier, recipient, max_amount,
///                       period_secs, max_uses); stored on-chain as the
///                       authorization record.
///   recipient        — Recipient hash, same encoding as shielded_pool.
///   max_amount       — Per-occurrence cap (≤ note value, 64-bit).
///   period_secs      — Minimum seconds between occurrences (64-bit).
///   max_uses         — Total occurrences permitted (1..=255, 8-bit).
///   change_commitment — Re-shielded remainder after the first occurrence;
///                       inserted as a leaf on setup, same as a normal spend.
///
/// Private inputs (never leave the user's device):
///   nullifier, secret, amount — Note opening.
///   auth_nullifier            — Per-auth random secret (enables revocation).
///   change_nullifier, change_secret — Keys for the change note.
///   path_siblings, path_bits  — Merkle proof.
pub fn main(
    // Public
    root: pub Field,
    note_nullifier_hash: pub Field,
    auth_commitment: pub Field,
    recipient: pub Field,
    max_amount: pub Field,
    period_secs: pub Field,
    max_uses: pub Field,
    change_commitment: pub Field,
    // Private
    nullifier: Field,
    secret: Field,
    amount: Field,
    auth_nullifier: Field,
    change_nullifier: Field,
    change_secret: Field,
    path_siblings: [Field; TREE_DEPTH],
    path_bits: [Field; TREE_DEPTH],
) {
    // ── 1. Value constraints ─────────────────────────────────────────────────
    // The note amount and per-occurrence max are both 64-bit.
    let amount_u64      = constrain_u64(amount);
    let max_amount_u64  = constrain_u64(max_amount);
    // Each occurrence withdraws at most max_amount; max_amount must fit in
    // the note so the first occurrence is always feasible.
    assert(max_amount_u64 <= amount_u64);
    // max_uses fits in 8 bits (1..=255).  Zero would mean "never execute",
    // which is pointless and likely a mistake.
    let max_uses_u64 = constrain_u64(max_uses);
    assert(max_uses_u64 >= 1);
    assert(max_uses_u64 <= 255);
    // period_secs is a 64-bit duration.
    let _ = constrain_u64(period_secs);

    // ── 2. Note membership ───────────────────────────────────────────────────
    let leaf = hash_leaf(nullifier, secret, amount);
    let nf   = hash_nullifier(nullifier);
    assert(nf == note_nullifier_hash);
    let computed_root = compute_root(leaf, path_siblings, path_bits);
    assert(computed_root == root);

    // ── 3. Authorization commitment ──────────────────────────────────────────
    let expected_auth = hash_auth(auth_nullifier, recipient, max_amount, period_secs, max_uses);
    assert(expected_auth == auth_commitment);

    // ── 4. Change note ───────────────────────────────────────────────────────
    // The first occurrence takes max_amount; the re-shielded remainder is
    // amount - max_amount.  Using max_amount for the first draw is conservative
    // (the relayer may draw less on later calls, but never more).
    let change = amount - max_amount;
    let expected_change = hash_leaf(change_nullifier, change_secret, change);
    assert(expected_change == change_commitment);

    // ── 5. Recipient is referenced ───────────────────────────────────────────
    // Keeps the public input from being optimised away.  Binding to the actual
    // Stellar address is enforced on-chain (same approach as shielded_pool).
    assert(recipient == recipient);
}
