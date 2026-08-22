use dep::poseidon::poseidon2::Poseidon2;

global TREE_DEPTH: u32 = 20;

// Domain separation tags for Poseidon2 hashing
global LEAF_DOMAIN: Field = 0x4c454146; // "LEAF" in hex (right-aligned)
global NULLIFIER_DOMAIN: Field = 0x4e554c4c; // "NULLIFIER" in hex (right-aligned to 4 bytes)

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// Note commitment. Built as a chain of two-input Poseidon2 hashes rather than
/// a single wide hash so that the exact same value can be recomputed by the
/// two other implementations that must agree with this circuit bit for bit:
/// the frontend (which only ships the two-input `hasher` circuit) and the pool
/// contract (whose `poseidon2_hash2` helper is two-input). A wide `hash3`/
/// `hash4` here would silently disagree with both.
///
/// `amount` is part of the commitment: notes carry their own value, so the
/// pool no longer needs a fixed per-pool denomination and a spend can pay out
/// part of a note and re-shield the rest.
fn hash_leaf(nullifier: Field, secret: Field, amount: Field) -> Field {
    hash2(hash2(hash2(LEAF_DOMAIN, nullifier), secret), amount)
}

fn hash_nullifier(nullifier: Field) -> Field {
    hash2(hash2(NULLIFIER_DOMAIN, nullifier), 0)
}

/// Range-constrains `v` to 64 bits and returns it as a `u64`.
///
/// A bare `v as u64` in Noir truncates without constraining, so comparing two
/// truncated values would let a prover pass `amount = p - 1` (which wraps to a
/// small u64) and mint value out of nothing. Asserting the round trip back to
/// `Field` is what actually pins `v < 2^64`, which in turn makes the
/// `withdraw + change = amount` arithmetic below safe from field wraparound.
fn constrain_u64(v: Field) -> u64 {
    let narrowed = v as u64;
    assert(narrowed as Field == v);
    narrowed
}

fn constrain_bit(bit: Field) {
    assert(bit * (1 - bit) == 0);
}

fn compute_root(leaf: Field, path_siblings: [Field; TREE_DEPTH], path_bits: [Field; TREE_DEPTH]) -> Field {
    let mut cur = leaf;
    for i in 0..TREE_DEPTH {
        let sib = path_siblings[i];
        let bit = path_bits[i];
        constrain_bit(bit);
        let left = bit == 0;
        if left {
            cur = hash2(cur, sib);
        } else {
            cur = hash2(sib, cur);
        }
    }
    cur
}

/// Spends one note of arbitrary value: pays `withdraw_amount` out to
/// `recipient` and re-shields the remainder as a brand-new note that the pool
/// contract inserts as a fresh leaf.
///
/// A change note is produced on *every* spend, including a full withdrawal
/// where the remainder is zero. That is deliberate: the on-chain footprint of
/// "withdrew everything" and "withdrew part" is then identical (one nullifier
/// spent, one leaf inserted), so an observer cannot tell from the transaction
/// shape whether the user still holds shielded value.
pub fn main(
    root: pub Field,
    nullifier_hash: pub Field,
    recipient: pub Field,
    withdraw_amount: pub Field,
    change_commitment: pub Field,
    nullifier: Field,
    secret: Field,
    amount: Field,
    change_nullifier: Field,
    change_secret: Field,
    path_siblings: [Field; TREE_DEPTH],
    path_bits: [Field; TREE_DEPTH],
) {
    // Value conservation. Both sides are pinned to 64 bits first so the
    // subtraction below cannot wrap around the field modulus.
    let amount_u64 = constrain_u64(amount);
    let withdraw_u64 = constrain_u64(withdraw_amount);
    assert(withdraw_u64 <= amount_u64);
    let change = amount - withdraw_amount;

    // The spent note exists in the tree and carries exactly `amount`.
    let leaf = hash_leaf(nullifier, secret, amount);

    let nf = hash_nullifier(nullifier);
    assert(nf == nullifier_hash);

    let computed_root = compute_root(leaf, path_siblings, path_bits);
    assert(computed_root == root);

    // The re-shielded remainder is a well-formed note the spender can later
    // open, worth exactly what was not paid out.
    let expected_change = hash_leaf(change_nullifier, change_secret, change);
    assert(expected_change == change_commitment);

    // `recipient` is a committed public input. The front-running protection is
    // enforced on-chain: the pool contract recomputes the recipient hash from
    // the actual payout address and rejects the withdrawal unless it equals
    // this value (see recipient_hash_from_address). This assert simply keeps
    // the public input from being optimized away by the compiler.
    assert(recipient == recipient);
}
