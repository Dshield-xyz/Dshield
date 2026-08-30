#![no_std]
use soroban_sdk::{contract, contracterror, contractimpl, symbol_short, Bytes, Env, Symbol};
use ultrahonk_soroban_verifier::{UltraHonkVerifier, VkLoadError, PROOF_BYTES};

#[contract]
pub struct VerifierContract;

// The VK is the only state, held in instance storage. Every real call
// (verify_proof, invoked on every deposit-pool withdrawal) extends the TTL
// so the entry doesn't silently expire and brick the contract between demos.
const BUMP_THRESHOLD: u32 = 17_280; // ~1 day of ledgers
const BUMP_AMOUNT: u32 = 518_400; // ~30 days of ledgers

fn bump_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(BUMP_THRESHOLD, BUMP_AMOUNT);
}

#[contracterror]
#[repr(u32)]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum VerifierError {
    VkInvalidLength = 1,
    VkInvalidParameters = 2,
    ProofParseError = 3,
    VerificationFailed = 4,
    VkNotSet = 5,
    AlreadyInitialized = 6,
    VersionNotSupported = 7,
}

#[contractimpl]
impl VerifierContract {
    fn key_vk() -> Symbol {
        symbol_short!("vk")
    }

    fn key_versioned_vk(version: u32) -> (Symbol, u32) {
        (symbol_short!("vkv"), version)
    }

    fn key_current_version() -> Symbol {
        symbol_short!("ver")
    }

