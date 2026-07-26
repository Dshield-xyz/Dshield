#![no_std]
extern crate alloc;

use alloc::vec::Vec;
use soroban_poseidon::{poseidon2_hash, Field};
use soroban_sdk::{
    address_payload::AddressPayload, contract, contracterror, contractevent, contractimpl,
    crypto::BnScalar, symbol_short, token, Address, Bytes, BytesN, Env, IntoVal, InvokeError,
    Symbol, Val, Vec as SorobanVec, U256,
};
use ultrahonk_soroban_verifier::PROOF_BYTES;

#[contract]
pub struct PoolContract;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PoolError {
    CommitmentExists = 1,
    NullifierUsed = 2,
    VerificationFailed = 3,
    RootMismatch = 4,
    VerifierNotSet = 5,
    TreeFull = 6,
    RootNotSet = 7,
    AlreadyInitialized = 8,
    InvalidPublicInputs = 9,
    TokenNotSet = 10,
    RecipientMismatch = 11,
    UnsupportedRecipient = 12,
    AmountOverflow = 13,
    BatchTooLarge = 14,
    InvalidDepositAmount = 15,
    Paused = 16,
    NotAuthorized = 17,
}

#[contractevent(topics = ["deposit"], data_format = "map")]
pub struct DepositEvent<'a> {
    #[topic]
    pub idx: &'a u32,
    pub commitment: &'a BytesN<32>,
}

#[contractevent(topics = ["withdraw"], data_format = "single-value")]
pub struct WithdrawEvent<'a> {
    pub nullifier_hash: &'a BytesN<32>,
}

#[contractevent(topics = ["paused"])]
pub struct PausedEvent<'a> {
    pub paused_by: &'a Address,
}

#[contractevent(topics = ["unpaused"])]
pub struct UnpausedEvent<'a> {
    pub unpaused_by: &'a Address,
}

#[contractevent(topics = ["verifier_updated"])]
pub struct VerifierUpdatedEvent<'a> {
    pub previous_verifier: &'a Address,
    pub new_verifier: &'a Address,
    pub updated_by: &'a Address,
}

fn key_commitment_prefix() -> Symbol {
    symbol_short!("cm")
}
fn key_nullifier_prefix() -> Symbol {
    symbol_short!("nf")
}
fn key_root() -> Symbol {
    symbol_short!("root")
}
fn key_frontier_prefix() -> Symbol {
    symbol_short!("fr")
}
fn key_next_index() -> Symbol {
    symbol_short!("idx")
}
fn key_verifier() -> Symbol {
    symbol_short!("ver")
}
fn key_admin() -> Symbol {
    symbol_short!("admin")
}
fn key_paused() -> Symbol {
    symbol_short!("paused")
}
fn key_token() -> Symbol {
    symbol_short!("token")
}
fn key_deposit_amount() -> Symbol {
    symbol_short!("amt")
}
fn key_root_history_prefix() -> Symbol {
    symbol_short!("rh")
}
fn key_root_history_index() -> Symbol {
    symbol_short!("rhi")
}
fn key_commitment_by_index_prefix() -> Symbol {
    symbol_short!("cmi")
}

const TREE_DEPTH: u32 = 20;
const MAX_LEAVES: u32 = 1u32 << TREE_DEPTH;
const ROOT_HISTORY_SIZE: u32 = 30;
// Each batched commitment walks the full TREE_DEPTH (20) on insertion, doing
// a Poseidon2 hash plus a persistent/instance read-or-write at every level.
// Empirically, a 20-leaf `deposit_batch` from an empty tree already exceeds
// Soroban's default per-transaction instruction limit (604M > 600M budget);
// 19 barely fits (see test_deposit_batch_accepts_max_batch_size, which runs
// against that real limit rather than an unlimited test budget). Capping
// well under that, independent of the tree-capacity check, keeps a batch
// inside the resource budget instead of reverting with an opaque host error.
const MAX_BATCH_SIZE: u32 = 15;

// Maximum number of commitments to return in a single page query to avoid
// exceeding Soroban's per-transaction CPU/footprint limits.
const MAX_PAGE_SIZE: u32 = 100;

// Storage TTL management. Commitments, the commitment-by-index map, and
// nullifiers grow without bound (one entry per deposit/withdrawal), so they
// live in PERSISTENT storage — loaded on demand and not subject to the
// instance entry's size cap (the instance entry is read in full on every call).
// Bounded data (config, root, frontier[20], root history[30], indices) stays in
// instance storage. TTLs are extended so entries survive well beyond a demo.
const BUMP_THRESHOLD: u32 = 17_280; // ~1 day of ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days of ledgers

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

fn bump_persistent<K>(env: &Env, key: &K)
where
    K: soroban_sdk::IntoVal<Env, Val>,
{
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_AMOUNT);
}

fn poseidon2_hash2(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let modulus = <BnScalar as Field>::modulus(env);
    let a_bytes = Bytes::from_array(env, &a.to_array());
    let b_bytes = Bytes::from_array(env, &b.to_array());
    let mut inputs = SorobanVec::new(env);
    inputs.push_back(U256::from_be_bytes(env, &a_bytes).rem_euclid(&modulus));
    inputs.push_back(U256::from_be_bytes(env, &b_bytes).rem_euclid(&modulus));
    let out = poseidon2_hash::<4, BnScalar>(env, &inputs);
    let out_bytes = out.to_be_bytes();
    let mut out_arr = [0u8; 32];
    out_bytes.copy_into_slice(&mut out_arr);
    BytesN::from_array(env, &out_arr)
}

/// Derives the recipient hash that the withdrawal circuit commits to, from the
/// payout `Address`. This MUST match the frontend's `computeRecipientHash`:
/// it takes the account's 32-byte Ed25519 key, splits it into the first 15 and
/// last 17 bytes (each a big-endian field element), and Poseidon2-hashes them.
/// Binding the proof's recipient public input to the actual payout address is
/// what prevents a third party from front-running a withdrawal and redirecting
/// the funds. Only account (G...) recipients are supported.
fn recipient_hash_from_address(env: &Env, addr: &Address) -> Result<BytesN<32>, PoolError> {
    let payload = addr.to_payload().ok_or(PoolError::UnsupportedRecipient)?;
    let key = match payload {
        AddressPayload::AccountIdPublicKeyEd25519(k) => k,
        _ => return Err(PoolError::UnsupportedRecipient),
    };
    let k = key.to_array();
    // Right-align each slice in a 32-byte buffer so the big-endian integer
    // value matches the frontend's "0x00"-prefixed field encoding.
    let mut lo = [0u8; 32];
    lo[17..32].copy_from_slice(&k[0..15]);
    let mut hi = [0u8; 32];
    hi[15..32].copy_from_slice(&k[15..32]);
    Ok(poseidon2_hash2(
        env,
        &BytesN::from_array(env, &lo),
        &BytesN::from_array(env, &hi),
    ))
}

fn zeroes_for_tree(env: &Env) -> Vec<BytesN<32>> {
    let mut zeroes = Vec::with_capacity(TREE_DEPTH as usize + 1);
    let mut cur = BytesN::from_array(env, &[0u8; 32]);
    zeroes.push(cur.clone());
    for _ in 0..TREE_DEPTH {
        cur = poseidon2_hash2(env, &cur, &cur);
        zeroes.push(cur.clone());
    }
    zeroes
}

fn parse_public_inputs(bytes: &Bytes) -> Result<([u8; 32], [u8; 32], [u8; 32]), PoolError> {
    if bytes.len() != 96 {
        return Err(PoolError::InvalidPublicInputs);
    }
    let mut buf = [0u8; 96];
    bytes.copy_into_slice(&mut buf);
    let mut root = [0u8; 32];
    root.copy_from_slice(&buf[..32]);
    let mut nullifier_hash = [0u8; 32];
    nullifier_hash.copy_from_slice(&buf[32..64]);
    let mut recipient_hash = [0u8; 32];
    recipient_hash.copy_from_slice(&buf[64..96]);
    Ok((root, nullifier_hash, recipient_hash))
}

