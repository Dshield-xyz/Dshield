use dep::poseidon::poseidon2::Poseidon2;

global TREE_DEPTH: u32 = 20;

// Domain separation tags for Poseidon2 hashing
global LEAF_DOMAIN: Field = 0x4c454146; // "LEAF" in hex (right-aligned)
global VIEW_DOMAIN: Field = 0x56494557; // "VIEW" in hex (right-aligned)

fn hash2(a: Field, b: Field) -> Field {
    Poseidon2::hash([a, b], 2)
}

/// Note commitment -- must stay byte-for-byte identical to the shielded_pool
/// circuit's `hash_leaf` (and to the frontend / pool contract).
fn hash_leaf(nullifier: Field, secret: Field, amount: Field, asset: Field) -> Field {
    hash2(hash2(hash2(hash2(LEAF_DOMAIN, nullifier), secret), amount), asset)
}

/// Viewing key derived from a note's `secret` alone -- deliberately
/// independent of `nullifier`, so a viewing key never carries spend-capable
/// material. `H(H(VIEW_DOMAIN, secret), 0)`, matching the `hash_kyc` shape
/// used by the compliance/disclosure circuits.
fn hash_view_key(secret: Field) -> Field {
    hash2(hash2(VIEW_DOMAIN, secret), 0)
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
    view_key: pub Field,
    amount: pub Field,

    // Private inputs
    nullifier: Field,
    secret: Field,
    asset: Field,
    path_siblings: [Field; TREE_DEPTH],
    path_bits: [Field; TREE_DEPTH],
) {
    // 1. Viewing-key binding: prove knowledge of the `secret` behind the
    //    public `view_key`, without revealing `secret` itself. A verifier who
    //    was handed `view_key` out of band can confirm this proof concerns
    //    the note they were told to expect.
    let computed_view_key = hash_view_key(secret);
    assert(computed_view_key == view_key);

    // 2. Note membership: the note identified by (nullifier, secret, amount)
    //    really is in the pool's tree, and its value really is `amount`.
    //    `nullifier` is required here only to reconstruct the leaf -- it is
    //    never revealed, output, or constrained against any public value, so
    //    no public artifact of this proof (proof bytes, public inputs, or
    //    `view_key` itself) can be used to recover it. See
    //    docs/THREAT_MODEL.md for the key-separation argument in full.
    let leaf = hash_leaf(nullifier, secret, amount, asset);
    let computed_root = compute_root(leaf, path_siblings, path_bits);
    assert(computed_root == merkle_root);
}