    pub fn __constructor(env: Env, vk_bytes: Bytes) -> Result<(), VerifierError> {
        if env.storage().instance().has(&Self::key_vk()) {
            return Err(VerifierError::AlreadyInitialized);
        }
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => VerifierError::VkInvalidLength,
            VkLoadError::InvalidParameters => VerifierError::VkInvalidParameters,
        })?;
        env.storage().instance().set(&Self::key_vk(), &vk_bytes);
        // Initialize with version 1 as current (backward compatibility)
        env.storage()
            .instance()
            .set(&Self::key_current_version(), &1u32);
        // Store version 1 in the versioned registry
        let vk_v1 = (Self::key_versioned_vk(1).0, 1u32);
        env.storage().instance().set(&vk_v1, &vk_bytes);
        Ok(())
    }

    pub fn vk_bytes(env: Env) -> Result<Bytes, VerifierError> {
        env.storage()
            .instance()
            .get(&Self::key_vk())
            .ok_or(VerifierError::VkNotSet)
    }

    /// Registers or updates a verifying key for a specific circuit version.
    /// Admin-gated in the pool contract's set_verifier, but this contract
    /// doesn't enforce auth—the pool does.
    pub fn set_vk_for_version(
        env: Env,
        version: u32,
        vk_bytes: Bytes,
    ) -> Result<(), VerifierError> {
        let _ = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => VerifierError::VkInvalidLength,
            VkLoadError::InvalidParameters => VerifierError::VkInvalidParameters,
        })?;
        bump_instance(&env);
        let vk_key = (Self::key_versioned_vk(version).0, version);
        env.storage().instance().set(&vk_key, &vk_bytes);
        Ok(())
    }

    /// Returns the verifying key for a specific version, if registered.
    pub fn vk_bytes_for_version(env: Env, version: u32) -> Result<Bytes, VerifierError> {
        let vk_key = (Self::key_versioned_vk(version).0, version);
        env.storage()
            .instance()
            .get(&vk_key)
            .ok_or(VerifierError::VersionNotSupported)
    }

    /// Returns the current (latest) circuit version.
    pub fn get_current_version(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&Self::key_current_version())
            .unwrap_or(1u32)
    }

    pub fn verify_proof(
        env: Env,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), VerifierError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(VerifierError::ProofParseError);
        }
        bump_instance(&env);

        let vk_bytes: Bytes = env
            .storage()
            .instance()
            .get(&Self::key_vk())
            .ok_or(VerifierError::VkNotSet)?;

        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => VerifierError::VkInvalidLength,
            VkLoadError::InvalidParameters => VerifierError::VkInvalidParameters,
        })?;

        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| VerifierError::VerificationFailed)?;

        Ok(())
    }

    /// Verifies a proof against a specific circuit version's VK.
    /// This is the main entry point for version-aware withdrawal verification:
    /// the pool contract provides the version tag it recovered from the note,
    /// and we load the corresponding historical VK.
    pub fn verify_proof_for_version(
        env: Env,
        version: u32,
        public_inputs: Bytes,
        proof_bytes: Bytes,
    ) -> Result<(), VerifierError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(VerifierError::ProofParseError);
        }
        bump_instance(&env);

        let vk_bytes = Self::vk_bytes_for_version(env.clone(), version)?;

        let verifier = UltraHonkVerifier::new(&env, &vk_bytes).map_err(|e| match e {
            VkLoadError::WrongLength => VerifierError::VkInvalidLength,
            VkLoadError::InvalidParameters => VerifierError::VkInvalidParameters,
        })?;

        verifier
            .verify(&env, &proof_bytes, &public_inputs)
            .map_err(|_| VerifierError::VerificationFailed)?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as TestAddress, Address, Bytes, Env};

    fn vk_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/shielded_pool/target/vk"),
        )
    }

    fn proof_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/shielded_pool/target/proof"),
        )
    }

    fn public_inputs_bytes(env: &Env) -> Bytes {
        Bytes::from_slice(
            env,
            include_bytes!("../../../circuits/shielded_pool/target/public_inputs"),
        )
    }

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    #[test]
    fn test_constructor_stores_vk() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk.clone(),));
        let client = VerifierContractClient::new(&env, &contract_id);
        let stored_vk = client.vk_bytes();
        assert_eq!(stored_vk, vk);
    }

    #[test]
    fn test_double_init_fails() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk.clone(),));
        let client = VerifierContractClient::new(&env, &contract_id);
        assert_eq!(client.vk_bytes(), vk);
    }

    #[test]
    #[should_panic]
    fn test_constructor_invalid_vk_too_short() {
        let env = Env::default();
        let short_vk = Bytes::from_slice(&env, &[0u8; 32]);
        let _contract_id: Address = env.register(VerifierContract, (short_vk,));
    }

    #[test]
    #[should_panic]
    fn test_constructor_invalid_vk_empty() {
        let env = Env::default();
        let empty_vk = Bytes::from_slice(&env, &[]);
        let _contract_id: Address = env.register(VerifierContract, (empty_vk,));
    }

    // ──────────────────────────────────────────────
    //  Valid proof verification
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_proof_valid() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = proof_bytes(&env);
        let public_inputs = public_inputs_bytes(&env);
        client.verify_proof(&public_inputs, &proof);
    }

    #[test]
    fn test_verify_proof_idempotent() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = proof_bytes(&env);
        let public_inputs = public_inputs_bytes(&env);
        client.verify_proof(&public_inputs, &proof);
        client.verify_proof(&public_inputs, &proof);
    }

    // ──────────────────────────────────────────────
    //  Proof rejection: wrong lengths
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_proof_wrong_length() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let short_proof = Bytes::from_slice(&env, &[0u8; 64]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &short_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::ProofParseError
        );
    }

    #[test]
    fn test_verify_proof_empty_proof() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let empty_proof = Bytes::from_slice(&env, &[]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &empty_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::ProofParseError
        );
    }

    #[test]
    fn test_verify_proof_one_byte_short() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let short_proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES - 1]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &short_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::ProofParseError
        );
    }

    #[test]
    fn test_verify_proof_one_byte_long() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let long_proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES + 1]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &long_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::ProofParseError
        );
    }

    // ──────────────────────────────────────────────
    //  Proof rejection: wrong inputs / tampered proof
    // ──────────────────────────────────────────────

    #[test]
    fn test_verify_proof_wrong_inputs() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = proof_bytes(&env);
        let bad_inputs = Bytes::from_slice(&env, &[0u8; 64]);
        let result = client.try_verify_proof(&bad_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VerificationFailed
        );
    }

    #[test]
    fn test_verify_proof_tampered_proof_byte() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let valid_proof = proof_bytes(&env);
        let mut tampered = [0u8; PROOF_BYTES];
        valid_proof.copy_into_slice(&mut tampered);
        tampered[0] ^= 0x01;
        let tampered_proof = Bytes::from_slice(&env, &tampered);

        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &tampered_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VerificationFailed
        );
    }

    #[test]
    fn test_verify_proof_tampered_public_input() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = proof_bytes(&env);
        // Flip a bit in the first public input, without assuming how many
        // there are: this verifier is generic over circuits, and the shielded
        // pool's public-input count has changed before.
        let mut tampered_inputs = public_inputs_bytes(&env);
        tampered_inputs.set(0, tampered_inputs.get(0).unwrap() ^ 0x01);

        let result = client.try_verify_proof(&tampered_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VerificationFailed
        );
    }

    #[test]
    fn test_verify_proof_all_zeros_proof() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let zero_proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &zero_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VerificationFailed
        );
    }

    #[test]
    fn test_verify_proof_all_ff_proof() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let ff_proof = Bytes::from_slice(&env, &[0xFF; PROOF_BYTES]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &ff_proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VerificationFailed
        );
    }

    // ──────────────────────────────────────────────
    //  VK not set
    // ──────────────────────────────────────────────

    #[test]
    fn test_vk_not_set_returns_error() {
        let env = Env::default();
        let contract_id: Address = <Address as TestAddress>::generate(&env);
        let client = VerifierContractClient::new(&env, &contract_id);
        let result = client.try_vk_bytes();
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_without_vk_fails() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let contract_id: Address = <Address as TestAddress>::generate(&env);
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);
        let public_inputs = public_inputs_bytes(&env);
        let result = client.try_verify_proof(&public_inputs, &proof);
        assert!(result.is_err());
    }

    // ──────────────────────────────────────────────
    //  Circuit Versioning
    // ──────────────────────────────────────────────

    #[test]
    fn test_get_current_version_defaults_to_one() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let version = client.get_current_version();
        assert_eq!(version, 1u32);
    }

    #[test]
    fn test_vk_bytes_for_version_returns_v1_after_init() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk.clone(),));
        let client = VerifierContractClient::new(&env, &contract_id);

        // Version 1 should be available after initialization
        let retrieved_vk = client.vk_bytes_for_version(&1u32);
        assert_eq!(retrieved_vk, vk);
    }

    #[test]
    fn test_vk_bytes_for_version_returns_none_for_unregistered_version() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        // Version 2 hasn't been registered yet
        let result = client.try_vk_bytes_for_version(&2u32);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VersionNotSupported
        );
    }

    #[test]
    fn test_set_vk_for_version_registers_new_version() {
        let env = Env::default();
        env.mock_all_auths();
        let vk_v1 = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk_v1.clone(),));
        let client = VerifierContractClient::new(&env, &contract_id);

        // Version 1 exists
        assert_eq!(client.vk_bytes_for_version(&1u32), vk_v1);

        // Version 2 doesn't exist yet
        assert!(client.try_vk_bytes_for_version(&2u32).is_err());

        // Register version 2 with a dummy VK (would be a valid circuit VK in practice)
        // For testing purposes, we'll use a modified version of the v1 VK
        // (In reality, this would be a different circuit's VK)
        let vk_v2 = vk_v1.clone();
        client.set_vk_for_version(&2u32, &vk_v2);

        // Version 2 should now be available
        let retrieved = client.vk_bytes_for_version(&2u32);
        assert_eq!(retrieved, vk_v2);

        // Version 1 should still exist
        assert_eq!(client.vk_bytes_for_version(&1u32), vk_v1);
    }

    #[test]
    fn test_verify_proof_for_version_uses_specified_vk() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = proof_bytes(&env);
        let public_inputs = public_inputs_bytes(&env);

        // Should verify successfully with version 1
        client.verify_proof_for_version(&1u32, &public_inputs, &proof);
    }

    #[test]
    fn test_verify_proof_for_version_fails_for_unsupported_version() {
        let env = Env::default();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);
        let public_inputs = public_inputs_bytes(&env);

        // Version 99 was never registered
        let result = client.try_verify_proof_for_version(&99u32, &public_inputs, &proof);
        assert_eq!(
            result.err().unwrap().unwrap(),
            VerifierError::VersionNotSupported
        );
    }

    #[test]
    fn test_legacy_verify_proof_still_works() {
        // Backward compatibility: old code calling verify_proof (without version)
        // should still work against the legacy VK
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk,));
        let client = VerifierContractClient::new(&env, &contract_id);

        let proof = proof_bytes(&env);
        let public_inputs = public_inputs_bytes(&env);
        client.verify_proof(&public_inputs, &proof);
    }

    #[test]
    fn test_multiple_versions_coexist() {
        // Tests that multiple versions can be registered and queried independently
        let env = Env::default();
        env.mock_all_auths();
        let vk = vk_bytes(&env);
        let contract_id: Address = env.register(VerifierContract, (vk.clone(),));
        let client = VerifierContractClient::new(&env, &contract_id);

        // Register versions 1, 2, and 3
        let vk_v1 = vk.clone();
        let vk_v2 = vk.clone(); // In reality, different VKs
        let vk_v3 = vk.clone();

        client.set_vk_for_version(&2u32, &vk_v2);
        client.set_vk_for_version(&3u32, &vk_v3);

        // All should be independently retrievable
        assert_eq!(client.vk_bytes_for_version(&1u32), vk_v1);
        assert_eq!(client.vk_bytes_for_version(&2u32), vk_v2);
        assert_eq!(client.vk_bytes_for_version(&3u32), vk_v3);

        // Current version should still report 1 (initialized version)
        assert_eq!(client.get_current_version(), 1u32);
    }
}