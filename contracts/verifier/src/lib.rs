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
}

#[contractimpl]
impl VerifierContract {
    fn key_vk() -> Symbol {
        symbol_short!("vk")
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
        Ok(())
    }

    pub fn vk_bytes(env: Env) -> Result<Bytes, VerifierError> {
        env.storage()
            .instance()
            .get(&Self::key_vk())
            .ok_or(VerifierError::VkNotSet)
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
}
