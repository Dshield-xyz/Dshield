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
    /// accept_admin called with no admin rotation in progress.
    NoPendingAdmin = 13,
    ViewVkNotSet = 14,
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

/// Confirms `root` is a state one of the configured pools actually reached,
/// which is what makes a proof against it meaningful rather than a proof about
/// a tree the prover made up.
///
/// This is the whole of the on-chain binding now. The amount a note carries is
/// committed inside its leaf (see circuits/*/src/main.nr `hash_leaf`), so the
/// circuit itself proves `disclosed_amount` is the note's value and that the
/// note clears a `threshold`. The contract previously had to recover the figure
/// out-of-band from the pool's fixed denomination, because the leaf committed
/// to no amount and the circuit's `amount` witness was unconstrained; notes
/// carry their own value now, so that workaround retired along with the
/// denominations.
fn root_belongs_to_pool(env: &Env, pools: &SorobanVec<Address>, root: &BytesN<32>) -> bool {
    for pool in pools.iter() {
        if pool_has_root(env, &pool, root) {
            return true;
        }
    }
    false
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

#[contractevent(topics = ["view_vk_updated"])]
pub struct ViewVkUpdatedEvent<'a> {
    pub updated_by: &'a Address,
}

#[contractevent(topics = ["view_disclosure_verified"])]
pub struct ViewDisclosureVerifiedEvent<'a> {
    pub view_key: &'a BytesN<32>,
    pub amount: &'a BytesN<32>,
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
    fn key_view_vk() -> Symbol {
        symbol_short!("vvk")
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

        // The circuit proves `disclosed_amount` is the note's committed value;
        // all this has to establish is that the tree the note was proved against
        // is really one of ours.
        let pools: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&Self::key_pools())
            .unwrap_or(SorobanVec::new(&env));
        if !root_belongs_to_pool(&env, &pools, &merkle_root) {
            return Err(ComplianceError::UnknownMerkleRoot);
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

        // The circuit proves the note's committed value is at least
        // `threshold`; all this has to establish is that the tree the note was
        // proved against is really one of ours.
        let pools: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&Self::key_pools())
            .unwrap_or(SorobanVec::new(&env));
        if !root_belongs_to_pool(&env, &pools, &merkle_root) {
            return Err(ComplianceError::UnknownMerkleRoot);
        }
        let mut threshold_arr = [0u8; 32];
        threshold_arr.copy_from_slice(&buf[64..96]);
        if field_bytes_to_u128(&threshold_arr).is_none() {
            return Err(ComplianceError::InvalidPublicInputs);
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

    pub fn set_view_vk(env: Env, vk_bytes: Bytes) -> Result<(), ComplianceError> {
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
        env.storage().instance().set(&Self::key_view_vk(), &vk_bytes);

        ViewVkUpdatedEvent { updated_by: &admin }.publish(&env);

        Ok(())
    }

    /// Verifies a view-only disclosure proof: the holder of a note proves its
    /// `amount` to whoever they handed `view_key` to out of band, without
    /// revealing `nullifier`/`secret` or exposing any spend capability. Unlike
    /// `verify_compliance`/`verify_disclosure`, this is not a regulatory
    /// attestation and is not gated on KYC -- a viewing key is a generic
    /// "let this party look" delegation (an auditor, a bookkeeper, a
    /// co-signer), not a compliance statement about the holder's identity.
    pub fn verify_view_disclosure(
        env: Env,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), ComplianceError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(ComplianceError::ProofParseError);
        }
        bump_instance(&env);

        // Public inputs: [merkle_root(32), view_key(32), amount(32)]
        if public_inputs.len() != 96 {
            return Err(ComplianceError::InvalidPublicInputs);
        }

        let mut buf = [0u8; 96];
        public_inputs.copy_into_slice(&mut buf);

        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&Self::key_view_vk())
            .ok_or(ComplianceError::ViewVkNotSet)?;

        let mut root_arr = [0u8; 32];
        root_arr.copy_from_slice(&buf[0..32]);
        let merkle_root = BytesN::from_array(&env, &root_arr);

        let pools: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&Self::key_pools())
            .unwrap_or(SorobanVec::new(&env));
        if !root_belongs_to_pool(&env, &pools, &merkle_root) {
            return Err(ComplianceError::UnknownMerkleRoot);
        }

        let mut view_key_arr = [0u8; 32];
        view_key_arr.copy_from_slice(&buf[32..64]);
        let view_key = BytesN::from_array(&env, &view_key_arr);

        let mut amount_arr = [0u8; 32];
        amount_arr.copy_from_slice(&buf[64..96]);
        if field_bytes_to_u128(&amount_arr).is_none() {
            return Err(ComplianceError::InvalidPublicInputs);
        }
        let amount = BytesN::from_array(&env, &amount_arr);

        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => ComplianceError::VkInvalidLength,
            VkLoadError::InvalidParameters => ComplianceError::VkInvalidParameters,
        })?;

        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| ComplianceError::VerificationFailed)?;

        ViewDisclosureVerifiedEvent {
            view_key: &view_key,
            amount: &amount,
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

    fn setup_pool(env: &Env) -> (Address, Address, i128) {
        use dshield_pool::PoolContract;
        use soroban_sdk::token::StellarAssetClient;

        let token_admin = <Address as TestAddress>::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(token_admin.clone());
        let sac = StellarAssetClient::new(env, &token_id.address());
        let depositor = <Address as TestAddress>::generate(env);
        sac.mint(&depositor, &1_000_000_000);

        let verifier_id = <Address as TestAddress>::generate(env);
        // Just the value this fixture's note happens to hold. Pools have no
        // denomination any more, so nothing downstream depends on the figure.
        let note_amount: i128 = 100_000_000;
        let pool_admin = <Address as TestAddress>::generate(env);
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), pool_admin),
        );
        let mut arr = [0u8; 32];
        arr[0] = 7;
        let commitment = BytesN::from_array(env, &arr);
        dshield_pool::PoolContractClient::new(env, &pool_id)
            .deposit(&depositor, &token_id.address(), &commitment, &note_amount);
        (pool_id, token_id.address(), note_amount)
    }

    fn setup_with_pool(env: &Env) -> (Address, Address, Address, i128) {
        let admin = <Address as TestAddress>::generate(env);
        let (pool_id, _token_addr, deposit_amount) = setup_pool(env);
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
    fn test_verify_compliance_leaves_the_amount_to_the_circuit() {
        // The contract no longer second-guesses `disclosed_amount`: the note's
        // value is committed inside its leaf, so the circuit proves the figure
        // and a false one simply produces a proof that doesn't verify. What the
        // contract still owns is the root check, so an arbitrary amount against
        // a known root must fall through to VerificationFailed -- proof that the
        // amount gate is gone rather than silently accepting.
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, note_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        pi[64..96].copy_from_slice(&amount_field_bytes(note_amount * 2));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_compliance(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::VerificationFailed
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
    fn test_verify_disclosure_leaves_the_threshold_to_the_circuit() {
        // Counterpart to the compliance case: `threshold` is now checked
        // against the note's committed value inside the circuit, so the
        // contract only has to establish that the root is one of ours and let
        // proof verification decide the rest.
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, note_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        client.set_disclosure_vk(&disclosure_vk_bytes(&env));

        let kyc_hash = dummy_hash(&env, 1);
        client.register_kyc(&kyc_hash);

        let mut pi = [0u8; 128];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[32..64].copy_from_slice(&kyc_hash.to_array());
        pi[64..96].copy_from_slice(&amount_field_bytes(note_amount + 1));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_disclosure(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::VerificationFailed
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

    // ──────────────────────────────────────────────
    //  View-only disclosure: VK management
    // ──────────────────────────────────────────────

    fn view_vk_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/view_disclosure/target/vk"),
        )
    }

    #[test]
    fn test_set_view_vk_stores_vk() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        client.set_view_vk(&view_vk_bytes(&env));

        assert!(env.as_contract(&contract_id, || {
            env.storage().instance().has(&ComplianceContract::key_view_vk())
        }));
    }

    #[test]
    fn test_set_view_vk_requires_admin() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let result = client.try_set_view_vk(&view_vk_bytes(&env));
        assert!(result.is_err());
    }

    #[test]
    fn test_set_view_vk_invalid_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let short_vk = Bytes::from_slice(&env, &[0u8; 32]);
        let result = client.try_set_view_vk(&short_vk);
        assert!(result.is_err());
    }

    #[test]
    fn test_set_view_vk_emits_view_vk_updated_event() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        client.set_view_vk(&view_vk_bytes(&env));

        let expected = ViewVkUpdatedEvent { updated_by: &admin };
        assert_eq!(
            env.events().all(),
            std::vec![expected.to_xdr(&env, &contract_id)],
        );
    }

    // ──────────────────────────────────────────────
    //  View-only disclosure: verification
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_view_disclosure_vk_not_set() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let pi = Bytes::from_slice(&env, &[0u8; 96]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_view_disclosure(&pi, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ViewVkNotSet
        );
    }

    #[test]
    fn test_verify_view_disclosure_bad_public_inputs_length() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let bad_inputs = Bytes::from_slice(&env, &[0u8; 64]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_view_disclosure(&bad_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_verify_view_disclosure_wrong_proof_length() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        client.set_view_vk(&view_vk_bytes(&env));

        let pi = Bytes::from_slice(&env, &[0u8; 96]);
        let bad_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_view_disclosure(&pi, &bad_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    #[test]
    fn test_verify_view_disclosure_proof_length_checked_before_vk() {
        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        let pi = Bytes::from_slice(&env, &[0u8; 96]);
        let short_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_verify_view_disclosure(&pi, &short_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::ProofParseError
        );
    }

    #[test]
    fn test_verify_view_disclosure_unknown_root_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, _pool_id, _amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        client.set_view_vk(&view_vk_bytes(&env));

        // pi[0..32] left as zero, which is not this pool's root.
        let pi = Bytes::from_slice(&env, &[0u8; 96]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_view_disclosure(&pi, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::UnknownMerkleRoot
        );
    }

    #[test]
    fn test_verify_view_disclosure_known_root_passes_gate() {
        // The root/VK gates pass; the dummy proof fails verification instead
        // -- proving the gate let a well-formed request through rather than
        // silently accepting it.
        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, _admin, pool_id, deposit_amount) = setup_with_pool(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);
        client.set_view_vk(&view_vk_bytes(&env));

        let mut pi = [0u8; 96];
        pi[0..32].copy_from_slice(&root_of(&env, &pool_id).to_array());
        pi[64..96].copy_from_slice(&amount_field_bytes(deposit_amount));
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_verify_view_disclosure(&public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            ComplianceError::VerificationFailed
        );
    }

    // ──────────────────────────────────────────────
    //  Key separation: a viewing key's public-input schema carries no
    //  nullifier-shaped field, so there is nothing for a verifier to extract
    //  from a view-disclosure proof/public-inputs pair that could be used as
    //  (or to derive) spend-capable material. This is a structural assertion
    //  about what crosses the contract boundary, complementing the circuit's
    //  own zero-knowledge property over `nullifier` (see circuits/view_disclosure).
    // ──────────────────────────────────────────────

    #[test]
    fn test_view_disclosure_public_inputs_are_exactly_root_viewkey_amount() {
        // 96 bytes = 3 field elements: merkle_root, view_key, amount. Nothing
        // else fits, so a nullifier can never be smuggled through this
        // entrypoint's public inputs.
        assert_eq!(96, 32 * 3);

        let env = Env::default();
        let (contract_id, _admin) = setup(&env);
        let client = ComplianceContractClient::new(&env, &contract_id);

        // One byte short or over is rejected outright, pinning the schema to
        // exactly 3 field elements.
        let too_short = Bytes::from_slice(&env, &[0u8; 95]);
        let too_long = Bytes::from_slice(&env, &[0u8; 97]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        assert_eq!(
            client.try_verify_view_disclosure(&too_short, &proof).err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
        assert_eq!(
            client.try_verify_view_disclosure(&too_long, &proof).err().unwrap().unwrap(),
            ComplianceError::InvalidPublicInputs
        );
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
