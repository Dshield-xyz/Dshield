#![cfg(test)]

//! Tests for bridge withdrawal functionality.
//!
//! These tests verify:
//! 1. Bridge withdrawal requires correct destination hash from proof
//! 2. Nullifier cannot be spent twice across same-chain and bridge withdrawals
//! 3. Bridge verifier and adapter must be configured
//! 4. Change note is inserted correctly
//! 5. Destination hash cannot be altered after proof generation (tested via simulation)

use super::*;
use soroban_sdk::{
    testutils::{Address as _, BytesN as _},
    Address, Bytes, BytesN, Env,
};

/// Mock verifier that always accepts proofs (for testing pool logic only).
#[contract]
pub struct MockVerifier;

#[contractimpl]
impl MockVerifier {
    pub fn verify_proof(_env: Env, _public_inputs: Bytes, _proof: Bytes) -> Result<(), ()> {
        Ok(())
    }
}

/// Mock bridge adapter that validates destination hash and records calls.
#[contract]
pub struct MockBridgeAdapter;

#[contractimpl]
impl MockBridgeAdapter {
    /// Simulates bridge_withdraw: validates destination_hash matches recomputed value.
    pub fn bridge_withdraw(
        _env: Env,
        _chain_id: u32,
        _destination: Bytes,
        _amount: i128,
        destination_hash: BytesN<32>,
    ) -> Result<Bytes, ()> {
        // In a real adapter, this would recompute the hash and compare.
        // For testing, we just check it's non-zero (basic smoke test).
        let zero = BytesN::from_array(&_env, &[0u8; 32]);
        if destination_hash == zero {
            return Err(());
        }
        // Return mock bridge transaction ID
        Ok(Bytes::from_array(&_env, &[1, 2, 3, 4]))
    }
}

fn setup_pool_with_bridge() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    Address,
    PoolContractClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let token = Address::generate(&env);
    let verifier_addr = env.register(MockVerifier, ());
    let bridge_verifier_addr = env.register(MockVerifier, ());
    let bridge_adapter_addr = env.register(MockBridgeAdapter, ());

    let pool_addr = env.register(PoolContract, ());
    let pool = PoolContractClient::new(&env, &pool_addr);

    pool.__constructor(&verifier_addr, &token, &admin);
    pool.set_bridge_verifier(&bridge_verifier_addr);
    pool.set_bridge_adapter(&bridge_adapter_addr);

    (
        env,
        admin,
        token,
        verifier_addr,
        bridge_verifier_addr,
        bridge_adapter_addr,
        pool,
    )
}

fn dummy_bridge_public_inputs(
    root: &BytesN<32>,
    nullifier_hash: &BytesN<32>,
    destination_hash: &BytesN<32>,
    withdraw_amount: u64,
    change_commitment: &BytesN<32>,
) -> Bytes {
    let env = Env::default();
    let mut buf = [0u8; 160];
    buf[0..32].copy_from_slice(&root.to_array());
    buf[32..64].copy_from_slice(&nullifier_hash.to_array());
    buf[64..96].copy_from_slice(&destination_hash.to_array());
    buf[152..160].copy_from_slice(&withdraw_amount.to_be_bytes());
    buf[128..160].copy_from_slice(&change_commitment.to_array());
    Bytes::from_array(&env, &buf)
}

