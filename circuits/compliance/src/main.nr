use dep::poseidon::poseidon2::Poseidon2;

global TREE_DEPTH: u32 = 20;

// Domain separation tags for Poseidon2 hashing
global LEAF_DOMAIN: Field = 0x4c454146; // "LEAF" in hex (right-aligned)
global KYC_DOMAIN: Field = 0x4b5943; // "KYC" in hex (right-aligned to 3 bytes)

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

fn hash3(a: Field, b: Field, c: Field) -> Field {
    Poseidon2::hash([a, b, c], 3)
}

fn hash_leaf(nullifier: Field, secret: Field) -> Field {
    hash3(LEAF_DOMAIN, nullifier, secret)
}

fn hash_kyc(kyc_preimage: Field) -> Field {
    hash3(KYC_DOMAIN, kyc_preimage, 0)
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

    // 2. Wallet authorization: user owns a note in the shielded pool
    let leaf = hash_leaf(nullifier, secret);
    let computed_root = compute_root(leaf, path_siblings, path_bits);
    assert(computed_root == merkle_root);

    // 3. Selective disclosure: `amount`/`disclosed_amount` are NOT bound to the
    //    note above (the leaf is hash3(LEAF_DOMAIN, nullifier, secret) -- amount plays no
    //    part in it), so this assert alone proves nothing about the real note;
    //    a prover could pick any two equal values here. `disclosure_commitment`
    //    and `expected` are computed but deliberately unused for the same
    //    reason: hashing an unconstrained `amount` with anything doesn't
    //    constrain it either.
    //
    //    The real amount binding happens on-chain: DShield pools are
    //    fixed-denomination (every note in a given pool has the same
    //    deposit_amount), so the compliance contract's `amount_for_root`
    //    looks up which configured pool `merkle_root` belongs to (via
    //    cross-contract `is_known_root`) and rejects the proof unless
    //    `disclosed_amount` equals that pool's actual `get_deposit_amount()`.
    //    See contracts/compliance/src/lib.rs `verify_compliance`. This
    //    mirrors how the shielded_pool circuit's `recipient` binding is a
    //    no-op in-circuit and enforced by the pool contract instead.
    let disclosure_commitment = hash3(amount, auditor_key, nullifier);
    let expected = hash2(disclosed_amount, auditor_key);
    assert(amount == disclosed_amount);
    let _ = disclosure_commitment;
    let _ = expected;
}