fn verify_proof(
    env: &Env,
    verifier: &Address,
    public_inputs: Bytes,
    proof_bytes: Bytes,
) -> Result<(), PoolError> {
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(public_inputs.into_val(env));
    args.push_back(proof_bytes.into_val(env));
    env.try_invoke_contract::<(), InvokeError>(verifier, &Symbol::new(env, "verify_proof"), args)
        .map_err(|_| PoolError::VerificationFailed)?
        .map_err(|_| PoolError::VerificationFailed)
}

fn load_token_and_amount(env: &Env) -> Result<(Address, i128), PoolError> {
    let token_addr: Address = env
        .storage()
        .instance()
        .get(&key_token())
        .ok_or(PoolError::TokenNotSet)?;
    let amount: i128 = env
        .storage()
        .instance()
        .get(&key_deposit_amount())
        .ok_or(PoolError::TokenNotSet)?;
    Ok((token_addr, amount))
}

/// Persists a single commitment: marks it present, stores it keyed by its leaf
/// index (so clients can rebuild the tree), and emits the deposit event.
fn record_commitment(env: &Env, idx: u32, commitment: &BytesN<32>) {
    let cm_key = (key_commitment_prefix(), commitment.clone());
    env.storage().persistent().set(&cm_key, &true);
    bump_persistent(env, &cm_key);
    let ci_key = (key_commitment_by_index_prefix(), idx);
    env.storage().persistent().set(&ci_key, commitment);
    bump_persistent(env, &ci_key);
    DepositEvent {
        idx: &idx,
        commitment,
    }
    .publish(env);
}

/// Inserts `commitment` at `index` into the incremental Merkle tree, updating
/// the stored frontier, and returns the new root. Identical leaf-by-leaf
/// behaviour to a sequence of single deposits, so reconstructed roots match.
fn insert_commitment(
    env: &Env,
    zeroes: &Vec<BytesN<32>>,
    index: u32,
    commitment: &BytesN<32>,
) -> BytesN<32> {
    let mut cur = commitment.clone();
    let mut i = 0u32;
    while i < TREE_DEPTH {
        let bit = (index >> i) & 1;
        let fk = (key_frontier_prefix(), i);
        if bit == 0 {
            env.storage().instance().set(&fk, &cur);
            cur = poseidon2_hash2(env, &cur, &zeroes[i as usize]);
        } else {
            let left: BytesN<32> = env
                .storage()
                .instance()
                .get(&fk)
                .unwrap_or_else(|| zeroes[i as usize].clone());
            cur = poseidon2_hash2(env, &left, &cur);
        }
        i += 1;
    }
    cur
}

/// Checks whether `root` is the current root or appears in the bounded root
/// history ring. Shared by `withdraw`'s own root check and the public
/// `is_known_root` view (used by other contracts, e.g. compliance, to
/// validate a merkle_root belongs to this pool).
fn root_is_known(env: &Env, root: &BytesN<32>) -> bool {
    let rh_count: u32 = env
        .storage()
        .instance()
        .get(&key_root_history_index())
        .unwrap_or(0u32);
    let check_count = if rh_count < ROOT_HISTORY_SIZE {
        rh_count
    } else {
        ROOT_HISTORY_SIZE
    };
    let mut j = 0u32;
    while j < check_count {
        let rh_key = (key_root_history_prefix(), j);
        if let Some(stored) = env.storage().instance().get::<_, BytesN<32>>(&rh_key) {
            if &stored == root {
                return true;
            }
        }
        j += 1;
    }
    false
}

/// Records `root` as the current root and appends it to the bounded root
/// history ring used to validate withdrawal proofs against recent states.
fn commit_root(env: &Env, root: &BytesN<32>) {
    env.storage().instance().set(&key_root(), root);
    let rh_idx: u32 = env
        .storage()
        .instance()
        .get(&key_root_history_index())
        .unwrap_or(0u32);
    let rh_key = (key_root_history_prefix(), rh_idx % ROOT_HISTORY_SIZE);
    env.storage().instance().set(&rh_key, root);
    env.storage()
        .instance()
        .set(&key_root_history_index(), &(rh_idx + 1));
}

#[contractimpl]
impl PoolContract {
    pub fn __constructor(
        env: Env,
        verifier: Address,
        token: Address,
        deposit_amount: i128,
        admin: Address,
    ) -> Result<(), PoolError> {
        if env.storage().instance().has(&key_verifier()) {
            return Err(PoolError::AlreadyInitialized);
        }
        if deposit_amount <= 0 {
            return Err(PoolError::InvalidDepositAmount);
        }
        env.storage().instance().set(&key_verifier(), &verifier);
        env.storage().instance().set(&key_token(), &token);
        env.storage()
            .instance()
            .set(&key_deposit_amount(), &deposit_amount);
        env.storage().instance().set(&key_admin(), &admin);
        Ok(())
    }

