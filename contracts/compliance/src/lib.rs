#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, symbol_short, Address, Bytes, BytesN,
    Env, InvokeError, IntoVal, Symbol, Val, Vec as SorobanVec,
};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, VkLoadError, PROOF_BYTES};

#[contract]
pub struct ComplianceContract;

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum ComplianceError {
    VkInvalidLength = 1,
    VkInvalidParameters = 2,
    ProofParseError = 3,
    VerificationFailed = 4,
    VkNotSet = 5,
    AlreadyInitialized = 6,
    InvalidPublicInputs = 7,
    KycNotRegistered = 8,
    DisclosureVkNotSet = 9,
    /// merkle_root in the public inputs doesn't belong to any configured pool.
    UnknownMerkleRoot = 10,
    /// disclosed_amount doesn't equal the actual fixed deposit_amount of the
    /// pool the merkle_root belongs to.
    AmountMismatch = 11,
    /// threshold exceeds the actual fixed deposit_amount of the pool the
    /// merkle_root belongs to.
    ThresholdNotMet = 12,
    /// accept_admin called with no admin rotation in progress.
    NoPendingAdmin = 13,
}

/// Cross-contract call into a pool's `is_known_root(root) -> bool` view.
/// Returns false on any invocation error (e.g. `pool` isn't a real pool
/// contract), so a misconfigured pool address simply never matches rather
/// than panicking.
fn pool_has_root(env: &Env, pool: &Address, root: &BytesN<32>) -> bool {
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(root.into_val(env));
    env.try_invoke_contract::<bool, InvokeError>(pool, &Symbol::new(env, "is_known_root"), args)
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or(false)
}

/// Cross-contract call into a pool's `get_deposit_amount() -> Result<i128,_>`.
fn pool_deposit_amount(env: &Env, pool: &Address) -> Option<i128> {
    let args: SorobanVec<Val> = SorobanVec::new(env);
    env.try_invoke_contract::<i128, InvokeError>(pool, &Symbol::new(env, "get_deposit_amount"), args)
        .ok()
        .and_then(|r| r.ok())
}

/// Finds the configured pool that `root` belongs to and returns its fixed
/// per-note deposit amount. This is the authoritative source of "amount" for
/// any note — the circuit's `amount` witness is never constrained to the
/// note itself (see main.nr), so it cannot be trusted; the pool the root
/// came from is what actually fixes the amount (DShield pools are
/// fixed-denomination: every note in a given pool has the same amount).
fn amount_for_root(env: &Env, pools: &SorobanVec<Address>, root: &BytesN<32>) -> Option<i128> {
    for pool in pools.iter() {
        if pool_has_root(env, &pool, root) {
            return pool_deposit_amount(env, &pool);
        }
    }
    None
}

/// Encodes a non-negative i128 as the 32-byte big-endian field element the
/// Noir circuit and frontend would produce for that plain integer value
/// (top 16 bytes zero, value right-aligned in the low 16 bytes) — the same
/// convention as the pool contract's own Poseidon2 input encoding.
fn amount_to_field_bytes(amount: i128) -> [u8; 32] {
    let mut buf = [0u8; 32];
    buf[16..32].copy_from_slice(&(amount as u128).to_be_bytes());
    buf
}

/// Decodes a 32-byte public-input field element back to u128, rejecting any
/// value that doesn't fit (top 16 bytes must be zero) rather than silently
/// truncating.
fn field_bytes_to_u128(bytes: &[u8; 32]) -> Option<u128> {
    if bytes[0..16] != [0u8; 16] {
        return None;
    }
    let mut b16 = [0u8; 16];
    b16.copy_from_slice(&bytes[16..32]);
    Some(u128::from_be_bytes(b16))
}

#[contractevent(topics = ["kyc_registered"])]
pub struct KycRegisteredEvent<'a> {
    pub kyc_hash: &'a BytesN<32>,
    pub registrar: &'a Address,
}

