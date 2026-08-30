#![no_std]

//! # Bridge Adapter Contract
//!
//! Swappable interface between DShield's shielded pool and cross-chain bridge
//! protocols. The pool never directly integrates a specific bridge; instead,
//! it calls this adapter, which can be upgraded or swapped without touching
//! the core pool logic.
//!
//! ## Trust Boundary
//!
//! The bridge adapter is a NEW trust boundary that DShield's circuits cannot
//! enforce. The adapter can:
//! - Censor withdrawals (refuse to bridge)
//! - Delay withdrawals (hold funds)
//! - Fail to deliver on destination chain (bridge protocol risk)
//!
//! The adapter CANNOT:
//! - Redirect funds to a different destination (destination is bound in proof)
//! - Double-spend nullifiers (enforced by pool contract)
//! - Steal funds from the pool (only pool can call with valid proof)
//!
//! Users must trust:
//! 1. The specific bridge protocol (Wormhole, CCTP, etc.)
//! 2. The admin who can upgrade the adapter implementation
//! 3. The destination chain's finality guarantees

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, token, Address, Bytes,
    BytesN, Env, String, Symbol, Vec as SorobanVec,
};

const BUMP_AMOUNT: u32 = 7 * 24 * 60 * 60; // 7 days in seconds
const BUMP_THRESHOLD: u32 = BUMP_AMOUNT - 24 * 60 * 60; // Extend when < 6 days left

#[derive(Clone, Copy)]
#[contracterror]
#[repr(u32)]
pub enum BridgeError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    InvalidChainId = 4,
    InvalidDestination = 5,
    BridgeProtocolError = 6,
    AmountTooSmall = 7,
    AmountTooLarge = 8,
    UnsupportedChain = 9,
    Paused = 10,
}

/// Supported destination chains. Start with Ethereum (where most liquidity is).
#[derive(Clone, Copy, PartialEq, Eq)]
#[contracttype]
#[repr(u32)]
pub enum ChainId {
    Ethereum = 1,
    Polygon = 2,
    Arbitrum = 3,
    Optimism = 4,
    Base = 5,
}

/// Configuration for a specific bridge protocol integration.
#[derive(Clone)]
#[contracttype]
pub struct BridgeConfig {
    /// The actual bridge protocol contract (e.g., Wormhole Token Bridge)
    pub protocol_address: Address,
    /// Minimum withdrawal amount in stroops (prevents dust spam)
    pub min_amount: i128,
    /// Maximum per-transaction amount (bridge protocol limit)
    pub max_amount: i128,
    /// Whether this bridge route is currently enabled
    pub enabled: bool,
}

#[contracttype]
#[derive(Clone)]
pub enum StorageKey {
    Admin,
    PendingAdmin,
    Pool,           // Address of the pool contract allowed to call bridge_withdraw
    Token,          // Token being bridged (must match pool's token)
    Paused,
    Config(ChainId), // Per-chain bridge configuration
}

fn key_admin() -> StorageKey {
    StorageKey::Admin
}

fn key_pending_admin() -> StorageKey {
    StorageKey::PendingAdmin
}

fn key_pool() -> StorageKey {
    StorageKey::Pool
}

fn key_token() -> StorageKey {
    StorageKey::Token
}

fn key_paused() -> StorageKey {
    StorageKey::Paused
}

fn key_config(chain: ChainId) -> StorageKey {
    StorageKey::Config(chain)
}

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

fn load_admin(env: &Env) -> Result<Address, BridgeError> {
    env.storage()
        .instance()
        .get(&key_admin())
        .ok_or(BridgeError::NotInitialized)
}

fn require_admin(env: &Env) -> Result<(), BridgeError> {
    load_admin(env)?.require_auth();
    Ok(())
}

fn load_pool(env: &Env) -> Result<Address, BridgeError> {
    env.storage()
        .instance()
        .get(&key_pool())
        .ok_or(BridgeError::NotInitialized)
}

fn require_pool(env: &Env) -> Result<(), BridgeError> {
    load_pool(env)?.require_auth();
    Ok(())
}

fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&key_paused())
        .unwrap_or(false)
}

fn load_config(env: &Env, chain: ChainId) -> Result<BridgeConfig, BridgeError> {
    env.storage()
        .instance()
        .get(&key_config(chain))
        .ok_or(BridgeError::UnsupportedChain)
}

#[contract]
pub struct BridgeAdapter;

