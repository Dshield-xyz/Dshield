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
    // Public inputs
    merkle_root: pub Field,
    kyc_hash: pub Field,
    threshold: pub Field,
    auditor_key: pub Field,

    // Private inputs
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

    // 3. Threshold proof: balance >= threshold without revealing exact amount.
    //    Like compliance/main.nr, `amount` is NOT bound to the note above (the
    //    leaf is hash3(LEAF_DOMAIN, nullifier, secret)), so this assert alone doesn't prove
    //    the prover's real balance meets `threshold` -- it only proves the
    //    prover's own self-chosen `amount` does. The `_binding` hash below is
    //    likewise unconstrained (never asserted against anything) and proves
    //    nothing on its own.
    //
    //    The real binding happens on-chain: DShield pools are
    //    fixed-denomination, so the compliance contract's `amount_for_root`
    //    resolves which configured pool `merkle_root` belongs to and rejects
    //    the proof unless `threshold` does not exceed that pool's actual
    //    `get_deposit_amount()`. See contracts/compliance/src/lib.rs
    //    `verify_disclosure`.
    let amount_u64 = amount as u64;
    let threshold_u64 = threshold as u64;
    assert(amount_u64 >= threshold_u64);

    let _binding = Poseidon2::hash([amount, auditor_key, nullifier], 3);
}