#[contractevent(topics = ["compliance_verified"])]
pub struct ComplianceVerifiedEvent<'a> {
    pub kyc_hash: &'a BytesN<32>,
    pub auditor_key: &'a BytesN<32>,
}

#[contractevent(topics = ["disclosure_verified"])]
pub struct DisclosureVerifiedEvent<'a> {
    pub kyc_hash: &'a BytesN<32>,
    pub auditor_key: &'a BytesN<32>,
    pub threshold: &'a BytesN<32>,
}

#[contractevent(topics = ["pools_updated"])]
pub struct PoolsUpdatedEvent<'a> {
    pub pool_count: u32,
    pub updated_by: &'a Address,
}

#[contractevent(topics = ["disclosure_vk_updated"])]
pub struct DisclosureVkUpdatedEvent<'a> {
    pub updated_by: &'a Address,
}

#[contractevent(topics = ["admin_updated"])]
pub struct AdminUpdatedEvent<'a> {
    pub previous_admin: &'a Address,
    pub new_admin: &'a Address,
}

// KYC registry, VKs, admin, and pools all live in bounded instance storage.
// Every state-mutating or verification entrypoint extends the TTL so the
// entry doesn't silently expire and brick the contract between demos.
const BUMP_THRESHOLD: u32 = 17_280; // ~1 day of ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days of ledgers

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

#[contractimpl]
impl ComplianceContract {
    fn key_vk() -> Symbol {
        symbol_short!("vk")
    }
    fn key_admin() -> Symbol {
        symbol_short!("admin")
    }
    fn key_kyc_prefix() -> Symbol {
        symbol_short!("kyc")
    }
    fn key_disclosure_vk() -> Symbol {
        symbol_short!("dvk")
    }
    fn key_pools() -> Symbol {
        symbol_short!("pools")
    }
    fn key_pending_admin() -> Symbol {
        symbol_short!("pendadm")
    }