#[contractimpl]
impl BridgeAdapter {
    /// Initialize the bridge adapter.
    ///
    /// # Arguments
    /// * `admin` - Can configure bridge routes, pause, and upgrade
    /// * `pool` - The pool contract allowed to call `bridge_withdraw`
    /// * `token` - The token being bridged (must match pool's token)
    pub fn initialize(env: Env, admin: Address, pool: Address, token: Address) -> Result<(), BridgeError> {
        if env.storage().instance().has(&key_admin()) {
            return Err(BridgeError::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&key_admin(), &admin);
        env.storage().instance().set(&key_pool(), &pool);
        env.storage().instance().set(&key_token(), &token);
        env.storage().instance().set(&key_paused(), &false);

        bump_instance(&env);
        Ok(())
    }

    /// Configure a bridge route for a specific destination chain.
    ///
    /// # Arguments
    /// * `chain` - Destination chain identifier
    /// * `config` - Bridge protocol configuration
    pub fn configure_bridge(
        env: Env,
        chain: ChainId,
        config: BridgeConfig,
    ) -> Result<(), BridgeError> {
        require_admin(&env)?;
        
        if config.min_amount < 0 || config.max_amount < config.min_amount {
            return Err(BridgeError::AmountTooSmall);
        }

        env.storage().instance().set(&key_config(chain), &config);
        bump_instance(&env);
        Ok(())
    }

    /// Bridge a withdrawal to a destination chain.
    ///
    /// Called by the pool contract after proof verification. The pool has
    /// already verified that:
    /// 1. The withdrawal proof is valid
    /// 2. The nullifier is being spent for the first time
    /// 3. The destination hash in the proof matches `destination_hash`
    /// 4. The amount matches the proof
    ///
    /// This function's job is to:
    /// 1. Validate the destination encoding
    /// 2. Check bridge limits
    /// 3. Transfer tokens from pool to bridge protocol
    /// 4. Initiate the cross-chain transfer
    ///
    /// # Arguments
    /// * `chain` - Destination chain
    /// * `destination` - Recipient address on destination chain (encoding is chain-specific)
    /// * `amount` - Amount to bridge (in token's native units)
    /// * `destination_hash` - Poseidon hash of destination, verified against proof by pool
    ///
    /// # Returns
    /// Bridge transaction ID or reference for tracking
    pub fn bridge_withdraw(
        env: Env,
        chain: ChainId,
        destination: Bytes,
        amount: i128,
        destination_hash: BytesN<32>,
    ) -> Result<Bytes, BridgeError> {
        require_pool(&env)?;
        
        if is_paused(&env) {
            return Err(BridgeError::Paused);
        }

        bump_instance(&env);

        let config = load_config(&env, chain)?;
        if !config.enabled {
            return Err(BridgeError::UnsupportedChain);
        }

        if amount < config.min_amount {
            return Err(BridgeError::AmountTooSmall);
        }
        if amount > config.max_amount {
            return Err(BridgeError::AmountTooLarge);
        }

        // Validate destination encoding for the specific chain
        validate_destination(&env, chain, &destination)?;

        // Re-verify destination hash to ensure pool and adapter agree on encoding
        let computed_hash = compute_destination_hash(&env, chain, &destination)?;
        if computed_hash != destination_hash {
            return Err(BridgeError::InvalidDestination);
        }

        let token_addr: Address = env.storage().instance().get(&key_token()).unwrap();
        let pool_addr = load_pool(&env)?;

        // Transfer tokens from pool to this adapter (pool has already approved)
        let token_client = token::TokenClient::new(&env, &token_addr);
        token_client.transfer(&pool_addr, &env.current_contract_address(), &amount);

        // Approve bridge protocol to spend tokens
        token_client.approve(
            &env.current_contract_address(),
            &config.protocol_address,
            &amount,
            &(env.ledger().sequence() + 100), // 100 ledgers ≈ 8 minutes
        );

        // Call bridge protocol to initiate cross-chain transfer
        // NOTE: This is a PLACEHOLDER. Real integration depends on the specific
        // bridge protocol (Wormhole, CCTP, etc.). Each protocol has different:
        // - Method names (e.g., "initiate_transfer", "deposit_for_burn")
        // - Parameter formats (e.g., Wormhole uses wire format, CCTP uses different encoding)
        // - Confirmation mechanisms (e.g., Wormhole uses VAAs, CCTP uses attestations)
        let bridge_tx_id = bridge_via_protocol(&env, &config, chain, destination, amount)?;

        Ok(bridge_tx_id)
    }

    /// Pause all bridge operations (emergency stop).
    pub fn pause(env: Env) -> Result<(), BridgeError> {
        require_admin(&env)?;
        env.storage().instance().set(&key_paused(), &true);
        bump_instance(&env);
        Ok(())
    }

    /// Resume bridge operations.
    pub fn unpause(env: Env) -> Result<(), BridgeError> {
        require_admin(&env)?;
        env.storage().instance().set(&key_paused(), &false);
        bump_instance(&env);
        Ok(())
    }

    /// Transfer admin role to a new address (two-step process).
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), BridgeError> {
        require_admin(&env)?;
        env.storage().instance().set(&key_pending_admin(), &new_admin);
        bump_instance(&env);
        Ok(())
    }

