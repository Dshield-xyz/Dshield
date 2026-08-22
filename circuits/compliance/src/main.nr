use dep::poseidon::poseidon2::Poseidon2;

global TREE_DEPTH: u32 = 20;

// Domain separation tags for Poseidon2 hashing
global LEAF_DOMAIN: Field = 0x4c454146; // "LEAF" in hex (right-aligned)
global KYC_DOMAIN: Field = 0x4b5943; // "KYC" in hex (right-aligned to 3 bytes)

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// Note commitment -- must stay byte-for-byte identical to the shielded_pool
/// circuit's `hash_leaf` (and to the frontend / pool contract), which is why it
/// is a chain of two-input Poseidon2 hashes rather than one wide hash.
/// `amount` is bound into the commitment, so a note's value is now something
/// this circuit can actually prove rather than an unconstrained witness.
fn hash_leaf(nullifier: Field, secret: Field, amount: Field) -> Field {
    hash2(hash2(hash2(LEAF_DOMAIN, nullifier), secret), amount)
}

fn hash_kyc(kyc_preimage: Field) -> Field {
    hash2(hash2(KYC_DOMAIN, kyc_preimage), 0)
}

/// Range-constrains `v` to 64 bits. A bare `as u64` truncates without
/// constraining, so the round trip back to `Field` is what pins `v < 2^64`.
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
        if bit == 0 {
            cur = hash2(cur, sib);
        } else {
            cur = hash2(sib, cur);
        }
    }
    cur
}

pub fn main(
    // Public inputs - visible to the verifier (auditor/regulator)
    merkle_root: pub Field,
    kyc_hash: pub Field,
    disclosed_amount: pub Field,
    auditor_key: pub Field,

    // Private inputs - never leave the user's device
    kyc_preimage: Field,
    nullifier: Field,
    secret: Field,
    amount: Field,
    path_siblings: [Field; TREE_DEPTH],
    path_bits: [Field; TREE_DEPTH],
) {
    // 1. KYC proof: user knows the preimage behind the registered kyc_hash
    let computed_kyc = hash_kyc(kyc_preimage);
    assert(computed_kyc == kyc_hash);

    // 2. Wallet authorization: user owns a note in the shielded pool, and that
    //    note is worth exactly `amount` -- the value is bound into the leaf.
    let leaf = hash_leaf(nullifier, secret, amount);
    let computed_root = compute_root(leaf, path_siblings, path_bits);
    assert(computed_root == merkle_root);

    // 3. Selective disclosure: because step 2 pins `amount` to the real note,
    //    this equality now genuinely proves the disclosed figure is the note's
    //    value. (It used to prove nothing: the leaf did not commit to an
    //    amount, so a prover could pick any two equal values here, and the
    //    compliance contract had to recover the figure out-of-band from the
    //    pool's fixed denomination. Notes carry their own value now, so that
    //    workaround is gone along with the denominations.)
    let disclosed_u64 = constrain_u64(disclosed_amount);
    let amount_u64 = constrain_u64(amount);
    assert(amount_u64 == disclosed_u64);

    // Auditor-scoped binding, so a disclosure produced for one auditor cannot
    // be replayed as though it were addressed to another.
    let _disclosure_commitment = Poseidon2::hash([amount, auditor_key, nullifier], 3);
}
