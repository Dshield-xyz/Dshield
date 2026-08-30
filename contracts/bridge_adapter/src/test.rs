#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Bytes, BytesN, Env};

fn create_token_contract<'a>(env: &Env, admin: &Address) -> (Address, token::Client<'a>, token::StellarAssetClient<'a>) {
    let addr = env.register_stellar_asset_contract_v2(admin.clone());
    (
        addr.clone(),
        token::Client::new(env, &addr),
        token::StellarAssetClient::new(env, &addr),
    )
}

fn setup() -> (Env, Address, Address, Address, Address, BridgeAdapterClient<'static>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let pool = Address::generate(&env);
    let bridge_protocol = Address::generate(&env);
    
    let (token_addr, _, token_admin) = create_token_contract(&env, &admin);
    token_admin.mint(&pool, &1_000_000_000); // Give pool 1000 USDC

    let adapter_addr = env.register(BridgeAdapter, ());
    let adapter = BridgeAdapterClient::new(&env, &adapter_addr);

    adapter.initialize(&admin, &pool, &token_addr);

    (env, admin, pool, token_addr, bridge_protocol, adapter)
}

#[test]
fn test_initialize() {
    let (env, admin, pool, token, _, adapter) = setup();
    assert_eq!(adapter.get_admin(), admin);
    assert_eq!(adapter.get_pool(), pool);
    assert_eq!(adapter.is_paused(), false);
}

#[test]
#[should_panic(expected = "AlreadyInitialized")]
fn test_cannot_initialize_twice() {
    let (env, admin, pool, token, _, adapter) = setup();
    let new_admin = Address::generate(&env);
    adapter.initialize(&new_admin, &pool, &token);
}

#[test]
fn test_configure_bridge() {
    let (env, admin, _, _, bridge_protocol, adapter) = setup();

    let config = BridgeConfig {
        protocol_address: bridge_protocol.clone(),
        min_amount: 1_000_000, // 1 USDC
        max_amount: 1_000_000_000_000, // 1M USDC
        enabled: true,
    };

    adapter.configure_bridge(&ChainId::Ethereum, &config);

    let stored = adapter.get_config(&ChainId::Ethereum).unwrap();
    assert_eq!(stored.protocol_address, bridge_protocol);
    assert_eq!(stored.min_amount, 1_000_000);
    assert_eq!(stored.enabled, true);
}

#[test]
#[should_panic(expected = "AmountTooSmall")]
fn test_configure_bridge_invalid_amounts() {
    let (env, admin, _, _, bridge_protocol, adapter) = setup();

    let config = BridgeConfig {
        protocol_address: bridge_protocol.clone(),
        min_amount: 1_000_000,
        max_amount: 500_000, // max < min
        enabled: true,
    };

    adapter.configure_bridge(&ChainId::Ethereum, &config);
}

#[test]
fn test_pause_unpause() {
    let (env, admin, _, _, _, adapter) = setup();

    adapter.pause();
    assert_eq!(adapter.is_paused(), true);

    adapter.unpause();
    assert_eq!(adapter.is_paused(), false);
}

#[test]
fn test_admin_transfer() {
    let (env, admin, _, _, _, adapter) = setup();
    let new_admin = Address::generate(&env);

    adapter.transfer_admin(&new_admin);
    assert_eq!(adapter.get_admin(), admin); // Still old admin

    adapter.accept_admin();
    assert_eq!(adapter.get_admin(), new_admin); // Now new admin
}

#[test]
fn test_compute_destination_hash_ethereum() {
    let env = Env::default();
    
    // Sample Ethereum address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
    let eth_addr_hex = "742d35Cc6634C0532925a3b844Bc9e7595f0bEb";
    let mut eth_addr_bytes = [0u8; 20];
    hex::decode_to_slice(eth_addr_hex, &mut eth_addr_bytes).unwrap();
    let destination = Bytes::from_array(&env, &eth_addr_bytes);

    let hash = compute_destination_hash(&env, ChainId::Ethereum, &destination).unwrap();
    
    // Hash should be deterministic and non-zero
    assert_ne!(hash, BytesN::from_array(&env, &[0u8; 32]));
    
    // Same input should produce same output
    let hash2 = compute_destination_hash(&env, ChainId::Ethereum, &destination).unwrap();
    assert_eq!(hash, hash2);
    
    // Different chain ID should produce different hash (domain separation)
    let hash_polygon = compute_destination_hash(&env, ChainId::Polygon, &destination).unwrap();
    assert_ne!(hash, hash_polygon);
}

#[test]
#[should_panic(expected = "InvalidDestination")]
fn test_invalid_destination_length() {
    let env = Env::default();
    
    // Invalid: 19 bytes instead of 20
    let invalid = Bytes::from_array(&env, &[0u8; 19]);
    compute_destination_hash(&env, ChainId::Ethereum, &invalid).unwrap();
}