    /// Accept admin role (completes two-step transfer).
    pub fn accept_admin(env: Env) -> Result<(), BridgeError> {
        let pending: Address = env
            .storage()
            .instance()
            .get(&key_pending_admin())
            .ok_or(BridgeError::Unauthorized)?;
        pending.require_auth();

        env.storage().instance().set(&key_admin(), &pending);
        env.storage().instance().remove(&key_pending_admin());
        bump_instance(&env);
        Ok(())
    }

    // View functions

    pub fn get_admin(env: Env) -> Address {
        load_admin(&env).unwrap()
    }

    pub fn get_pool(env: Env) -> Address {
        load_pool(&env).unwrap()
    }

    pub fn get_config(env: Env, chain: ChainId) -> Option<BridgeConfig> {
        env.storage().instance().get(&key_config(chain))
    }

    pub fn is_paused(env: Env) -> bool {
        is_paused(&env)
    }
}

/// Validate destination address encoding for a specific chain.
fn validate_destination(env: &Env, chain: ChainId, destination: &Bytes) -> Result<(), BridgeError> {
    match chain {
        ChainId::Ethereum | ChainId::Polygon | ChainId::Arbitrum | ChainId::Optimism | ChainId::Base => {
            // EVM chains: 20-byte address
            if destination.len() != 20 {
                return Err(BridgeError::InvalidDestination);
            }
        }
    }
    Ok(())
}

/// Compute Poseidon2 hash of destination, matching the circuit's encoding.
///
/// CRITICAL: This encoding MUST match the circuit's `hash_destination` function
/// exactly, or the pool's verification will reject valid proofs.
fn compute_destination_hash(env: &Env, chain: ChainId, destination: &Bytes) -> Result<BytesN<32>, BridgeError> {
    validate_destination(env, chain, destination)?;

    match chain {
        ChainId::Ethereum | ChainId::Polygon | ChainId::Arbitrum | ChainId::Optimism | ChainId::Base => {
            // EVM chains: 20-byte address
            // Split into 10 + 10 bytes, right-align each in 32-byte buffer
            let mut left_buf = [0u8; 32];
            let mut right_buf = [0u8; 32];
            
            for i in 0..10 {
                left_buf[22 + i] = destination.get(i).unwrap().unwrap();
                right_buf[22 + i] = destination.get(10 + i).unwrap().unwrap();
            }

            let left_bytes = BytesN::<32>::from_array(env, &left_buf);
            let right_bytes = BytesN::<32>::from_array(env, &right_buf);

            // Add chain ID as domain separator to prevent cross-chain replay
            let chain_id_buf = [(chain as u32).to_be_bytes(), [0u8; 28]].concat();
            let chain_id_bytes = BytesN::<32>::from_array(env, chain_id_buf.as_slice().try_into().unwrap());

            // Poseidon2(chain_id, left_part, right_part)
            let hash = env.crypto().poseidon2_hash(&[chain_id_bytes, left_bytes, right_bytes].into());
            Ok(hash)
        }
    }
}

/// Initiate cross-chain transfer via the configured bridge protocol.
///
/// PLACEHOLDER IMPLEMENTATION: Real bridge integration depends on the specific
/// protocol. Common options:
///
/// - **Wormhole**: Call `transfer_tokens_with_payload` with VAA-based finality
/// - **CCTP** (Circle's Cross-Chain Transfer Protocol): Call `deposit_for_burn`
/// - **Axelar**: Call `send_token` with GMP (General Message Passing)
/// - **LayerZero**: Call `send` with omnichain messaging
///
/// Each protocol has different:
/// - Method signatures
/// - Destination encoding (Wormhole chain IDs vs EVM chain IDs)
/// - Fee models (some charge in native token, some in bridged token)
/// - Confirmation times (finality proofs, attestations, etc.)
fn bridge_via_protocol(
    env: &Env,
    config: &BridgeConfig,
    chain: ChainId,
    destination: Bytes,
    amount: i128,
) -> Result<Bytes, BridgeError> {
    // STUB: Return a fake transaction ID for now
    // Real implementation would:
    // 1. Convert chain ID to bridge protocol's format
    // 2. Call protocol_address.invoke("initiate_transfer", ...)
    // 3. Parse protocol-specific response
    // 4. Return bridge transaction ID for client-side tracking
    
    let stub_tx_id = env.crypto().sha256(&destination);
    Ok(stub_tx_id.into())
}

#[cfg(test)]
mod test;