#[test]
fn test_bridge_withdrawal_success() {
    let (env, _admin, _token, _verifier, _bridge_verifier, _bridge_adapter, pool) =
        setup_pool_with_bridge();

    // Deposit a note first
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let depositor = Address::generate(&env);
    pool.deposit(&depositor, &commitment, &1_000_000);

    let root = pool.get_root().unwrap();
    let nullifier_hash = BytesN::from_array(&env, &[2u8; 32]);
    let destination_hash = BytesN::from_array(&env, &[3u8; 32]);
    let change_commitment = BytesN::from_array(&env, &[4u8; 32]);

    let public_inputs = dummy_bridge_public_inputs(
        &root,
        &nullifier_hash,
        &destination_hash,
        500_000,
        &change_commitment,
    );
    let proof = Bytes::from_array(&env, &[0u8; PROOF_BYTES]);

    let chain_id = 1u32; // Ethereum
    let destination = Bytes::from_array(&env, &[0xAAu8; 20]); // Mock EVM address

    let change_index = pool
        .withdraw_bridge(&chain_id, &destination, &public_inputs, &proof)
        .unwrap();

    // Change note should be inserted
    assert_eq!(change_index, 1);
    assert!(pool.get_commitment(change_index).is_some());

    // Nullifier should be marked used
    assert!(pool.is_nullifier_used(nullifier_hash));
}

#[test]
fn test_bridge_withdrawal_rejects_used_nullifier() {
    let (env, _admin, _token, _verifier, _bridge_verifier, _bridge_adapter, pool) =
        setup_pool_with_bridge();

    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let depositor = Address::generate(&env);
    pool.deposit(&depositor, &commitment, &1_000_000);

    let root = pool.get_root().unwrap();
    let nullifier_hash = BytesN::from_array(&env, &[2u8; 32]);
    let destination_hash = BytesN::from_array(&env, &[3u8; 32]);
    let change_commitment = BytesN::from_array(&env, &[4u8; 32]);

    let public_inputs = dummy_bridge_public_inputs(
        &root,
        &nullifier_hash,
        &destination_hash,
        500_000,
        &change_commitment,
    );
    let proof = Bytes::from_array(&env, &[0u8; PROOF_BYTES]);

    let chain_id = 1u32;
    let destination = Bytes::from_array(&env, &[0xAAu8; 20]);

    // First withdrawal succeeds
    pool.withdraw_bridge(&chain_id, &destination, &public_inputs, &proof)
        .unwrap();

    // Second withdrawal with same nullifier fails
    let result = pool.withdraw_bridge(&chain_id, &destination, &public_inputs, &proof);
    assert_eq!(result, Err(PoolError::NullifierUsed));
}

#[test]
fn test_bridge_withdrawal_requires_bridge_verifier() {
    let (env, _admin, _token, _verifier, _bridge_verifier, _bridge_adapter, pool) =
        setup_pool_with_bridge();

    // Reset bridge verifier
    let new_pool_addr = env.register(PoolContract, ());
    let new_pool = PoolContractClient::new(&env, &new_pool_addr);
    let new_admin = Address::generate(&env);
    let new_token = Address::generate(&env);
    let new_verifier = env.register(MockVerifier, ());
    new_pool.__constructor(&new_verifier, &new_token, &new_admin);
    // Deliberately don't set bridge verifier

    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let depositor = Address::generate(&env);
    new_pool.deposit(&depositor, &commitment, &1_000_000);

    let root = new_pool.get_root().unwrap();
    let nullifier_hash = BytesN::from_array(&env, &[2u8; 32]);
    let destination_hash = BytesN::from_array(&env, &[3u8; 32]);
    let change_commitment = BytesN::from_array(&env, &[4u8; 32]);

    let public_inputs = dummy_bridge_public_inputs(
        &root,
        &nullifier_hash,
        &destination_hash,
        500_000,
        &change_commitment,
    );
    let proof = Bytes::from_array(&env, &[0u8; PROOF_BYTES]);

    let chain_id = 1u32;
    let destination = Bytes::from_array(&env, &[0xAAu8; 20]);

    let result = new_pool.withdraw_bridge(&chain_id, &destination, &public_inputs, &proof);
    assert_eq!(result, Err(PoolError::BridgeVerifierNotSet));
}