    pub fn __constructor(
        env: Env,
        vk_bytes: Bytes,
        admin: Address,
        pools: soroban_sdk::Vec<Address>,
    ) -> Result<(), ComplianceError> {
        if env.storage().instance().has(&Self::key_vk()) {
            return Err(ComplianceError::AlreadyInitialized);
        }
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => ComplianceError::VkInvalidLength,
            VkLoadError::InvalidParameters => ComplianceError::VkInvalidParameters,
        })?;
        env.storage().instance().set(&Self::key_vk(), &vk_bytes);
        env.storage().instance().set(&Self::key_admin(), &admin);
        env.storage().instance().set(&Self::key_pools(), &pools);
        Ok(())
    }

    /// Updates the set of pool contracts whose roots/amounts are trusted for
    /// compliance and disclosure verification (e.g. when a new tier is added).
    pub fn set_pools(env: Env, pools: soroban_sdk::Vec<Address>) -> Result<(), ComplianceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Self::key_admin())
            .ok_or(ComplianceError::VkNotSet)?;
        admin.require_auth();
        bump_instance(&env);
        let pool_count = pools.len();
        env.storage().instance().set(&Self::key_pools(), &pools);

        PoolsUpdatedEvent {
            pool_count,
            updated_by: &admin,
        }
        .publish(&env);

        Ok(())
    }

    pub fn get_pools(env: Env) -> soroban_sdk::Vec<Address> {
        env.storage()
            .instance()
            .get(&Self::key_pools())
            .unwrap_or(SorobanVec::new(&env))
    }

    /// Step 1 of admin rotation: the current admin nominates `new_admin`.
    /// Takes effect only once `new_admin` calls `accept_admin`, so a typoed
    /// or unreachable address can never brick admin access.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), ComplianceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Self::key_admin())
            .ok_or(ComplianceError::VkNotSet)?;
        admin.require_auth();
        bump_instance(&env);
        env.storage()
            .instance()
            .set(&Self::key_pending_admin(), &new_admin);
        Ok(())
    }

    /// Step 2 of admin rotation: the proposed admin claims the role. Must be
    /// called by the address passed to `propose_admin`; the previous admin
    /// loses access as soon as this succeeds.
    pub fn accept_admin(env: Env) -> Result<(), ComplianceError> {
        let pending_admin: Address = env
            .storage()
            .instance()
            .get(&Self::key_pending_admin())
            .ok_or(ComplianceError::NoPendingAdmin)?;
        pending_admin.require_auth();
        bump_instance(&env);

        let previous_admin: Address = env
            .storage()
            .instance()
            .get(&Self::key_admin())
            .ok_or(ComplianceError::VkNotSet)?;

        env.storage()
            .instance()
            .set(&Self::key_admin(), &pending_admin);
        env.storage().instance().remove(&Self::key_pending_admin());

        AdminUpdatedEvent {
            previous_admin: &previous_admin,
            new_admin: &pending_admin,
        }
        .publish(&env);

        Ok(())
    }

    pub fn register_kyc(env: Env, kyc_hash: BytesN<32>) -> Result<(), ComplianceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Self::key_admin())
            .ok_or(ComplianceError::VkNotSet)?;
        admin.require_auth();
        bump_instance(&env);

        let kyc_key = (Self::key_kyc_prefix(), kyc_hash.clone());
        env.storage().instance().set(&kyc_key, &true);

        KycRegisteredEvent {
            kyc_hash: &kyc_hash,
            registrar: &admin,
        }
        .publish(&env);

        Ok(())
    }

    pub fn is_kyc_registered(env: Env, kyc_hash: BytesN<32>) -> bool {
        let kyc_key = (Self::key_kyc_prefix(), kyc_hash);
        env.storage().instance().has(&kyc_key)
    }

    pub fn verify_compliance(
        env: Env,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), ComplianceError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(ComplianceError::ProofParseError);
        }
        bump_instance(&env);

        // Public inputs: [merkle_root(32), kyc_hash(32), disclosed_amount(32), auditor_key(32)]
        if public_inputs.len() != 128 {
            return Err(ComplianceError::InvalidPublicInputs);
        }

        let mut buf = [0u8; 128];
        public_inputs.copy_into_slice(&mut buf);

        let mut root_arr = [0u8; 32];
        root_arr.copy_from_slice(&buf[0..32]);
        let merkle_root = BytesN::from_array(&env, &root_arr);

        let mut kyc_arr = [0u8; 32];
        kyc_arr.copy_from_slice(&buf[32..64]);
        let kyc_hash = BytesN::from_array(&env, &kyc_arr);

        let kyc_key = (Self::key_kyc_prefix(), kyc_hash.clone());
        if !env.storage().instance().has(&kyc_key) {
            return Err(ComplianceError::KycNotRegistered);
        }

        // Authoritative amount binding: `disclosed_amount` is only trustworthy
        // if it matches the fixed deposit_amount of whichever configured pool
        // the merkle_root actually belongs to (see amount_for_root doc comment).
        let pools: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&Self::key_pools())
            .unwrap_or(SorobanVec::new(&env));
        let pool_amount =
            amount_for_root(&env, &pools, &merkle_root).ok_or(ComplianceError::UnknownMerkleRoot)?;
        let mut disclosed_arr = [0u8; 32];
        disclosed_arr.copy_from_slice(&buf[64..96]);
        if disclosed_arr != amount_to_field_bytes(pool_amount) {
            return Err(ComplianceError::AmountMismatch);
        }

        let mut auditor_arr = [0u8; 32];
        auditor_arr.copy_from_slice(&buf[96..128]);
        let auditor_key = BytesN::from_array(&env, &auditor_arr);

        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&Self::key_vk())
            .ok_or(ComplianceError::VkNotSet)?;

        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => ComplianceError::VkInvalidLength,
            VkLoadError::InvalidParameters => ComplianceError::VkInvalidParameters,
        })?;

        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| ComplianceError::VerificationFailed)?;

        ComplianceVerifiedEvent {
            kyc_hash: &kyc_hash,
            auditor_key: &auditor_key,
        }
        .publish(&env);

        Ok(())
    }

    pub fn set_disclosure_vk(env: Env, vk_bytes: Bytes) -> Result<(), ComplianceError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&Self::key_admin())
            .ok_or(ComplianceError::VkNotSet)?;
        admin.require_auth();
        bump_instance(&env);

        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => ComplianceError::VkInvalidLength,
            VkLoadError::InvalidParameters => ComplianceError::VkInvalidParameters,
        })?;
        env.storage()
            .instance()
            .set(&Self::key_disclosure_vk(), &vk_bytes);

        DisclosureVkUpdatedEvent {
            updated_by: &admin,
        }
        .publish(&env);

        Ok(())
    }

    pub fn verify_disclosure(
        env: Env,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), ComplianceError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(ComplianceError::ProofParseError);
        }
        bump_instance(&env);

        // Public inputs: [merkle_root(32), kyc_hash(32), threshold(32), auditor_key(32)]
        if public_inputs.len() != 128 {
            return Err(ComplianceError::InvalidPublicInputs);
        }

        let mut buf = [0u8; 128];
        public_inputs.copy_into_slice(&mut buf);

        let mut root_arr = [0u8; 32];
        root_arr.copy_from_slice(&buf[0..32]);
        let merkle_root = BytesN::from_array(&env, &root_arr);

        let mut kyc_arr = [0u8; 32];
        kyc_arr.copy_from_slice(&buf[32..64]);
        let kyc_hash = BytesN::from_array(&env, &kyc_arr);

        let kyc_key = (Self::key_kyc_prefix(), kyc_hash.clone());
        if !env.storage().instance().has(&kyc_key) {
            return Err(ComplianceError::KycNotRegistered);
        }

        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&Self::key_disclosure_vk())
            .ok_or(ComplianceError::DisclosureVkNotSet)?;

        // Authoritative threshold binding: the note's real amount is the
        // deposit_amount of whichever configured pool merkle_root belongs to
        // (see amount_for_root); the claimed threshold must not exceed it.
        let pools: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&Self::key_pools())
            .unwrap_or(SorobanVec::new(&env));
        let pool_amount =
            amount_for_root(&env, &pools, &merkle_root).ok_or(ComplianceError::UnknownMerkleRoot)?;
        let mut threshold_arr = [0u8; 32];
        threshold_arr.copy_from_slice(&buf[64..96]);
        let threshold_val =
            field_bytes_to_u128(&threshold_arr).ok_or(ComplianceError::InvalidPublicInputs)?;
        if threshold_val > pool_amount as u128 {
            return Err(ComplianceError::ThresholdNotMet);
        }
        let threshold = BytesN::from_array(&env, &threshold_arr);

        let mut auditor_arr = [0u8; 32];
        auditor_arr.copy_from_slice(&buf[96..128]);
        let auditor_key = BytesN::from_array(&env, &auditor_arr);

        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => ComplianceError::VkInvalidLength,
            VkLoadError::InvalidParameters => ComplianceError::VkInvalidParameters,
        })?;

        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| ComplianceError::VerificationFailed)?;

        DisclosureVerifiedEvent {
            kyc_hash: &kyc_hash,
            auditor_key: &auditor_key,
            threshold: &threshold,
        }
        .publish(&env);

        Ok(())
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as TestAddress, Events as _, MockAuth, MockAuthInvoke},
        Env, Event,
    };

    fn vk_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/compliance/target/vk"),
        )
    }

    fn dummy_hash(env: &Env, seed: u8) -> BytesN<32> {
        let mut arr = [0u8; 32];
        arr[0] = seed;
        BytesN::from_array(env, &arr)
    }

    fn setup(env: &Env) -> (Address, Address) {
        let admin = <Address as TestAddress>::generate(env);
        let contract_id: Address = env.register(
            ComplianceContract,
            (vk_bytes(env), admin.clone(), SorobanVec::<Address>::new(env)),
        );
        (contract_id, admin)
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    #[test]
    fn test_constructor_stores_vk() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        assert!(env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&ComplianceContract::key_vk())
        }));
    }

    #[test]
    fn test_constructor_stores_admin() {
        let env = Env::default();
        let (contract_id, admin) = setup(&env);
        let stored_admin: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&ComplianceContract::key_admin())
                .unwrap()
        });
        assert_eq!(stored_admin, admin);
    }

    #[test]
    #[should_panic]
    fn test_constructor_invalid_vk_length() {
        let env = Env::default();
        let admin = <Address as TestAddress>::generate(&env);
        let short_vk = Bytes::from_slice(&env, &[0u8; 32]);
        let _contract_id: Address = env.register(
            ComplianceContract,
            (short_vk, admin, SorobanVec::<Address>::new(&env)),
        );
    }

    // ──────────────────────────────────────────────
    //  KYC Registration
    // ──────────────────────────────────────────────

    #[test]
    fn test_register_kyc_stores_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);
        assert!(client.is_kyc_registered(&kyc_hash));
    }

    #[test]
    fn test_kyc_not_registered_returns_false() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 99);
        assert!(!client.is_kyc_registered(&kyc_hash));
    }

    #[test]
    fn test_register_kyc_requires_admin_auth() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        let result = client.try_register_kyc(&kyc_hash);
        assert!(result.is_err());
    }

    #[test]
    fn test_multiple_kyc_registrations() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let h1 = dummy_hash(&env, 1);
        let h2 = dummy_hash(&env, 2);
        let h3 = dummy_hash(&env, 3);

        client.register_kyc(&h1);
        client.register_kyc(&h2);

        assert!(client.is_kyc_registered(&h1));
        assert!(client.is_kyc_registered(&h2));
        assert!(!client.is_kyc_registered(&h3));
    }

    #[test]
    fn test_register_kyc_idempotent() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);
        client.register_kyc(&kyc_hash);
        assert!(client.is_kyc_registered(&kyc_hash));
    }

    #[test]
    fn test_register_kyc_zero_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let zero_hash = BytesN::from_array(&env, &[0u8; 32]);
        client.register_kyc(&zero_hash);
        assert!(client.is_kyc_registered(&zero_hash));
    }

    #[test]
    fn test_register_kyc_max_hash() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let max_hash = BytesN::from_array(&env, &[0xFF; 32]);
        client.register_kyc(&max_hash);
        assert!(client.is_kyc_registered(&max_hash));
    }

    #[test]
    fn test_register_kyc_succeeds_with_auth() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);
        assert!(client.is_kyc_registered(&kyc_hash));
    }

    #[test]
    fn test_many_kyc_registrations_isolation() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        for i in 0u8..20 {
            let h = dummy_hash(&env, i);
            client.register_kyc(&h);
        }

        for i in 0u8..20 {
            let h = dummy_hash(&env, i);
            assert!(client.is_kyc_registered(&h));
        }

        let unregistered = dummy_hash(&env, 200);
        assert!(!client.is_kyc_registered(&unregistered));
    }

    // ──────────────────────────────────────────────
    //  Compliance Verification: input validation
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_compliance_bad_public_inputs_length() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let bad_inputs = Bytes::from_slice(&env, &[0u8; 64]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&bad_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_verify_compliance_empty_public_inputs() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let empty_inputs = Bytes::from_slice(&env, &[]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&empty_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_verify_compliance_oversized_public_inputs() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let big_inputs = Bytes::from_slice(&env, &[0u8; 256]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&big_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_verify_compliance_127_bytes_rejected() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let inputs = Bytes::from_slice(&env, &[0u8; 127]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_verify_compliance_129_bytes_rejected() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let inputs = Bytes::from_slice(&env, &[0u8; 129]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    // ──────────────────────────────────────────────
    //  Compliance Verification: KYC gate
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_compliance_kyc_not_registered() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let mut pi = [0u8; 128];
        pi[32] = 0xAB;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::KycNotRegistered
        );
    }

    #[test]
    fn test_verify_compliance_wrong_proof_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 0xAB);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[32] = 0xAB;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let bad_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_compliance(&public_inputs, &bad_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    #[test]
    fn test_verify_compliance_empty_proof() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[32] = 1;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let empty_proof = Bytes::from_slice(&env, &[]);

        let result = client.try_verify_compliance(&public_inputs, &empty_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    #[test]
    fn test_verify_compliance_kyc_hash_extraction_exact_position() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let mut kyc_arr = [0u8; 32];
        kyc_arr[0] = 0xDE;
        kyc_arr[31] = 0xAD;
        let kyc_hash = BytesN::from_array(&env, &kyc_arr);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[32..64].copy_from_slice(&kyc_arr);
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        // proof is garbage so it will fail at verification, not at KYC check
        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_ne!(
            result.err().unwrap().unwrap(),
            ComplianceError::KycNotRegistered
        );
    }

    #[test]
    fn test_verify_compliance_kyc_hash_one_bit_off_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 0xAA);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[32] = 0xAB; // one bit different from 0xAA
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::KycNotRegistered
        );
    }

    // ──────────────────────────────────────────────
    //  Compliance Verification: error ordering
    // ──────────────────────────────────────────────

    #[test]
    fn test_proof_length_checked_before_kyc() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let pi = Bytes::from_slice(&env, &[0u8; 128]);
        let short_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_compliance(&pi, &short_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    #[test]
    fn test_public_inputs_length_checked_before_proof_length() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        // Both invalid: short public inputs + short proof
        // proof length is checked first in the code
        let short_pi = Bytes::from_slice(&env, &[0u8; 64]);
        let short_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_compliance(&short_pi, &short_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    // ──────────────────────────────────────────────
    //  Disclosure VK management
    // ──────────────────────────────────────────────

    fn disclosure_vk_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/disclosure/target/vk"),
        )
    }

    #[test]
    fn test_set_disclosure_vk_stores_vk() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        assert!(env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .has(&ComplianceContract::key_disclosure_vk())
        }));
    }

    #[test]
    fn test_set_disclosure_vk_requires_admin() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let result = client.try_set_disclosure_vk(&disclosure_vk_bytes(&env));
        assert!(result.is_err());
    }

    #[test]
    fn test_set_disclosure_vk_invalid_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let short_vk = Bytes::from_slice(&env, &[0u8; 32]);
        let result = client.try_set_disclosure_vk(&short_vk);
        assert!(result.is_err());
    }

    // ──────────────────────────────────────────────
    //  Disclosure Verification
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_disclosure_vk_not_set() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[32] = 1;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_disclosure(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::DisclosureVkNotSet
        );
    }

    #[test]
    fn test_verify_disclosure_bad_public_inputs_length() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let bad_inputs = Bytes::from_slice(&env, &[0u8; 64]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_disclosure(&bad_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_verify_disclosure_kyc_not_registered() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        let mut pi = [0u8; 128];
        pi[32] = 0xAB;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_disclosure(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::KycNotRegistered
        );
    }

    #[test]
    fn test_verify_disclosure_wrong_proof_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        let kyc_hash = dummy_hash(&env, 0xAB);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[32] = 0xAB;
        let public_inputs = Bytes::from_slice(&env, &pi);
        let bad_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_disclosure(&public_inputs, &bad_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    #[test]
    fn test_verify_disclosure_proof_checked_before_kyc() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let pi = Bytes::from_slice(&env, &[0u8; 128]);
        let short_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_disclosure(&pi, &short_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    // ──────────────────────────────────────────────
    //  Pool cross-reference: amount/threshold binding
    //
    //  These exercise the real cross-contract calls (is_known_root,
    //  get_deposit_amount) against an actual dshield-pool instance, so the
    //  amount/threshold gate is proven against real pool state rather than a
    //  self-asserted public input. The compliance proof itself is still
    //  garbage in these tests (no real ZK proof is generated here), so a
    //  request that passes the new gate is expected to fail one step later
    //  at VerificationFailed — that's the signal the gate let it through.
    // ──────────────────────────────────────────────

    fn setup_pool(env: &Env) -> (Address, i128) {
        use dshield_pool::PoolContract;
        use soroban_sdk::token::StellarAssetClient;

        let token_admin = <Address as TestAddress>::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let sac = StellarAssetClient::new(env, &token_id.address());
        let depositor = <Address as TestAddress>::generate(env);
        sac.mint(&depositor, &1_000_000_000);

        let verifier_id = <Address as TestAddress>::generate(env);
        let deposit_amount: i128 = 100_000_000; // 10 USDC tier, matches justfile
        let pool_admin = <Address as TestAddress>::generate(env);
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), deposit_amount, pool_admin),
        );
        let mut arr = [0u8; 32];
        arr[0] = 7;
        let commitment = BytesN::from_array(env, &arr);
        dshield_pool::PoolContractClient::new(env, &pool_id).deposit(&depositor, &commitment);
        (pool_id, deposit_amount)
    }

    fn setup_with_pool(env: &Env) -> (Address, Address, Address, i128) {
        let admin = <Address as TestAddress>::generate(env);
        let (pool_id, deposit_amount) = setup_pool(env);
        let mut pools = soroban_sdk::Vec::new(env);
        pools.push_back(pool_id.clone());
        let contract_id: Address = env.register(
            ComplianceContract,
            (vk_bytes(env), admin.clone(), pools),
        );
        (contract_id, admin, pool_id, deposit_amount)
    }

    fn root_of(env: &Env, pool_id: &Address) -> BytesN<32> {
        dshield_pool::PoolContractClient::new(env, pool_id)
            .get_root()
            .unwrap()
    }

    fn amount_field_bytes(amount: i128) -> [u8; 32] {
        let mut buf = [0u8; 32];
        buf[16..32].copy_from_slice(&(amount as u128).to_be_bytes());
        buf
    }

    #[test]
    fn test_verify_compliance_unknown_root_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _pool_id, _amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        // pi[0..32] left as zero, which is not this pool's root.
        let mut pi = [0u8; 128];
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::UnknownMerkleRoot
        );
    }

    #[test]
    fn test_verify_compliance_amount_mismatch_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, deposit_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        // Wrong disclosed amount: claims double the real pool tier.
        pi[64..96].copy_from_slice(&amount_field_bytes(deposit_amount * 2));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::AmountMismatch
        );
    }

    #[test]
    fn test_verify_compliance_correct_amount_passes_gate() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, deposit_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        pi[64..96].copy_from_slice(&amount_field_bytes(deposit_amount));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        // The amount/root gate passes; the dummy proof fails verification
        // instead — proving the gate let a correct claim through.
        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::VerificationFailed
        );
    }

    #[test]
    fn test_verify_disclosure_threshold_within_amount_passes_gate() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, deposit_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        pi[64..96].copy_from_slice(&amount_field_bytes(deposit_amount / 2));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_disclosure(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::VerificationFailed
        );
    }

    #[test]
    fn test_verify_disclosure_threshold_exceeds_amount_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, deposit_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        // Claims a threshold higher than the pool's real fixed amount.
        pi[64..96].copy_from_slice(&amount_field_bytes(deposit_amount + 1));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_disclosure(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ThresholdNotMet
        );
    }

    #[test]
    fn test_set_pools_requires_admin() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let mut pools = soroban_sdk::Vec::new(&env);
        pools.push_back(<Address as TestAddress>::generate(&env));
        let result = client.try_set_pools(&pools);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_pools_updates_configured_pools() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let mut pools = soroban_sdk::Vec::new(&env);
        let p1 = <Address as TestAddress>::generate(&env);
        pools.push_back(p1.clone());
        client.set_pools(&pools);

        assert_eq!(client.get_pools().len(), 1);
        assert_eq!(client.get_pools().get(0).unwrap(), p1);
    }

    // ──────────────────────────────────────────────
    //  Events: set_pools / set_disclosure_vk
    // ──────────────────────────────────────────────

    #[test]
    fn test_set_pools_emits_pools_updated_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let mut pools = soroban_sdk::Vec::new(&env);
        pools.push_back(<Address as TestAddress>::generate(&env));

        client.set_pools(&pools);

        let expected = PoolsUpdatedEvent {
            pool_count: pools.len(),
            updated_by: &admin,
        };
        assert_eq!(
            env.events().all(),
            std::vec![expected.to_xdr(&env, &contract_id)],
        );
    }

    #[test]
    fn test_set_disclosure_vk_emits_disclosure_vk_updated_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        let expected = DisclosureVkUpdatedEvent { updated_by: &admin };
        assert_eq!(
            env.events().all(),
            std::vec![expected.to_xdr(&env, &contract_id)],
        );
    }

    // ──────────────────────────────────────────────
    //  Admin rotation
    // ──────────────────────────────────────────────

    #[test]
    fn test_accept_admin_transfers_privileges() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        let new_admin = <Address as TestAddress>::generate(&env);

        client.propose_admin(&new_admin);
        client.accept_admin();

        let stored_admin: Address = env.as_contract(&contract_id, || {
            env.storage()
                .instance()
                .get(&ComplianceContract::key_admin())
                .unwrap()
        });
        assert_eq!(stored_admin, new_admin);
        assert_ne!(stored_admin, admin);

        // New admin can now perform privileged actions.
        let kyc_hash = dummy_hash(&env, 1);
        assert!(client.try_register_kyc(&kyc_hash).is_ok());
    }

    #[test]
    fn test_old_admin_loses_access_after_rotation() {
        let env = Env::default();
        let (contract_id, admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        let new_admin = <Address as TestAddress>::generate(&env);

        env.mock_all_auths();
        client.propose_admin(&new_admin);
        client.accept_admin();

        // Explicitly mock only the OLD admin's auth for this call. The
        // contract now requires new_admin's auth (fetched fresh from
        // storage), so the old admin's mocked signature can't satisfy it.
        let kyc_hash = dummy_hash(&env, 1);
        env.mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &contract_id,
                fn_name: "register_kyc",
                args: (kyc_hash.clone(),).into_val(&env),
                sub_invokes: &[],
            },
        }]);
        let result = client.try_register_kyc(&kyc_hash);
        assert!(result.is_err());
    }

    #[test]
    fn test_accept_admin_requires_pending_admin_auth() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        let new_admin = <Address as TestAddress>::generate(&env);

        env.mock_all_auths();
        client.propose_admin(&new_admin);

        // Nobody's auth is mocked for accept_admin itself in this branch.
        env.set_auths(&[]);
        let result = client.try_accept_admin();
        assert!(result.is_err());
    }

    #[test]
    fn test_accept_admin_without_proposal_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let result = client.try_accept_admin();
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::NoPendingAdmin
        );
    }

    #[test]
    fn test_propose_admin_requires_current_admin_auth() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        let new_admin = <Address as TestAddress>::generate(&env);

        let result = client.try_propose_admin(&new_admin);
        assert!(result.is_err());
    }

    #[test]
    fn test_accept_admin_emits_admin_updated_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        let new_admin = <Address as TestAddress>::generate(&env);

        client.propose_admin(&new_admin);
        client.accept_admin();

        let expected = AdminUpdatedEvent {
            previous_admin: &admin,
            new_admin: &new_admin,
        };
        assert_eq!(
            env.events().all(),
            std::vec![expected.to_xdr(&env, &contract_id)],
        );
    }
}