    /// Pauses deposits and withdrawals. Admin-gated circuit breaker for
    /// responding to a discovered bug in the VK, Poseidon2 implementation, or
    /// the pinned verifier dependency without deploying a new pool.
    pub fn pause(env: Env) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);
        env.storage().instance().set(&key_paused(), &true);
        PausedEvent { paused_by: &admin }.publish(&env);
        Ok(())
    }

    /// Resumes deposits and withdrawals after a pause.
    pub fn unpause(env: Env) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);
        env.storage().instance().set(&key_paused(), &false);
        UnpausedEvent {
            unpaused_by: &admin,
        }
        .publish(&env);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&key_paused()).unwrap_or(false)
    }

    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_admin())
    }

    /// Admin-gated: points the pool at a different verifier contract, e.g. to
    /// swap in a fixed verifier after a bug is found in the VK or the pinned
    /// verifier dependency.
    pub fn set_verifier(env: Env, verifier: Address) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);

        let previous_verifier: Address = env
            .storage()
            .instance()
            .get(&key_verifier())
            .ok_or(PoolError::VerifierNotSet)?;
        env.storage().instance().set(&key_verifier(), &verifier);

        VerifierUpdatedEvent {
            previous_verifier: &previous_verifier,
            new_verifier: &verifier,
            updated_by: &admin,
        }
        .publish(&env);

        Ok(())
    }

    pub fn deposit(env: Env, depositor: Address, commitment: BytesN<32>) -> Result<u32, PoolError> {
        depositor.require_auth();
        if Self::is_paused(env.clone()) {
            return Err(PoolError::Paused);
        }
        bump_instance(&env);

        let cm_key = (key_commitment_prefix(), commitment.clone());
        if env.storage().persistent().has(&cm_key) {
            return Err(PoolError::CommitmentExists);
        }

        let mut next_index: u32 = env
            .storage()
            .instance()
            .get(&key_next_index())
            .unwrap_or(0u32);
        if next_index >= MAX_LEAVES {
            return Err(PoolError::TreeFull);
        }

        let (token_addr, amount) = load_token_and_amount(&env)?;
        let contract_addr = env.current_contract_address();
        token::Client::new(&env, &token_addr).transfer(&depositor, &contract_addr, &amount);

        let idx = next_index;
        let zeroes = zeroes_for_tree(&env);
        record_commitment(&env, idx, &commitment);
        let root = insert_commitment(&env, &zeroes, idx, &commitment);
        commit_root(&env, &root);

        next_index = next_index.saturating_add(1);
        env.storage().instance().set(&key_next_index(), &next_index);

        Ok(idx)
    }

    /// Deposit several commitments in a single transaction (one signature, one
    /// token transfer of `deposit_amount * commitments.len()`). Each commitment
    /// is inserted at the next sequential leaf index exactly as repeated
    /// `deposit` calls would, so the resulting root and per-leaf indices are
    /// identical — clients can rebuild the tree the same way. Returns the leaf
    /// index assigned to the first commitment; the rest follow consecutively.
    ///
    /// The whole batch is atomic: any duplicate commitment (within the batch or
    /// already stored) or a full tree reverts the entire transaction, so no
    /// partial deposit or partial transfer can occur.
    pub fn deposit_batch(
        env: Env,
        depositor: Address,
        commitments: soroban_sdk::Vec<BytesN<32>>,
    ) -> Result<u32, PoolError> {
        depositor.require_auth();
        if Self::is_paused(env.clone()) {
            return Err(PoolError::Paused);
        }
        bump_instance(&env);

        let count = commitments.len();
        if count == 0 {
            return Err(PoolError::InvalidPublicInputs);
        }
        if count > MAX_BATCH_SIZE {
            return Err(PoolError::BatchTooLarge);
        }

        let mut next_index: u32 = env
            .storage()
            .instance()
            .get(&key_next_index())
            .unwrap_or(0u32);
        // Reject up-front if the batch can't possibly fit, before transferring.
        if next_index.saturating_add(count) > MAX_LEAVES {
            return Err(PoolError::TreeFull);
        }

        let (token_addr, amount) = load_token_and_amount(&env)?;
        let total = amount
            .checked_mul(count as i128)
            .ok_or(PoolError::AmountOverflow)?;
        let contract_addr = env.current_contract_address();
        token::Client::new(&env, &token_addr).transfer(&depositor, &contract_addr, &total);

        let zeroes = zeroes_for_tree(&env);
        let first_index = next_index;
        let mut root = BytesN::from_array(&env, &[0u8; 32]);

        for commitment in commitments.iter() {
            let cm_key = (key_commitment_prefix(), commitment.clone());
            if env.storage().persistent().has(&cm_key) {
                return Err(PoolError::CommitmentExists);
            }
            let idx = next_index;
            record_commitment(&env, idx, &commitment);
            root = insert_commitment(&env, &zeroes, idx, &commitment);
            next_index = next_index.saturating_add(1);
        }

        // Push a single root-history entry for the final state. Intermediate
        // per-leaf roots are transient and never used for withdrawals (clients
        // always rebuild from the full commitment list), so recording only the
        // final root keeps the bounded history from churning on a big batch.
        commit_root(&env, &root);
        env.storage().instance().set(&key_next_index(), &next_index);

        Ok(first_index)
    }

    pub fn withdraw(
        env: Env,
        recipient: Address,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), PoolError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(PoolError::VerificationFailed);
        }
        if Self::is_paused(env.clone()) {
            return Err(PoolError::Paused);
        }
        bump_instance(&env);

        let (root_arr, nf_arr, recipient_arr) = parse_public_inputs(&public_inputs)?;
        let nf_from_proof = BytesN::from_array(&env, &nf_arr);
        let recipient_from_proof = BytesN::from_array(&env, &recipient_arr);

        let nf_key = (key_nullifier_prefix(), nf_from_proof.clone());
        if env.storage().persistent().has(&nf_key) {
            return Err(PoolError::NullifierUsed);
        }

        let root_from_proof = BytesN::from_array(&env, &root_arr);
        if !env.storage().instance().has(&key_root()) {
            return Err(PoolError::RootNotSet);
        }

        if !root_is_known(&env, &root_from_proof) {
            return Err(PoolError::RootMismatch);
        }

        // Bind the proof to the actual payout recipient. The proof commits to a
        // recipient hash as a public input; if the caller tries to redirect the
        // funds to a different address (front-running), the recomputed hash will
        // not match and the withdrawal is rejected.
        let expected_recipient = recipient_hash_from_address(&env, &recipient)?;
        if expected_recipient != recipient_from_proof {
            return Err(PoolError::RecipientMismatch);
        }

        let verifier: Address = env
            .storage()
            .instance()
            .get(&key_verifier())
            .ok_or(PoolError::VerifierNotSet)?;
        verify_proof(&env, &verifier, public_inputs, proof_bytes)?;

        let token_addr: Address = env
            .storage()
            .instance()
            .get(&key_token())
            .ok_or(PoolError::TokenNotSet)?;
        let amount: i128 = env
            .storage()
            .instance()
            .get(&key_deposit_amount())
            .ok_or(PoolError::TokenNotSet)?;

        // Mark the nullifier used BEFORE the token transfer (checks-effects-
        // interactions). The deployed token is the trusted Stellar Asset
        // Contract with no transfer hooks, but this ordering means even a
        // token with callback behavior can't re-enter withdraw and replay
        // this proof before it's recorded as spent.
        env.storage().persistent().set(&nf_key, &true);
        bump_persistent(&env, &nf_key);

        let contract_addr = env.current_contract_address();
        token::Client::new(&env, &token_addr).transfer(&contract_addr, &recipient, &amount);

        WithdrawEvent {
            nullifier_hash: &nf_from_proof,
        }
        .publish(&env);

        Ok(())
    }

    pub fn is_nullifier_used(env: Env, nullifier_hash: BytesN<32>) -> bool {
        let nf_key = (key_nullifier_prefix(), nullifier_hash);
        env.storage().persistent().has(&nf_key)
    }

    pub fn get_root(env: Env) -> Option<BytesN<32>> {
        env.storage().instance().get(&key_root())
    }

    /// True if `root` is the current root or within the bounded root history.
    /// Used by other contracts (e.g. compliance) to confirm a merkle_root a
    /// caller claims actually belongs to this pool, and to look up this
    /// pool's fixed `deposit_amount` for that root via `get_deposit_amount`.
    pub fn is_known_root(env: Env, root: BytesN<32>) -> bool {
        root_is_known(&env, &root)
    }

    pub fn get_next_index(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&key_next_index())
            .unwrap_or(0u32)
    }

    /// Returns the commitment stored at the given leaf index, if any.
    pub fn get_commitment(env: Env, index: u32) -> Option<BytesN<32>> {
        let ci_key = (key_commitment_by_index_prefix(), index);
        env.storage().persistent().get(&ci_key)
    }

    /// Returns every commitment in leaf order (indices 0..next_index). Clients
    /// use this to rebuild the Merkle tree deterministically for withdrawal
    /// proofs, independent of RPC event retention. Any missing slot is returned
    /// as the zero leaf so positions always line up with leaf indices.
    pub fn get_commitments(env: Env) -> soroban_sdk::Vec<BytesN<32>> {
        let next_index: u32 = env
            .storage()
            .instance()
            .get(&key_next_index())
            .unwrap_or(0u32);
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let mut out = SorobanVec::new(&env);
        let mut i = 0u32;
        while i < next_index {
            let ci_key = (key_commitment_by_index_prefix(), i);
            let c: BytesN<32> = env
                .storage()
                .persistent()
                .get(&ci_key)
                .unwrap_or_else(|| zero.clone());
            out.push_back(c);
            i += 1;
        }
        out
    }

    /// Returns commitments in leaf order for the half-open range
    /// `[start, start + limit)`, clamped to `next_index` and to
    /// `MAX_PAGE_SIZE`. Missing slots are returned as the zero leaf, same as
    /// `get_commitments`. Callers should page through the full range with
    /// successive calls (e.g. `start += result.len()` until a short page is
    /// returned) instead of relying on `get_commitments`, which reads every
    /// leaf in one invocation and will exceed Soroban's per-transaction
    /// CPU/footprint limits once a pool holds enough deposits.
    pub fn get_commitments_page(
        env: Env,
        start: u32,
        limit: u32,
    ) -> soroban_sdk::Vec<BytesN<32>> {
        let next_index: u32 = env
            .storage()
            .instance()
            .get(&key_next_index())
            .unwrap_or(0u32);
        let mut out = SorobanVec::new(&env);
        if start >= next_index {
            return out;
        }
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let capped_limit = limit.min(MAX_PAGE_SIZE);
        let end = start.saturating_add(capped_limit).min(next_index);
        let mut i = start;
        while i < end {
            let ci_key = (key_commitment_by_index_prefix(), i);
            let c: BytesN<32> = env
                .storage()
                .persistent()
                .get(&ci_key)
                .unwrap_or_else(|| zero.clone());
            out.push_back(c);
            i += 1;
        }
        out
    }

    pub fn get_token(env: Env) -> Result<Address, PoolError> {
        env.storage()
            .instance()
            .get(&key_token())
            .ok_or(PoolError::TokenNotSet)
    }

    pub fn get_deposit_amount(env: Env) -> Result<i128, PoolError> {
        env.storage()
            .instance()
            .get(&key_deposit_amount())
            .ok_or(PoolError::TokenNotSet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as TestAddress, Events},
        token::StellarAssetClient,
        token::TokenClient,
        Address, Env, Event,
    };

    fn dummy_commitment(env: &Env, seed: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = seed;
        BytesN::from_array(env, &arr)
    }

    fn hex32(hex: &str) -> [u8; 32] {
        let bytes = hex.as_bytes();
        let mut out = [0u8; 32];
        let mut i = 0;
        while i < 32 {
            let hi = (bytes[i * 2] as char).to_digit(16).unwrap() as u8;
            let lo = (bytes[i * 2 + 1] as char).to_digit(16).unwrap() as u8;
            out[i] = (hi << 4) | lo;
            i += 1;
        }
        out
    }

    // The contract's on-chain Poseidon2 (soroban_poseidon) MUST produce the
    // exact same digest as the Noir `Poseidon2::hash([a, b], 2)` used by the
    // circuit and the frontend, otherwise the on-chain Merkle root will never
    // match the root the withdrawal proof is generated against.
    // `0x0b63a5...` is H(0, 0) as computed by the circuit/frontend
    // (see frontend poseidon2.test.ts KNOWN_ZERO_HASH and e2e.sh Prover.toml).
    const KNOWN_ZERO_HASH: &str =
        "0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1";

    #[test]
    fn test_poseidon_matches_circuit_zero_hash() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let h = poseidon2_hash2(&env, &zero, &zero);
        let expected = BytesN::from_array(&env, &hex32(KNOWN_ZERO_HASH));
        assert_eq!(
            h, expected,
            "contract Poseidon2 H(0,0) does not match circuit/frontend"
        );
    }

    // H(1234, 0) as computed by the circuit/frontend
    // (frontend poseidon2.test.ts KNOWN_NULLIFIER_HASH, e2e.sh Prover.toml).
    // This pins NON-zero input encoding, which H(0,0) alone cannot catch.
    const KNOWN_NULLIFIER_HASH: &str =
        "2b0c9e50ac135931c5f87dff253337d63f6fe5f8b0f2489b92a5a9446cc4b3d2";

    #[test]
    fn test_poseidon_matches_circuit_nonzero() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        // 1234 = 0x04d2, big-endian in a 32-byte field element.
        let mut a = [0u8; 32];
        a[30] = 0x04;
        a[31] = 0xd2;
        let a_bytes = BytesN::from_array(&env, &a);
        let zero = BytesN::from_array(&env, &[0u8; 32]);
        let h = poseidon2_hash2(&env, &a_bytes, &zero);
        let expected = BytesN::from_array(&env, &hex32(KNOWN_NULLIFIER_HASH));
        assert_eq!(
            h, expected,
            "contract Poseidon2 H(1234,0) does not match circuit/frontend"
        );
    }

    #[test]
    fn test_single_leaf_root_matches_circuit() {
        // From e2e.sh Prover.toml: leaf = H(1234, 5678), inserted at index 0,
        // yields this root. Validates H(non-zero, non-zero) plus the full
        // zero-padded root chain against the circuit.
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let mut a = [0u8; 32];
        a[30] = 0x04;
        a[31] = 0xd2; // 1234
        let mut b = [0u8; 32];
        b[30] = 0x16;
        b[31] = 0x2e; // 5678
        let leaf = poseidon2_hash2(
            &env,
            &BytesN::from_array(&env, &a),
            &BytesN::from_array(&env, &b),
        );
        let zeroes = zeroes_for_tree(&env);
        let mut cur = leaf;
        for depth in 0..TREE_DEPTH as usize {
            cur = poseidon2_hash2(&env, &cur, &zeroes[depth]);
        }
        let expected = BytesN::from_array(
            &env,
            &hex32("0e829a70d5bfbb7c4ffe0be28454f1eefd47e898dfd330b0a4c61fc615453ed2"),
        );
        assert_eq!(cur, expected);
    }

    #[test]
    fn test_reconstructed_root_matches_onchain_root_8() {
        // Same invariant as the 5-leaf test but at 8 deposits (a full depth-3
        // subtree), matching the scenario seen in the wallet.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for seed in 1u8..=8 {
            client.deposit(&depositor, &dummy_commitment(&env, seed));
        }

        let commitments = client.get_commitments();
        let onchain_root = client.get_root().unwrap();
        assert_eq!(rebuild_root(&env, &commitments), onchain_root);
    }

    #[test]
    fn test_zero_subtree_matches_circuit() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let zeroes = zeroes_for_tree(&env);
        // zeroes[1] is H(0,0) and must equal the circuit's known zero hash.
        let expected = BytesN::from_array(&env, &hex32(KNOWN_ZERO_HASH));
        assert_eq!(zeroes[1], expected);
    }

    fn setup_with_token(env: &Env) -> (Address, Address, Address) {
        env.mock_all_auths();
        let admin = <Address as TestAddress>::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = StellarAssetClient::new(env, &token_id.address());

        let depositor = <Address as TestAddress>::generate(env);
        sac.mint(&depositor, &1_000_000_000);

        let verifier_id = <Address as TestAddress>::generate(env);
        let deposit_amount: i128 = 10_000_000;
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), deposit_amount, admin.clone()),
        );
        (pool_id, depositor, token_id.address())
    }

    fn setup_multi_depositor(env: &Env) -> (Address, Address, Address, Address) {
        env.mock_all_auths();
        let admin = <Address as TestAddress>::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = StellarAssetClient::new(env, &token_id.address());

        let depositor1 = <Address as TestAddress>::generate(env);
        let depositor2 = <Address as TestAddress>::generate(env);
        sac.mint(&depositor1, &1_000_000_000);
        sac.mint(&depositor2, &1_000_000_000);

        let verifier_id = <Address as TestAddress>::generate(env);
        let deposit_amount: i128 = 10_000_000;
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), deposit_amount, admin.clone()),
        );
        (pool_id, depositor1, depositor2, token_id.address())
    }

    // ──────────────────────────────────────────────
    //  Deposit: basic functionality
    // ──────────────────────────────────────────────

    #[test]
    fn test_deposit_increments_index() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        assert_eq!(client.get_next_index(), 0);

        let c1 = dummy_commitment(&env, 1);
        let idx = client.deposit(&depositor, &c1);
        assert_eq!(idx, 0);
        assert_eq!(client.get_next_index(), 1);
    }

    #[test]
    fn test_deposit_sets_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        assert!(client.get_root().is_none());

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let root = client.get_root();
        assert!(root.is_some());
    }

    #[test]
    fn test_deposit_transfers_tokens() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);

        let balance_before = token.balance(&depositor);
        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);
        let balance_after = token.balance(&depositor);

        assert_eq!(balance_before - balance_after, 10_000_000);
        assert_eq!(token.balance(&pool_id), 10_000_000);
    }

    #[test]
    fn test_deposit_sequential_indices() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for i in 0u8..5 {
            let c = dummy_commitment(&env, i + 1);
            let idx = client.deposit(&depositor, &c);
            assert_eq!(idx, i as u32);
        }
        assert_eq!(client.get_next_index(), 5);
    }

    #[test]
    fn test_deposit_accumulates_pool_balance() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);

        for i in 1u8..=4 {
            let c = dummy_commitment(&env, i);
            client.deposit(&depositor, &c);
        }

        assert_eq!(token.balance(&pool_id), 10_000_000 * 4);
    }

    #[test]
    fn test_deposit_does_not_panic() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        let idx = client.deposit(&depositor, &c1);
        assert_eq!(idx, 0);
        assert!(client.get_root().is_some());
        assert_eq!(client.get_next_index(), 1);
    }

    // ──────────────────────────────────────────────
    //  Deposit: multi-depositor
    // ──────────────────────────────────────────────

    #[test]
    fn test_get_commitment_by_index() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c0 = dummy_commitment(&env, 7);
        let c1 = dummy_commitment(&env, 9);
        client.deposit(&depositor, &c0);
        client.deposit(&depositor, &c1);

        assert_eq!(client.get_commitment(&0), Some(c0));
        assert_eq!(client.get_commitment(&1), Some(c1));
        assert_eq!(client.get_commitment(&2), None);
    }

    #[test]
    fn test_get_commitments_returns_all_in_order() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commits = [
            dummy_commitment(&env, 1),
            dummy_commitment(&env, 2),
            dummy_commitment(&env, 3),
        ];
        for c in commits.iter() {
            client.deposit(&depositor, c);
        }

        let all = client.get_commitments();
        assert_eq!(all.len(), 3);
        assert_eq!(all.get(0).unwrap(), commits[0]);
        assert_eq!(all.get(1).unwrap(), commits[1]);
        assert_eq!(all.get(2).unwrap(), commits[2]);
    }

    #[test]
    fn test_get_commitments_empty_initially() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        assert_eq!(client.get_commitments().len(), 0);
    }

    #[test]
    fn test_get_commitments_page_lands_exactly_on_next_index() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commits: Vec<BytesN<32>> = (1u8..=7)
            .map(|seed| dummy_commitment(&env, seed))
            .collect();
        for c in commits.iter() {
            client.deposit(&depositor, c);
        }
        assert_eq!(client.get_next_index(), 7);

        // A page whose start+limit lands exactly on next_index should return
        // the remaining leaves with no zero-padding beyond them.
        let page = client.get_commitments_page(&5, &2);
        assert_eq!(page.len(), 2);
        assert_eq!(page.get(0).unwrap(), commits[5]);
        assert_eq!(page.get(1).unwrap(), commits[6]);

        // A page that starts exactly at next_index (0 remaining) is empty.
        let empty = client.get_commitments_page(&7, &5);
        assert_eq!(empty.len(), 0);

        // Paging through in full reconstructs the same list/order as
        // get_commitments, and the same root.
        let mut paged: SorobanVec<BytesN<32>> = SorobanVec::new(&env);
        let mut start = 0u32;
        loop {
            let page = client.get_commitments_page(&start, &3);
            if page.is_empty() {
                break;
            }
            let page_len = page.len();
            for c in page.iter() {
                paged.push_back(c);
            }
            start += page_len;
        }
        assert_eq!(paged, client.get_commitments());
        assert_eq!(
            rebuild_root(&env, &paged),
            client.get_root().unwrap()
        );
    }

    #[test]
    fn test_get_commitments_page_out_of_range_start_is_empty() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        client.deposit(&depositor, &dummy_commitment(&env, 2));
        assert_eq!(client.get_next_index(), 2);

        // start == next_index
        assert_eq!(client.get_commitments_page(&2, &10).len(), 0);
        // start far beyond next_index
        assert_eq!(client.get_commitments_page(&1_000, &10).len(), 0);
    }

    #[test]
    fn test_get_commitments_page_empty_pool() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        assert_eq!(client.get_commitments_page(&0, &10).len(), 0);
    }

    #[test]
    fn test_get_commitments_page_clamps_limit_above_max() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commits: Vec<BytesN<32>> = (1u8..=5)
            .map(|seed| dummy_commitment(&env, seed))
            .collect();
        for c in commits.iter() {
            client.deposit(&depositor, c);
        }

        // A limit far above MAX_PAGE_SIZE is silently clamped, not rejected —
        // the caller just gets at most MAX_PAGE_SIZE leaves (or fewer, if
        // next_index is smaller than that, as here).
        let page = client.get_commitments_page(&0, &1_000_000);
        assert_eq!(page.len(), 5);
        for (i, c) in commits.iter().enumerate() {
            assert_eq!(page.get(i as u32).unwrap(), *c);
        }
    }

    #[test]
    fn test_deposit_batch_matches_sequential_deposits() {
        // A single deposit_batch of N commitments must leave the pool in the
        // exact same state (root, indices, balance) as N sequential single
        // deposits — this is what lets the wallet collapse N signatures into 1
        // without breaking the leaf-index / Merkle-root invariants.
        let seq_env = Env::default();
        seq_env.mock_all_auths();
        seq_env.cost_estimate().budget().reset_unlimited();
        let (seq_pool, seq_dep, _) = setup_with_token(&seq_env);
        let seq = PoolContractClient::new(&seq_env, &seq_pool);
        for seed in 1u8..=7 {
            seq.deposit(&seq_dep, &dummy_commitment(&seq_env, seed));
        }

        let batch_env = Env::default();
        batch_env.mock_all_auths();
        batch_env.cost_estimate().budget().reset_unlimited();
        let (batch_pool, batch_dep, batch_token) = setup_with_token(&batch_env);
        let batch = PoolContractClient::new(&batch_env, &batch_pool);
        let token = TokenClient::new(&batch_env, &batch_token);

        let mut commitments = SorobanVec::new(&batch_env);
        for seed in 1u8..=7 {
            commitments.push_back(dummy_commitment(&batch_env, seed));
        }
        let first_index = batch.deposit_batch(&batch_dep, &commitments);

        assert_eq!(first_index, 0);
        assert_eq!(batch.get_next_index(), 7);
        assert_eq!(batch.get_root().unwrap(), seq.get_root().unwrap());
        assert_eq!(token.balance(&batch_pool), 10_000_000 * 7);
        // Indices are sequential and the rebuilt root matches the on-chain root.
        let commits = batch.get_commitments();
        assert_eq!(commits.len(), 7);
        assert_eq!(rebuild_root(&batch_env, &commits), batch.get_root().unwrap());
    }

    #[test]
    fn test_deposit_batch_rejects_duplicate_in_batch() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);
        let balance_before = token.balance(&depositor);

        let mut commitments = SorobanVec::new(&env);
        commitments.push_back(dummy_commitment(&env, 1));
        commitments.push_back(dummy_commitment(&env, 1)); // duplicate

        let result = client.try_deposit_batch(&depositor, &commitments);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::CommitmentExists);
        // Atomic: nothing inserted, no tokens moved.
        assert_eq!(client.get_next_index(), 0);
        assert_eq!(token.balance(&depositor), balance_before);
    }

    #[test]
    fn test_deposit_batch_empty_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commitments = SorobanVec::new(&env);
        let result = client.try_deposit_batch(&depositor, &commitments);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_deposit_batch_rejects_oversized_batch() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);
        let balance_before = token.balance(&depositor);

        let mut commitments = SorobanVec::new(&env);
        for seed in 0..(MAX_BATCH_SIZE + 1) {
            commitments.push_back(dummy_commitment(&env, seed as u8));
        }

        let result = client.try_deposit_batch(&depositor, &commitments);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::BatchTooLarge);
        // Rejected up-front: no leaves inserted, no tokens moved.
        assert_eq!(client.get_next_index(), 0);
        assert_eq!(token.balance(&depositor), balance_before);
    }

    #[test]
    fn test_deposit_batch_accepts_max_batch_size() {
        // reset_unlimited() only disables the local CPU/memory metering
        // budget; the separate "invocation exceeded transaction resource
        // limits" check (real network instruction/footprint caps) still
        // applies, so this proves MAX_BATCH_SIZE fits in one transaction, not
        // just that it satisfies the in-contract check.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let mut commitments = SorobanVec::new(&env);
        for seed in 0..MAX_BATCH_SIZE {
            commitments.push_back(dummy_commitment(&env, seed as u8));
        }

        let first_index = client.deposit_batch(&depositor, &commitments);
        assert_eq!(first_index, 0);
        assert_eq!(client.get_next_index(), MAX_BATCH_SIZE);
    }

    #[test]
    #[should_panic]
    fn test_constructor_rejects_zero_deposit_amount() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let admin = <Address as TestAddress>::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let verifier_id = <Address as TestAddress>::generate(&env);

        let _pool_id: Address =
            env.register(PoolContract, (verifier_id, token_id.address(), 0i128));
    }

    #[test]
    #[should_panic]
    fn test_constructor_rejects_negative_deposit_amount() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let admin = <Address as TestAddress>::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let verifier_id = <Address as TestAddress>::generate(&env);

        let _pool_id: Address =
            env.register(PoolContract, (verifier_id, token_id.address(), -1i128));
    }

    #[test]
    fn test_reconstructed_root_matches_onchain_root() {
        // The Merkle root rebuilt from get_commitments() (the exact data a
        // client uses for a withdrawal proof) must equal the contract's own
        // incrementally-maintained root. This is the invariant the wallet's
        // withdraw flow depends on.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for seed in 1u8..=5 {
            client.deposit(&depositor, &dummy_commitment(&env, seed));
        }

        let commitments = client.get_commitments();
        let onchain_root = client.get_root().unwrap();
        let rebuilt = rebuild_root(&env, &commitments);
        assert_eq!(rebuilt, onchain_root);
    }

    // Rebuild a full Merkle root from an ordered list of leaves, exactly as a
    // client would, using the same zero subtree values and pairing order as
    // the contract's incremental insertion.
    fn rebuild_root(env: &Env, commitments: &SorobanVec<BytesN<32>>) -> BytesN<32> {
        let zeroes = zeroes_for_tree(env);
        let mut level: Vec<BytesN<32>> = Vec::new();
        for c in commitments.iter() {
            level.push(c);
        }
        if level.is_empty() {
            return zeroes[TREE_DEPTH as usize].clone();
        }
        for depth in 0..TREE_DEPTH as usize {
            let mut next: Vec<BytesN<32>> = Vec::new();
            let mut i = 0;
            while i < level.len() {
                let left = level[i].clone();
                let right = if i + 1 < level.len() {
                    level[i + 1].clone()
                } else {
                    zeroes[depth].clone()
                };
                next.push(poseidon2_hash2(env, &left, &right));
                i += 2;
            }
            level = next;
        }
        level[0].clone()
    }

    #[test]
    fn test_multiple_depositors_independent() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, d1, d2, token_addr) = setup_multi_depositor(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);

        let c1 = dummy_commitment(&env, 1);
        let c2 = dummy_commitment(&env, 2);

        let idx1 = client.deposit(&d1, &c1);
        let idx2 = client.deposit(&d2, &c2);

        assert_eq!(idx1, 0);
        assert_eq!(idx2, 1);
        assert_eq!(token.balance(&pool_id), 20_000_000);
    }

    #[test]
    fn test_same_commitment_different_depositors_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, d1, d2, _) = setup_multi_depositor(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c = dummy_commitment(&env, 1);
        client.deposit(&d1, &c);

        let result = client.try_deposit(&d2, &c);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::CommitmentExists);
    }

    // ──────────────────────────────────────────────
    //  Deposit: error cases
    // ──────────────────────────────────────────────

    #[test]
    fn test_duplicate_commitment_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let result = client.try_deposit(&depositor, &c1);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::CommitmentExists);
    }

    #[test]
    fn test_deposit_requires_auth() {
        let env = Env::default();
        // intentionally NOT calling mock_all_auths
        env.cost_estimate().budget().reset_unlimited();
        let admin = <Address as TestAddress>::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());

        let depositor = <Address as TestAddress>::generate(&env);
        let verifier_id = <Address as TestAddress>::generate(&env);
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), 10_000_000i128, admin.clone()),
        );
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        let result = client.try_deposit(&depositor, &c1);
        assert!(result.is_err());
    }

    // ──────────────────────────────────────────────
    //  Deposit: Merkle tree properties
    // ──────────────────────────────────────────────

    #[test]
    fn test_multiple_deposits_different_roots() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);
        let root1 = client.get_root().unwrap();

        let c2 = dummy_commitment(&env, 2);
        client.deposit(&depositor, &c2);
        let root2 = client.get_root().unwrap();

        assert_ne!(root1, root2);
    }

    #[test]
    fn test_same_commitment_sequence_produces_deterministic_root() {
        let env1 = Env::default();
        env1.mock_all_auths();
        env1.cost_estimate().budget().reset_unlimited();
        let (pool1, dep1, _) = setup_with_token(&env1);
        let client1 = PoolContractClient::new(&env1, &pool1);

        let env2 = Env::default();
        env2.mock_all_auths();
        env2.cost_estimate().budget().reset_unlimited();
        let (pool2, dep2, _) = setup_with_token(&env2);
        let client2 = PoolContractClient::new(&env2, &pool2);

        let c = dummy_commitment(&env1, 42);
        client1.deposit(&dep1, &c);

        let c = dummy_commitment(&env2, 42);
        client2.deposit(&dep2, &c);

        assert_eq!(client1.get_root().unwrap(), client2.get_root().unwrap());
    }

    #[test]
    fn test_root_changes_each_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let mut prev_root: Option<BytesN<32>> = None;
        for i in 1u8..=4 {
            let c = dummy_commitment(&env, i);
            client.deposit(&depositor, &c);
            let root = client.get_root().unwrap();
            if let Some(pr) = &prev_root {
                assert_ne!(pr, &root);
            }
            prev_root = Some(root);
        }
    }

    // ──────────────────────────────────────────────
    //  Deposit: root history
    // ──────────────────────────────────────────────

    #[test]
    fn test_root_history_accepts_old_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);
        let root_after_first = client.get_root().unwrap();

        let c2 = dummy_commitment(&env, 2);
        client.deposit(&depositor, &c2);
        let root_after_second = client.get_root().unwrap();
        assert_ne!(root_after_first, root_after_second);

        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root_after_first.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let recipient = <Address as TestAddress>::generate(&env);
        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_ne!(result.err().unwrap().unwrap(), PoolError::RootMismatch);
    }

    #[test]
    fn test_current_root_accepted_for_withdraw() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);
        let current_root = client.get_root().unwrap();

        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&current_root.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let recipient = <Address as TestAddress>::generate(&env);
        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        // Should pass root check, fail at proof verification
        assert_ne!(result.err().unwrap().unwrap(), PoolError::RootMismatch);
    }

    // ──────────────────────────────────────────────
    //  Withdraw: error cases
    // ──────────────────────────────────────────────

    #[test]
    fn test_nullifier_unused_by_default() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let nf = dummy_commitment(&env, 99);
        assert!(!client.is_nullifier_used(&nf));
    }

    #[test]
    fn test_withdraw_no_root_fails() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let recipient = <Address as TestAddress>::generate(&env);
        let public_inputs = Bytes::from_slice(&env, &[0u8; 96]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::RootNotSet);
    }

    #[test]
    fn test_withdraw_wrong_proof_length() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let recipient = <Address as TestAddress>::generate(&env);
        let public_inputs = Bytes::from_slice(&env, &[0u8; 96]);
        let bad_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_withdraw(&recipient, &public_inputs, &bad_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::VerificationFailed
        );
    }

    #[test]
    fn test_withdraw_bad_public_inputs_length() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let recipient = <Address as TestAddress>::generate(&env);
        let bad_inputs = Bytes::from_slice(&env, &[0u8; 32]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &bad_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_withdraw_empty_public_inputs() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let recipient = <Address as TestAddress>::generate(&env);
        let empty_inputs = Bytes::from_slice(&env, &[]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &empty_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_withdraw_oversized_public_inputs() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let recipient = <Address as TestAddress>::generate(&env);
        let big_inputs = Bytes::from_slice(&env, &[0u8; 128]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &big_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_withdraw_root_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let recipient = <Address as TestAddress>::generate(&env);
        let mut pi = [0u8; 96];
        pi[0] = 0xFF;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::RootMismatch);
    }

    #[test]
    fn test_withdraw_zero_length_proof() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &c1);

        let recipient = <Address as TestAddress>::generate(&env);
        let public_inputs = Bytes::from_slice(&env, &[0u8; 96]);
        let empty_proof = Bytes::from_slice(&env, &[]);

        let result = client.try_withdraw(&recipient, &public_inputs, &empty_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::VerificationFailed
        );
    }

    // ──────────────────────────────────────────────
    //  Withdraw: recipient binding (front-running protection)
    // ──────────────────────────────────────────────

    // A real account (G...) address whose Ed25519 key we can hash.
    const ACCOUNT_STRKEY: &str =
        "GDBPMKMMG3TP3HHC7TXXUCU6ZOJG6RVQIIKCUTBYNFVXIZOLASH2IYXY";

    #[test]
    fn test_recipient_hash_matches_frontend() {
        // The contract's recipient hash MUST equal the frontend's
        // computeRecipientHash for the same account, or every legitimate
        // withdrawal would be rejected. This value was produced by the
        // frontend (poseidon2.ts) for ACCOUNT_STRKEY.
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let h = recipient_hash_from_address(&env, &recipient).unwrap();
        let expected = BytesN::from_array(
            &env,
            &hex32("00ad77fd5de761a47844a8ce4405e9c67cd3a9518b78f7bd275da96a604da53f"),
        );
        assert_eq!(h, expected, "contract recipient hash != frontend");
    }

    #[test]
    fn test_withdraw_recipient_mismatch_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);

        // Valid root, but the recipient hash in the proof does NOT correspond to
        // `recipient` — simulating a front-runner swapping in their own address.
        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root.to_array());
        for b in pi[64..96].iter_mut() {
            *b = 0xAA;
        }
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::RecipientMismatch
        );
    }

    // A second real account (G...) address, distinct from ACCOUNT_STRKEY, so a
    // proof can be bound to one account and the payout attempted to the other.
    const OTHER_ACCOUNT_STRKEY: &str = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";

    #[test]
    fn test_withdraw_to_different_recipient_than_proof_rejected() {
        // Recipient binding (README Security Model #2): a withdrawal proof bound
        // to recipient A must not pay out to a different address B. This is the
        // front-running case — a relayer or observer takes a pending withdrawal
        // proof off the mempool and resubmits it with their own payout address.
        //
        // Unlike test_withdraw_recipient_mismatch_rejected, which uses a filler
        // hash, this builds public inputs holding the *genuine* recipient hash
        // of account A and then calls withdraw with account B as the payout
        // address, which is what an actual redirect attack looks like on-chain.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();

        let recipient_a = Address::from_str(&env, ACCOUNT_STRKEY);
        let recipient_b = Address::from_str(&env, OTHER_ACCOUNT_STRKEY);
        assert_ne!(recipient_a, recipient_b);

        let hash_a = recipient_hash_from_address(&env, &recipient_a).unwrap();
        let hash_b = recipient_hash_from_address(&env, &recipient_b).unwrap();
        assert_ne!(
            hash_a, hash_b,
            "distinct accounts must hash to distinct recipient hashes"
        );

        // Public inputs of a legitimate withdrawal bound to A.
        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&hash_a.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        // Submitted with B as the payout address: rejected before verification.
        let result = client.try_withdraw(&recipient_b, &public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::RecipientMismatch,
            "an A-bound proof must not pay out to B"
        );
    }

    #[test]
    fn test_withdraw_correct_recipient_passes_binding() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        // The hash the contract derives for this recipient — what a real proof
        // for this recipient would commit to.
        let correct = recipient_hash_from_address(&env, &recipient).unwrap();

        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&correct.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        // Recipient binding passes; the (dummy) proof fails verification instead.
        assert_ne!(
            result.err().unwrap().unwrap(),
            PoolError::RecipientMismatch
        );
    }

    #[test]
    fn test_withdraw_contract_recipient_unsupported() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();

        // A generated test address is a contract (C...) address; withdrawals to
        // contracts aren't supported by the recipient-binding scheme.
        let recipient = <Address as TestAddress>::generate(&env);
        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::UnsupportedRecipient
        );
    }

    // ──────────────────────────────────────────────
    //  Getters / constructor
    // ──────────────────────────────────────────────

    #[test]
    fn test_get_token_and_amount() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let _ = client.get_token();
        assert_eq!(client.get_deposit_amount(), 10_000_000);
    }

    #[test]
    fn test_initial_state_no_root() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        assert!(client.get_root().is_none());
        assert_eq!(client.get_next_index(), 0);
    }

    #[test]
    fn test_parse_public_inputs_boundary() {
        let bytes95 = Bytes::from_slice(&Env::default(), &[0u8; 95]);
        let result = parse_public_inputs(&bytes95);
        assert_eq!(result.err().unwrap(), PoolError::InvalidPublicInputs);

        let bytes97 = Bytes::from_slice(&Env::default(), &[0u8; 97]);
        let result = parse_public_inputs(&bytes97);
        assert_eq!(result.err().unwrap(), PoolError::InvalidPublicInputs);

        let mut arr96 = [0u8; 96];
        arr96[0] = 0xAA;
        arr96[32] = 0xBB;
        arr96[64] = 0xCC;
        let bytes96 = Bytes::from_slice(&Env::default(), &arr96);
        let (root, nf, recip) = parse_public_inputs(&bytes96).unwrap();
        assert_eq!(root[0], 0xAA);
        assert_eq!(nf[0], 0xBB);
        assert_eq!(recip[0], 0xCC);
    }

    // ──────────────────────────────────────────────
    //  Security: nullifier double-spend protection
    // ──────────────────────────────────────────────

    #[test]
    fn test_nullifier_read_from_persistent_storage() {
        // Lock in the storage location: is_nullifier_used must read PERSISTENT
        // storage (where withdraw writes used nullifiers). If it read instance
        // storage, this persistent write would be invisible and the assert
        // would fail — catching an accidental regression back to instance.
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let nf = dummy_commitment(&env, 42);
        assert!(!client.is_nullifier_used(&nf));
        env.as_contract(&pool_id, || {
            let key = (key_nullifier_prefix(), nf.clone());
            env.storage().persistent().set(&key, &true);
        });
        assert!(client.is_nullifier_used(&nf));
    }

    #[test]
    fn test_commitment_read_from_persistent_storage() {
        // Same guard for commitments-by-index (deposit writes them to
        // persistent; get_commitment must read from there).
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c = dummy_commitment(&env, 7);
        client.deposit(&depositor, &c);

        // The value is in persistent storage, readable via as_contract.
        let stored: Option<BytesN<32>> = env.as_contract(&pool_id, || {
            env.storage()
                .persistent()
                .get(&(key_commitment_by_index_prefix(), 0u32))
        });
        assert_eq!(stored, Some(c.clone()));
        assert_eq!(client.get_commitment(&0), Some(c));
    }

    #[test]
    fn test_replaying_consumed_nullifier_returns_nullifier_used() {
        // Double-spend prevention (README Security Model #3): once a nullifier
        // has been consumed by a withdrawal, replaying a proof carrying that
        // same nullifier MUST fail with NullifierUsed.
        //
        // The nullifier check is the first storage check in `withdraw`, ahead of
        // root, recipient-binding and proof verification, so the replay is
        // rejected on the nullifier alone — a replayed proof never reaches the
        // verifier. Consuming the nullifier directly (rather than driving a real
        // withdrawal, which needs a genuine UltraHonk proof) reproduces exactly
        // the post-withdrawal state: `withdraw` marks a spend by writing
        // `(nf prefix, nullifier) -> true` to persistent storage.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let recipient_hash = recipient_hash_from_address(&env, &recipient).unwrap();
        let nullifier = dummy_commitment(&env, 99);

        // Public inputs for a well-formed withdrawal: known root, this
        // nullifier, and the recipient hash this payout address really binds to.
        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root.to_array());
        pi[32..64].copy_from_slice(&nullifier.to_array());
        pi[64..96].copy_from_slice(&recipient_hash.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        // Before the spend, nothing rejects on the nullifier — the dummy proof
        // fails verification instead. This proves the NullifierUsed below comes
        // from the replay, not from some unrelated check.
        let first = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_ne!(
            first.err().unwrap().unwrap(),
            PoolError::NullifierUsed,
            "nullifier must not be considered used before it is consumed"
        );

        // The withdrawal consumes the nullifier.
        env.as_contract(&pool_id, || {
            env.storage()
                .persistent()
                .set(&(key_nullifier_prefix(), nullifier.clone()), &true);
        });
        assert!(client.is_nullifier_used(&nullifier));

        // Replaying the very same proof is rejected as a double-spend.
        let replay = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(
            replay.err().unwrap().unwrap(),
            PoolError::NullifierUsed,
            "replaying a consumed nullifier must be rejected"
        );
    }

    #[test]
    fn test_multiple_distinct_nullifiers_independent() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for i in 0u8..10 {
            let nf = dummy_commitment(&env, i);
            assert!(!client.is_nullifier_used(&nf));
        }
    }

    // ──────────────────────────────────────────────
    //  is_known_root (used by compliance cross-contract calls)
    // ──────────────────────────────────────────────

    #[test]
    fn test_is_known_root_true_for_current_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();
        assert!(client.is_known_root(&root));
    }

    #[test]
    fn test_is_known_root_true_for_historical_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let old_root = client.get_root().unwrap();
        client.deposit(&depositor, &dummy_commitment(&env, 2));

        assert!(client.is_known_root(&old_root));
    }

    #[test]
    fn test_is_known_root_false_for_unknown_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let bogus = BytesN::from_array(&env, &[0xEE; 32]);
        assert!(!client.is_known_root(&bogus));
    }

    // ──────────────────────────────────────────────
    //  Deposit batch: overflow
    // ──────────────────────────────────────────────

    #[test]
    fn test_deposit_batch_amount_overflow_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let admin = <Address as TestAddress>::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let depositor = <Address as TestAddress>::generate(&env);
        let verifier_id = <Address as TestAddress>::generate(&env);
        // deposit_amount * count overflows i128 for any count >= 2.
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), i128::MAX, admin.clone()),
        );
        let client = PoolContractClient::new(&env, &pool_id);

        let mut commitments = SorobanVec::new(&env);
        commitments.push_back(dummy_commitment(&env, 1));
        commitments.push_back(dummy_commitment(&env, 2));

        let result = client.try_deposit_batch(&depositor, &commitments);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::AmountOverflow);
    }

    #[test]
    fn test_zero_commitment_valid() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let zero_cm = BytesN::from_array(&env, &[0u8; 32]);
        let idx = client.deposit(&depositor, &zero_cm);
        assert_eq!(idx, 0);
    }

    #[test]
    fn test_max_value_commitment_valid() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let max_cm = BytesN::from_array(&env, &[0xFF; 32]);
        let idx = client.deposit(&depositor, &max_cm);
        assert_eq!(idx, 0);
    }

    // ──────────────────────────────────────────────
    //  Admin: pause / unpause circuit breaker
    // ──────────────────────────────────────────────

    #[test]
    fn test_pool_not_paused_by_default() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        assert!(!client.is_paused());
    }

    #[test]
    fn test_pause_blocks_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.pause();
        assert!(client.is_paused());

        let c1 = dummy_commitment(&env, 1);
        let result = client.try_deposit(&depositor, &c1);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::Paused);
    }

    #[test]
    fn test_pause_blocks_deposit_batch() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.pause();

        let mut commitments = SorobanVec::new(&env);
        commitments.push_back(dummy_commitment(&env, 1));
        let result = client.try_deposit_batch(&depositor, &commitments);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::Paused);
    }

    #[test]
    fn test_pause_blocks_withdraw() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        client.pause();

        let recipient = <Address as TestAddress>::generate(&env);
        let public_inputs = Bytes::from_slice(&env, &[0u8; 96]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);
        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::Paused);
    }

    #[test]
    fn test_unpause_restores_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.pause();
        client.unpause();
        assert!(!client.is_paused());

        let idx = client.deposit(&depositor, &dummy_commitment(&env, 1));
        assert_eq!(idx, 0);
    }

    #[test]
    fn test_pause_requires_admin_auth() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        // Reject any auth so pause (called without mocking) fails.
        env.set_auths(&[]);
        let result = client.try_pause();
        assert!(result.is_err());
    }

    #[test]
    fn test_unpause_requires_admin_auth() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        env.mock_all_auths();
        client.pause();

        // Reject any auth so unpause (called without mocking) fails.
        env.set_auths(&[]);
        let result = client.try_unpause();
        assert!(result.is_err());
    }

    #[test]
    fn test_pause_emits_paused_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let admin = client.get_admin().unwrap();

        client.pause();

        let expected = PausedEvent { paused_by: &admin };
        assert_eq!(
            *env.events().all().events().last().unwrap(),
            expected.to_xdr(&env, &pool_id),
        );
    }

    #[test]
    fn test_unpause_emits_unpaused_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let admin = client.get_admin().unwrap();

        client.pause();
        client.unpause();

        let expected = UnpausedEvent {
            unpaused_by: &admin,
        };
        assert_eq!(
            *env.events().all().events().last().unwrap(),
            expected.to_xdr(&env, &pool_id),
        );
    }

    // ──────────────────────────────────────────────
    //  Admin: set_verifier
    // ──────────────────────────────────────────────

    #[test]
    fn test_set_verifier_emits_event_with_addresses() {
        let env = Env::default();
        env.mock_all_auths();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let admin = client.get_admin().unwrap();

        // The verifier_id generated inside setup_with_token isn't returned to
        // the caller, so instead call set_verifier twice and confirm the
        // second event's previous_verifier equals the first call's new one —
        // this proves the stored verifier actually changed.
        let v1 = <Address as TestAddress>::generate(&env);
        client.set_verifier(&v1);
        let v2 = <Address as TestAddress>::generate(&env);
        client.set_verifier(&v2);

        let expected = VerifierUpdatedEvent {
            previous_verifier: &v1,
            new_verifier: &v2,
            updated_by: &admin,
        };
        assert_eq!(
            *env.events().all().events().last().unwrap(),
            expected.to_xdr(&env, &pool_id),
        );
    }

    #[test]
    fn test_set_verifier_requires_admin_auth() {
        let env = Env::default();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let new_verifier = <Address as TestAddress>::generate(&env);

        // Reject any auth so set_verifier (called without mocking) fails.
        env.set_auths(&[]);
        let result = client.try_set_verifier(&new_verifier);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_verifier_then_withdraw_uses_new_verifier() {
        // Proves set_verifier actually changes which contract withdraw calls
        // into: pointing the pool at a bogus (non-contract) address makes
        // withdraw fail at the cross-contract call rather than succeeding.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &dummy_commitment(&env, 1));
        let root = client.get_root().unwrap();

        let bogus_verifier = <Address as TestAddress>::generate(&env);
        client.set_verifier(&bogus_verifier);

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let correct = recipient_hash_from_address(&env, &recipient).unwrap();

        let mut pi = [0u8; 96];
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&correct.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::VerificationFailed
        );
    }
}