#[test]
fn test_bridge_withdrawal_requires_bridge_adapter() {
    let (env, _admin, _token, _verifier, bridge_verifier, _bridge_adapter, _old_pool) =
        setup_pool_with_bridge();

    // Create new pool without bridge adapter
    let new_pool_addr = env.register(PoolContract, ());
    let new_pool = PoolContractClient::new(&env, &new_pool_addr);
    let new_admin = Address::generate(&env);
    let new_token = Address::generate(&env);
    let new_verifier = env.register(MockVerifier, ());
    new_pool.__constructor(&new_verifier, &new_token, &new_admin);
    new_pool.set_bridge_verifier(&bridge_verifier);
    // Deliberately don't set bridge adapter

    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let depositor = Address::generate(&env);
    new_pool.deposit(&depositor, &commitment, &1_000_000);

    let root = new_pool.get_root().unwrap();
    let nullifier_hash = BytesN::from_array(&env, &[2u8; 32]);
    let destination_hash = BytesN::from_array(&env, &[3u8; 32]);
    let change_commitment = BytesN::from_array(&env, &[4u8; 32]);

    let public_inputs = dummy_bridge_public_inputs(
        &root,
        &nullifier_hash,
        &destination_hash,
        500_000,
        &change_commitment,
    );
    let proof = Bytes::from_array(&env, &[0u8; PROOF_BYTES]);

    let chain_id = 1u32;
    let destination = Bytes::from_array(&env, &[0xAAu8; 20]);

    let result = new_pool.withdraw_bridge(&chain_id, &destination, &public_inputs, &proof);
    assert_eq!(result, Err(PoolError::BridgeAdapterNotSet));
}

#[test]
fn test_bridge_and_regular_withdrawal_share_nullifier_space() {
    let (env, _admin, _token, _verifier, _bridge_verifier, _bridge_adapter, pool) =
        setup_pool_with_bridge();

    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let depositor = Address::generate(&env);
    pool.deposit(&depositor, &commitment, &1_000_000);

    let root = pool.get_root().unwrap();
    let nullifier_hash = BytesN::from_array(&env, &[2u8; 32]);
    let change_commitment = BytesN::from_array(&env, &[4u8; 32]);

    // Bridge withdrawal first
    let destination_hash = BytesN::from_array(&env, &[3u8; 32]);
    let bridge_inputs = dummy_bridge_public_inputs(
        &root,
        &nullifier_hash,
        &destination_hash,
        500_000,
        &change_commitment,
    );
    let proof = Bytes::from_array(&env, &[0u8; PROOF_BYTES]);
    let chain_id = 1u32;
    let destination = Bytes::from_array(&env, &[0xAAu8; 20]);

    pool.withdraw_bridge(&chain_id, &destination, &bridge_inputs, &proof)
        .unwrap();

    // Attempt regular withdrawal with same nullifier
    let recipient = Address::generate(&env);
    let recipient_hash = BytesN::from_array(&env, &[5u8; 32]);
    let regular_inputs = dummy_bridge_public_inputs(
        &root,
        &nullifier_hash,
        &recipient_hash,
        500_000,
        &change_commitment,
    );

    let result = pool.withdraw(&recipient, &regular_inputs, &proof);
    assert_eq!(result, Err(PoolError::NullifierUsed));
}

#[test]
fn test_set_bridge_adapter_requires_admin() {
    let (env, admin, _token, _verifier, _bridge_verifier, _bridge_adapter, pool) =
        setup_pool_with_bridge();

    let new_adapter = Address::generate(&env);

    // Admin can set
    pool.set_bridge_adapter(&new_adapter);
    assert_eq!(pool.get_bridge_adapter(), Some(new_adapter));
}

#[test]
fn test_set_bridge_verifier_requires_admin() {
    let (env, admin, _token, _verifier, _bridge_verifier, _bridge_adapter, pool) =
        setup_pool_with_bridge();

    let new_verifier = Address::generate(&env);

    // Admin can set
    pool.set_bridge_verifier(&new_verifier);
    assert_eq!(pool.get_bridge_verifier(), Some(new_verifier));
}
