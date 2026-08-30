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
    InvalidAmount = 15,
    Paused = 16,
    NotAuthorized = 17,
    InvalidFee = 18,
    DexRouterNotSet = 19,
    FeeSwapFailed = 20,
    AssetNotSupported = 21,
    AssetMismatch = 22,
    UnsupportedAsset = 23,
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

#[contractevent(topics = ["asset_added"])]
pub struct AssetAddedEvent<'a> {
    pub asset: &'a Address,
    pub added_by: &'a Address,
}

#[contractevent(topics = ["asset_removed"])]
pub struct AssetRemovedEvent<'a> {
    pub asset: &'a Address,
    pub removed_by: &'a Address,
}

#[contractevent(topics = ["dex_router_updated"])]
pub struct DexRouterUpdatedEvent<'a> {
    pub new_router: &'a Address,
    pub updated_by: &'a Address,
}

/// Emitted whenever a withdrawal carves a relayer fee out of the payout and
/// swaps it for the fee asset, so off-chain observers (and the frontend) can
/// audit what a relayer actually charged versus what it quoted.
#[contractevent(topics = ["fee_swapped"], data_format = "map")]
pub struct FeeSwappedEvent<'a> {
    pub fee_amount_in: &'a i128,
    pub fee_amount_out: &'a i128,
    pub fee_recipient: &'a Address,
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
/// Membership marker for an allow-listed asset: `(prefix, asset_address) ->
/// ()`. Presence means the asset can be deposited and withdrawn.
fn key_asset_prefix() -> Symbol {
    symbol_short!("asset")
}
/// The allow-listed assets in registration order, for enumeration
/// (`get_assets`). The membership markers above are the source of truth for
/// per-call checks; this list mirrors them for read-only listing.
fn key_asset_list() -> Symbol {
    symbol_short!("assetl")
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
fn key_dex_router() -> Symbol {
    symbol_short!("dexrtr")
}
fn key_fee_asset() -> Symbol {
    symbol_short!("feeast")
}
fn key_max_fee_bps() -> Symbol {
    symbol_short!("maxfee")
}

const TREE_DEPTH: u32 = 20;
// The withdrawal circuit exposes six field elements; see parse_public_inputs.
const PUBLIC_INPUT_BYTES: u32 = 6 * 32;
// Largest value a single note may carry. The circuit range-constrains note
// values to 64 bits so the `withdraw + change == amount` arithmetic cannot wrap
// the BN254 field, and the contract refuses to create notes it could not later
// pay out.
const MAX_NOTE_AMOUNT: i128 = u64::MAX as i128;
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

// Hard ceiling on the relayer fee a withdrawal can carve out of the payout,
// expressed in basis points of `withdraw_amount`. This bounds the damage an
// untrustworthy relayer can do by overstating its fee: even if it sets
// `max_fee_bps` (admin-configurable, see set_max_fee_bps) to the ceiling and
// then charges the maximum every time, a user never loses more than 5% of a
// withdrawal to fee abstraction. The circuit does not know about fees at all
// -- this is a contract-only carve-out of the already-proof-committed
// `withdraw_amount` (see docs/THREAT_MODEL.md).
const MAX_FEE_BPS_CEILING: u32 = 500; // 5%
const BPS_DENOMINATOR: i128 = 10_000;

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

/// The six field elements the withdrawal circuit exposes, in declaration
/// order: `root`, `nullifier_hash`, `recipient`, `withdraw_amount`,
/// `change_commitment`, `asset` (see circuits/shielded_pool/src/main.nr).
///
/// `asset` is the field element the spent note's leaf commits to. The contract
/// recomputes the same field from the payout token's address
/// (`asset_id_from_address`) and rejects the withdrawal unless they match, so a
/// proof built for one asset cannot pull a different asset out of the pool.
struct WithdrawInputs {
    root: [u8; 32],
    nullifier_hash: [u8; 32],
    recipient_hash: [u8; 32],
    withdraw_amount: [u8; 32],
    change_commitment: [u8; 32],
    asset: [u8; 32],
}

fn parse_public_inputs(bytes: &Bytes) -> Result<WithdrawInputs, PoolError> {
    if bytes.len() != PUBLIC_INPUT_BYTES {
        return Err(PoolError::InvalidPublicInputs);
    }
    let mut buf = [0u8; PUBLIC_INPUT_BYTES as usize];
    bytes.copy_into_slice(&mut buf);
    let field = |i: usize| {
        let mut out = [0u8; 32];
        out.copy_from_slice(&buf[i * 32..(i + 1) * 32]);
        out
    };
    Ok(WithdrawInputs {
        root: field(0),
        nullifier_hash: field(1),
        recipient_hash: field(2),
        withdraw_amount: field(3),
        change_commitment: field(4),
        asset: field(5),
    })
}

/// Reads a public-input field element as a token amount.
///
/// The circuit range-constrains both the note value and the payout to 64 bits
/// (`constrain_u64`), so anything with a byte set above that range did not come
/// from an honest proof and is rejected rather than silently truncated.
fn amount_from_field(bytes: &[u8; 32]) -> Result<i128, PoolError> {
    let (high, low) = bytes.split_at(24);
    for b in high {
        if *b != 0 {
            return Err(PoolError::InvalidPublicInputs);
        }
    }
    let mut value: u64 = 0;
    for b in low {
        value = (value << 8) | (*b as u64);
    }
    Ok(value as i128)
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

/// Derives the field element a note commits to for `asset`, from the SEP-41
/// token's contract address. This MUST match the frontend's `assetToField` and
/// the circuit's `asset` public input: it takes the token's 32-byte contract
/// id, reduces it modulo the BN254 scalar field, and returns the 32-byte
/// big-endian encoding. Binding the withdrawal proof's `asset` public input to
/// this value is what stops a proof for one asset from paying out another. Only
/// contract (C...) addresses are supported, since SEP-41 assets are contracts.
fn asset_id_from_address(env: &Env, asset: &Address) -> Result<BytesN<32>, PoolError> {
    let payload = asset.to_payload().ok_or(PoolError::UnsupportedAsset)?;
    let hash = match payload {
        AddressPayload::ContractIdHash(h) => h,
        _ => return Err(PoolError::UnsupportedAsset),
    };
    let modulus = <BnScalar as Field>::modulus(env);
    let bytes = Bytes::from_array(env, &hash.to_array());
    let reduced = U256::from_be_bytes(env, &bytes).rem_euclid(&modulus);
    let out_bytes = reduced.to_be_bytes();
    let mut out = [0u8; 32];
    out_bytes.copy_into_slice(&mut out);
    Ok(BytesN::from_array(env, &out))
}

/// True if `asset` is on the admin-managed allow-list of assets this pool
/// accepts. Deposits and withdrawals of any other asset are rejected.
fn is_asset_supported(env: &Env, asset: &Address) -> bool {
    let key = (key_asset_prefix(), asset.clone());
    env.storage().instance().has(&key)
}

fn require_asset_supported(env: &Env, asset: &Address) -> Result<(), PoolError> {
    if is_asset_supported(env, asset) {
        Ok(())
    } else {
        Err(PoolError::AssetNotSupported)
    }
}

/// Adds `asset` to the allow-list if not already present. Records both the
/// O(1) membership marker and the enumeration list.
fn register_asset(env: &Env, asset: &Address) {
    let key = (key_asset_prefix(), asset.clone());
    if env.storage().instance().has(&key) {
        return;
    }
    env.storage().instance().set(&key, &());
    let mut list: SorobanVec<Address> = env
        .storage()
        .instance()
        .get(&key_asset_list())
        .unwrap_or_else(|| SorobanVec::new(env));
    list.push_back(asset.clone());
    env.storage().instance().set(&key_asset_list(), &list);
}

/// Swaps `amount_in` of the pool's token for the configured fee asset (e.g.
/// native XLM) via a Soroswap-router-compatible contract, sending the output
/// straight to `fee_recipient`. This is how a relayer recovers its Soroban
/// resource-fee cost without the withdrawing user ever needing to hold the
/// fee asset themselves.
///
/// The router call follows Soroswap's `swap_exact_tokens_for_tokens` shape:
/// `(amount_in, amount_out_min, path, to, deadline)`, plus the pool's own
/// address so the router knows who approved it (Soroban has no implicit
/// caller identity to pull from). `amount_out_min` is the caller-supplied
/// slippage floor -- the relayer's own quote from
/// `frontend/src/lib/stellar.ts`, echoed back here so the swap can't be
/// sandwiched into a worse rate than what the user was shown before signing.
/// A swap path must exist and have liquidity for this to succeed; see the
/// DEX-path liveness assumption in docs/THREAT_MODEL.md.
fn swap_fee_for_asset(
    env: &Env,
    token_in: &Address,
    amount_in: i128,
    amount_out_min: i128,
    fee_recipient: &Address,
) -> Result<i128, PoolError> {
    let router: Address = env
        .storage()
        .instance()
        .get(&key_dex_router())
        .ok_or(PoolError::DexRouterNotSet)?;
    let fee_asset: Address = env
        .storage()
        .instance()
        .get(&key_fee_asset())
        .ok_or(PoolError::DexRouterNotSet)?;

    // The router pulls `amount_in` from the pool via `transfer_from`, so the
    // pool must approve it first. A short-lived, exact-amount approval (one
    // ledger past the swap deadline) rather than an open-ended allowance,
    // so a router bug or malicious router can never pull more than this one
    // fee slice, now or later.
    let contract_addr = env.current_contract_address();
    let expiration_ledger = env.ledger().sequence().saturating_add(1);
    token::Client::new(env, token_in).approve(
        &contract_addr,
        &router,
        &amount_in,
        &expiration_ledger,
    );

    let mut path: SorobanVec<Address> = SorobanVec::new(env);
    path.push_back(token_in.clone());
    path.push_back(fee_asset);

    let deadline: u64 = env.ledger().timestamp().saturating_add(300);

    // Soroban has no implicit "msg.sender": since the router pulls the input
    // asset via `transfer_from`, it needs the source address explicitly
    // rather than inferring it from the invoking contract. We pass the pool's
    // own address as the sixth argument; the pool already approved the router
    // for exactly `amount_in` above, so this cannot be used to pull more than
    // that one fee slice.
    let mut args: SorobanVec<Val> = SorobanVec::new(env);
    args.push_back(amount_in.into_val(env));
    args.push_back(amount_out_min.into_val(env));
    args.push_back(path.into_val(env));
    args.push_back(fee_recipient.into_val(env));
    args.push_back(deadline.into_val(env));
    args.push_back(contract_addr.into_val(env));

    let amounts: SorobanVec<i128> = env
        .try_invoke_contract::<SorobanVec<i128>, InvokeError>(
            &router,
            &Symbol::new(env, "swap_exact_tokens_for_tokens"),
            args,
        )
        .map_err(|_| PoolError::FeeSwapFailed)?
        .map_err(|_| PoolError::FeeSwapFailed)?;

    amounts.last().ok_or(PoolError::FeeSwapFailed)
}

/// Notes carry their own value, so any positive amount up to the circuit's
/// 64-bit range is a valid deposit. Rejecting oversized amounts here keeps
/// on-chain state within what a proof can ever spend: a note worth more than
/// `MAX_NOTE_AMOUNT` could be deposited but never withdrawn.
fn check_amount(amount: i128) -> Result<(), PoolError> {
    if amount <= 0 || amount > MAX_NOTE_AMOUNT {
        return Err(PoolError::InvalidAmount);
    }
    Ok(())
}

/// Persists a single commitment: records the leaf index it was inserted at
/// (keyed both ways, so clients can rebuild the tree and look a commitment's
/// index back up), and emits the deposit event.
///
/// Change notes minted by `withdraw` go through this same path and emit the
/// same event as a deposit, so a re-shielded remainder is indistinguishable
/// from someone shielding fresh funds.
fn record_commitment(env: &Env, idx: u32, commitment: &BytesN<32>) {
    let cm_key = (key_commitment_prefix(), commitment.clone());
    env.storage().persistent().set(&cm_key, &idx);
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
    /// A pool holds notes of arbitrary value, so it takes no denomination:
    /// one pool serves every amount, which is also what gives every user the
    /// same anonymity set instead of splitting it across tiers.
    ///
    /// `token` seeds the asset allow-list with the pool's first supported
    /// asset. The admin can allow-list further SEP-41 assets later with
    /// `add_asset`, and a single pool instance then holds shielded notes for
    /// every allow-listed asset over one shared tree and nullifier set — the
    /// anonymity set is shared across assets rather than fragmented into a
    /// separate pool per asset.
    pub fn __constructor(
        env: Env,
        verifier: Address,
        token: Address,
        admin: Address,
    ) -> Result<(), PoolError> {
        if env.storage().instance().has(&key_verifier()) {
            return Err(PoolError::AlreadyInitialized);
        }
        env.storage().instance().set(&key_verifier(), &verifier);
        env.storage().instance().set(&key_admin(), &admin);
        register_asset(&env, &token);
        Ok(())
    }

    /// Admin-gated: allow-lists another SEP-41 asset so the pool can shield it
    /// alongside the assets it already holds, sharing the same tree and
    /// nullifier set. Idempotent — re-adding a supported asset is a no-op.
    pub fn add_asset(env: Env, asset: Address) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);
        // Reject an address that has no valid note asset field (e.g. a G...
        // account), so a later deposit can't be allow-listed against something
        // no proof could ever bind to.
        asset_id_from_address(&env, &asset)?;
        register_asset(&env, &asset);
        AssetAddedEvent {
            asset: &asset,
            added_by: &admin,
        }
        .publish(&env);
        Ok(())
    }

    /// Admin-gated: removes `asset` from the allow-list, blocking new deposits
    /// and withdrawals of it. Notes already shielded in the tree are unaffected
    /// as commitments, but become unspendable until the asset is re-added — the
    /// funds are not lost, only frozen behind the allow-list.
    pub fn remove_asset(env: Env, asset: Address) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);

        let key = (key_asset_prefix(), asset.clone());
        if !env.storage().instance().has(&key) {
            return Err(PoolError::AssetNotSupported);
        }
        env.storage().instance().remove(&key);
        let list: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&key_asset_list())
            .unwrap_or_else(|| SorobanVec::new(&env));
        let mut next: SorobanVec<Address> = SorobanVec::new(&env);
        for a in list.iter() {
            if a != asset {
                next.push_back(a);
            }
        }
        env.storage().instance().set(&key_asset_list(), &next);

        AssetRemovedEvent {
            asset: &asset,
            removed_by: &admin,
        }
        .publish(&env);
        Ok(())
    }

    /// True if `asset` is currently on the allow-list.
    pub fn is_asset_supported(env: Env, asset: Address) -> bool {
        is_asset_supported(&env, &asset)
    }

    /// Every allow-listed asset, in registration order.
    pub fn get_assets(env: Env) -> soroban_sdk::Vec<Address> {
        env.storage()
            .instance()
            .get(&key_asset_list())
            .unwrap_or_else(|| SorobanVec::new(&env))
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

    /// Shields `amount` of `asset` behind `commitment`, which must be
    /// `H(H(H(H(LEAF_DOMAIN, nullifier), secret), amount), asset_field)` for the
    /// same `amount` and for `asset_field = asset_id_from_address(asset)` -- the
    /// contract cannot check that (the commitment is opaque to it), but a note
    /// whose committed value or asset disagrees with what was transferred simply
    /// cannot be withdrawn, since the circuit recomputes the leaf from both the
    /// value it pays out and the asset the pool is asked to pay it in. `asset`
    /// must be on the allow-list; the transferred asset and the one bound into
    /// the commitment are the same for exactly this reason.
    /// Admin-gated: configures the Soroswap-compatible router and the fee
    /// asset (e.g. the native XLM SAC) that withdrawal fees are swapped into.
    /// Both must be set before `withdraw` can be called with a nonzero fee.
    pub fn set_dex_router(
        env: Env,
        router: Address,
        fee_asset: Address,
    ) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);

        env.storage().instance().set(&key_dex_router(), &router);
        env.storage().instance().set(&key_fee_asset(), &fee_asset);

        DexRouterUpdatedEvent {
            new_router: &router,
            updated_by: &admin,
        }
        .publish(&env);

        Ok(())
    }

    /// Admin-gated: caps the fee a withdrawal may carve out of the payout, in
    /// basis points of `withdraw_amount`. Capped at `MAX_FEE_BPS_CEILING`
    /// regardless of what the admin sets, so a compromised admin key cannot
    /// turn fee abstraction into an unbounded drain.
    pub fn set_max_fee_bps(env: Env, max_fee_bps: u32) -> Result<(), PoolError> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&key_admin())
            .ok_or(PoolError::NotAuthorized)?;
        admin.require_auth();
        bump_instance(&env);

        if max_fee_bps > MAX_FEE_BPS_CEILING {
            return Err(PoolError::InvalidFee);
        }
        env.storage().instance().set(&key_max_fee_bps(), &max_fee_bps);
        Ok(())
    }

    pub fn get_max_fee_bps(env: Env) -> u32 {
        env.storage().instance().get(&key_max_fee_bps()).unwrap_or(0)
    }

    pub fn get_dex_router(env: Env) -> Option<Address> {
        env.storage().instance().get(&key_dex_router())
    }

    /// Shields `amount` behind `commitment`, which must be
    /// `H(H(H(LEAF_DOMAIN, nullifier), secret), amount)` for the same `amount`
    /// -- the contract cannot check that (the commitment is opaque to it), but
    /// a note whose committed value disagrees with what was transferred simply
    /// cannot be withdrawn, since the circuit recomputes the leaf from the
    /// value it pays out.
    pub fn deposit(
        env: Env,
        depositor: Address,
        asset: Address,
        commitment: BytesN<32>,
        amount: i128,
    ) -> Result<u32, PoolError> {
        depositor.require_auth();
        check_amount(amount)?;
        require_asset_supported(&env, &asset)?;
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

        let contract_addr = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&depositor, &contract_addr, &amount);

        let idx = next_index;
        let zeroes = zeroes_for_tree(&env);
        record_commitment(&env, idx, &commitment);
        let root = insert_commitment(&env, &zeroes, idx, &commitment);
        commit_root(&env, &root);

        next_index = next_index.saturating_add(1);
        env.storage().instance().set(&key_next_index(), &next_index);

        Ok(idx)
    }

    /// Deposit several notes of the same `asset` in a single transaction (one
    /// signature, one token transfer of the summed value). `amounts[i]` is the
    /// value shielded behind `commitments[i]`; the two vectors must be the same
    /// length. To shield more than one asset, call this once per asset. Each
    /// commitment is inserted at the next sequential leaf index exactly as
    /// repeated `deposit` calls would, so the resulting root and per-leaf
    /// indices are identical — clients can rebuild the tree the same way.
    /// Returns the leaf index assigned to the first commitment; the rest follow
    /// consecutively.
    ///
    /// Splitting one shielded balance across several differently-sized notes is
    /// the main reason to use this: it lets a later spend pay out a figure that
    /// never appeared as a deposit.
    ///
    /// The whole batch is atomic: any duplicate commitment (within the batch or
    /// already stored), an invalid amount, or a full tree reverts the entire
    /// transaction, so no partial deposit or partial transfer can occur.
    pub fn deposit_batch(
        env: Env,
        depositor: Address,
        asset: Address,
        commitments: soroban_sdk::Vec<BytesN<32>>,
        amounts: soroban_sdk::Vec<i128>,
    ) -> Result<u32, PoolError> {
        depositor.require_auth();
        require_asset_supported(&env, &asset)?;
        if Self::is_paused(env.clone()) {
            return Err(PoolError::Paused);
        }
        bump_instance(&env);

        let count = commitments.len();
        if count == 0 || amounts.len() != count {
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

        let mut total: i128 = 0;
        for amount in amounts.iter() {
            check_amount(amount)?;
            total = total.checked_add(amount).ok_or(PoolError::AmountOverflow)?;
        }
        let contract_addr = env.current_contract_address();
        token::Client::new(&env, &asset).transfer(&depositor, &contract_addr, &total);

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

    /// Spends one note: pays out the amount the proof commits to and
    /// re-shields the remainder as a fresh leaf.
    ///
    /// Every spend inserts exactly one change commitment, even when the payout
    /// consumes the whole note and the remainder is zero. That uniformity is
    /// the point: on-chain, "withdrew everything" and "withdrew a slice" are
    /// the same shape — one nullifier retired, one leaf appended — so nothing
    /// in the transaction reveals whether the spender still holds value, and a
    /// user can keep spending slices of a balance indefinitely.
    ///
    /// Returns the leaf index the change note landed on.
    ///
    /// `fee_amount` lets a relayer recover its Soroban resource-fee cost
    /// without the withdrawing user ever needing to hold XLM: it is carved out
    /// of the proof-committed `withdraw_amount` (never added on top of it),
    /// capped by `max_fee_bps` (see `set_max_fee_bps`), and swapped through
    /// the configured DEX router into the fee asset, sent to `fee_recipient`.
    /// `fee_min_out` is the relayer's own quote (from the frontend's
    /// conversion-rate helper) echoed back as a slippage floor, so the on-chain
    /// swap can't clear at a worse rate than what the user was shown before
    /// signing. Pass `fee_amount = 0` (and any `fee_recipient`) to withdraw
    /// exactly as before, with no fee carved out.
    pub fn withdraw(
        env: Env,
        recipient: Address,
        asset: Address,
        public_inputs: Bytes,
        proof_bytes: Bytes,
        fee_amount: i128,
        fee_min_out: i128,
        fee_recipient: Address,
    ) -> Result<u32, PoolError> {
        if proof_bytes.len() as usize != PROOF_BYTES {
            return Err(PoolError::VerificationFailed);
        }
        require_asset_supported(&env, &asset)?;
        if Self::is_paused(env.clone()) {
            return Err(PoolError::Paused);
        }
        bump_instance(&env);

        let inputs = parse_public_inputs(&public_inputs)?;
        let nf_from_proof = BytesN::from_array(&env, &inputs.nullifier_hash);
        let recipient_from_proof = BytesN::from_array(&env, &inputs.recipient_hash);
        let change_commitment = BytesN::from_array(&env, &inputs.change_commitment);
        let asset_from_proof = BytesN::from_array(&env, &inputs.asset);
        let payout = amount_from_field(&inputs.withdraw_amount)?;

        // Bind the proof to the asset being paid out. The spent note's leaf
        // commits to an asset field; if the caller names a different asset than
        // the one the proof was generated for, the recomputed field will not
        // match and the withdrawal is rejected. This is what enforces, in the
        // circuit-checked leaf rather than in bookkeeping, that a proof for
        // asset A cannot withdraw asset B.
        let expected_asset = asset_id_from_address(&env, &asset)?;
        if expected_asset != asset_from_proof {
            return Err(PoolError::AssetMismatch);
        }

        // Validate the fee carve-out before any state changes or the (expensive)
        // proof verification, so a malformed or over-cap fee fails cheaply.
        // `fee_amount` never adds to what the note pays out -- it is a slice of
        // `payout` redirected to the relayer, capped independently of what the
        // relayer claims so an overcharging relayer is bounded by MAX_FEE_BPS_CEILING
        // (via `max_fee_bps`), not by its own say-so.
        if fee_amount < 0 || fee_min_out < 0 {
            return Err(PoolError::InvalidFee);
        }
        if fee_amount > payout {
            return Err(PoolError::InvalidFee);
        }
        if fee_amount > 0 {
            let max_fee_bps: u32 = env
                .storage()
                .instance()
                .get(&key_max_fee_bps())
                .unwrap_or(0);
            let cap = payout
                .saturating_mul(max_fee_bps as i128)
                .checked_div(BPS_DENOMINATOR)
                .unwrap_or(0);
            if fee_amount > cap {
                return Err(PoolError::InvalidFee);
            }
        }

        let nf_key = (key_nullifier_prefix(), nf_from_proof.clone());
        if env.storage().persistent().has(&nf_key) {
            return Err(PoolError::NullifierUsed);
        }

        let root_from_proof = BytesN::from_array(&env, &inputs.root);
        if !env.storage().instance().has(&key_root()) {
            return Err(PoolError::RootNotSet);
        }

        if !root_is_known(&env, &root_from_proof) {
            return Err(PoolError::RootMismatch);
        }

        // The change note takes a leaf slot, so the same capacity and
        // uniqueness rules that guard `deposit` apply here too. Checked before
        // the (expensive) proof verification so a doomed spend fails cheaply.
        let cm_key = (key_commitment_prefix(), change_commitment.clone());
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

        // Mark the nullifier used and insert the change note BEFORE the token
        // transfer (checks-effects-interactions). The deployed token is the
        // trusted Stellar Asset Contract with no transfer hooks, but this
        // ordering means even a token with callback behavior can't re-enter
        // withdraw and replay this proof before it's recorded as spent.
        env.storage().persistent().set(&nf_key, &true);
        bump_persistent(&env, &nf_key);

        let change_index = next_index;
        let zeroes = zeroes_for_tree(&env);
        record_commitment(&env, change_index, &change_commitment);
        let root = insert_commitment(&env, &zeroes, change_index, &change_commitment);
        commit_root(&env, &root);
        next_index = next_index.saturating_add(1);
        env.storage().instance().set(&key_next_index(), &next_index);

        // A zero payout is legitimate: it re-keys a note without paying anything
        // out, which is how a user consolidates or refreshes shielded value. The
        // SAC rejects a zero-value transfer, so skip the call in that case.
        if payout > 0 {
            let recipient_amount = payout - fee_amount;
            if recipient_amount > 0 {
                token::Client::new(&env, &asset).transfer(
                    &env.current_contract_address(),
                    &recipient,
                    &recipient_amount,
                );
            }

            // Swap the carved-out fee slice for the fee asset (e.g. XLM) and send
            // it straight to the relayer, so the user's withdrawal never required
            // them to hold or spend the fee asset themselves. The pool holds the
            // full `payout` at this point (transferred in at deposit time), so it
            // can fund the swap directly rather than routing it through the
            // recipient first.
            if fee_amount > 0 {
                let fee_amount_out = swap_fee_for_asset(
                    &env,
                    &asset,
                    fee_amount,
                    fee_min_out,
                    &fee_recipient,
                )?;
                FeeSwappedEvent {
                    fee_amount_in: &fee_amount,
                    fee_amount_out: &fee_amount_out,
                    fee_recipient: &fee_recipient,
                }
                .publish(&env);
            }
        }

        WithdrawEvent {
            nullifier_hash: &nf_from_proof,
        }
        .publish(&env);

        Ok(change_index)
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
    /// caller claims actually belongs to this pool.
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

    /// Returns the leaf index `commitment` was inserted at, if the pool holds
    /// it. Lets a client find where its note landed without scanning the whole
    /// tree -- in particular the change note minted by `withdraw`, whose index
    /// the spender needs in order to prove membership on the next spend and
    /// cannot predict in advance (another transaction may take the slot first).
    pub fn get_commitment_index(env: Env, commitment: BytesN<32>) -> Option<u32> {
        let cm_key = (key_commitment_prefix(), commitment);
        env.storage().persistent().get(&cm_key)
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

}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{
        testutils::{Address as TestAddress, Events, MuxedAddress as TestMuxedAddress},
        token::StellarAssetClient,
        token::TokenClient,
        Address, Env, Event,
    };

    /// Stand-in note value for tests that only care about tree/nullifier
    /// mechanics. The pool no longer has a denomination, so every deposit has
    /// to name its own amount; tests that exercise varying values set their own.
    const NOTE_AMOUNT: i128 = 10_000_000;

    /// `NOTE_AMOUNT` repeated once per commitment, for batches where the split
    /// across notes isn't what's under test.
    fn equal_amounts(env: &Env, count: u32) -> SorobanVec<i128> {
        let mut amounts = SorobanVec::new(env);
        for _ in 0..count {
            amounts.push_back(NOTE_AMOUNT);
        }
        amounts
    }

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

    // H(1234, 0) -- the raw two-input primitive on a non-zero input, which
    // pins the field encoding in a way H(0,0) alone cannot. Not to be confused
    // with a note's nullifier hash, which is the domain-separated
    // H(H(NULLIFIER_DOMAIN, nullifier), 0) built on top of this primitive.
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for seed in 1u8..=8 {
            client.deposit(&depositor, &token_addr, &dummy_commitment(&env, seed), &NOTE_AMOUNT);
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
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), admin.clone()),
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
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), admin.clone()),
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        assert_eq!(client.get_next_index(), 0);

        let c1 = dummy_commitment(&env, 1);
        let idx = client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
        assert_eq!(idx, 0);
        assert_eq!(client.get_next_index(), 1);
    }

    #[test]
    fn test_deposit_sets_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        assert!(client.get_root().is_none());

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

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
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
        let balance_after = token.balance(&depositor);

        assert_eq!(balance_before - balance_after, 10_000_000);
        assert_eq!(token.balance(&pool_id), 10_000_000);
    }

    #[test]
    fn test_deposit_sequential_indices() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for i in 0u8..5 {
            let c = dummy_commitment(&env, i + 1);
            let idx = client.deposit(&depositor, &token_addr, &c, &NOTE_AMOUNT);
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
            client.deposit(&depositor, &token_addr, &c, &NOTE_AMOUNT);
        }

        assert_eq!(token.balance(&pool_id), 10_000_000 * 4);
    }

    #[test]
    fn test_deposit_does_not_panic() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        let idx = client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c0 = dummy_commitment(&env, 7);
        let c1 = dummy_commitment(&env, 9);
        client.deposit(&depositor, &token_addr, &c0, &NOTE_AMOUNT);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        assert_eq!(client.get_commitment(&0), Some(c0));
        assert_eq!(client.get_commitment(&1), Some(c1));
        assert_eq!(client.get_commitment(&2), None);
    }

    #[test]
    fn test_get_commitments_returns_all_in_order() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commits = [
            dummy_commitment(&env, 1),
            dummy_commitment(&env, 2),
            dummy_commitment(&env, 3),
        ];
        for c in commits.iter() {
            client.deposit(&depositor, &token_addr, c, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commits: Vec<BytesN<32>> = (1u8..=7)
            .map(|seed| dummy_commitment(&env, seed))
            .collect();
        for c in commits.iter() {
            client.deposit(&depositor, &token_addr, c, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 2), &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commits: Vec<BytesN<32>> = (1u8..=5)
            .map(|seed| dummy_commitment(&env, seed))
            .collect();
        for c in commits.iter() {
            client.deposit(&depositor, &token_addr, c, &NOTE_AMOUNT);
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
        let (seq_pool, seq_dep, seq_token) = setup_with_token(&seq_env);
        let seq = PoolContractClient::new(&seq_env, &seq_pool);
        for seed in 1u8..=7 {
            seq.deposit(&seq_dep, &seq_token, &dummy_commitment(&seq_env, seed), &NOTE_AMOUNT);
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
        let first_index = batch.deposit_batch(&batch_dep, &batch_token, &commitments, &equal_amounts(&batch_env, commitments.len()));

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

        let result = client.try_deposit_batch(&depositor, &token_addr, &commitments, &equal_amounts(&env, commitments.len()));
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let commitments = SorobanVec::new(&env);
        let result = client.try_deposit_batch(&depositor, &token_addr, &commitments, &equal_amounts(&env, commitments.len()));
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

        let result = client.try_deposit_batch(&depositor, &token_addr, &commitments, &equal_amounts(&env, commitments.len()));
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let mut commitments = SorobanVec::new(&env);
        for seed in 0..MAX_BATCH_SIZE {
            commitments.push_back(dummy_commitment(&env, seed as u8));
        }

        let first_index = client.deposit_batch(&depositor, &token_addr, &commitments, &equal_amounts(&env, commitments.len()));
        assert_eq!(first_index, 0);
        assert_eq!(client.get_next_index(), MAX_BATCH_SIZE);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        for seed in 1u8..=5 {
            client.deposit(&depositor, &token_addr, &dummy_commitment(&env, seed), &NOTE_AMOUNT);
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

        let idx1 = client.deposit(&d1, &token_addr, &c1, &NOTE_AMOUNT);
        let idx2 = client.deposit(&d2, &token_addr, &c2, &NOTE_AMOUNT);

        assert_eq!(idx1, 0);
        assert_eq!(idx2, 1);
        assert_eq!(token.balance(&pool_id), 20_000_000);
    }

    #[test]
    fn test_same_commitment_different_depositors_fails() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, d1, d2, token_addr) = setup_multi_depositor(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c = dummy_commitment(&env, 1);
        client.deposit(&d1, &token_addr, &c, &NOTE_AMOUNT);

        let result = client.try_deposit(&d2, &token_addr, &c, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let result = client.try_deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
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
            (verifier_id, token_id.address(), admin.clone()),
        );
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        let result = client.try_deposit(&depositor, &token_id.address(), &c1, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
        let root1 = client.get_root().unwrap();

        let c2 = dummy_commitment(&env, 2);
        client.deposit(&depositor, &token_addr, &c2, &NOTE_AMOUNT);
        let root2 = client.get_root().unwrap();

        assert_ne!(root1, root2);
    }

    #[test]
    fn test_same_commitment_sequence_produces_deterministic_root() {
        let env1 = Env::default();
        env1.mock_all_auths();
        env1.cost_estimate().budget().reset_unlimited();
        let (pool1, dep1, token1) = setup_with_token(&env1);
        let client1 = PoolContractClient::new(&env1, &pool1);

        let env2 = Env::default();
        env2.mock_all_auths();
        env2.cost_estimate().budget().reset_unlimited();
        let (pool2, dep2, token2) = setup_with_token(&env2);
        let client2 = PoolContractClient::new(&env2, &pool2);

        let c = dummy_commitment(&env1, 42);
        client1.deposit(&dep1, &token1, &c, &NOTE_AMOUNT);

        let c = dummy_commitment(&env2, 42);
        client2.deposit(&dep2, &token2, &c, &NOTE_AMOUNT);

        assert_eq!(client1.get_root().unwrap(), client2.get_root().unwrap());
    }

    #[test]
    fn test_root_changes_each_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let mut prev_root: Option<BytesN<32>> = None;
        for i in 1u8..=4 {
            let c = dummy_commitment(&env, i);
            client.deposit(&depositor, &token_addr, &c, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
        let root_after_first = client.get_root().unwrap();

        let c2 = dummy_commitment(&env, 2);
        client.deposit(&depositor, &token_addr, &c2, &NOTE_AMOUNT);
        let root_after_second = client.get_root().unwrap();
        assert_ne!(root_after_first, root_after_second);

        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[..32].copy_from_slice(&root_after_first.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let recipient = <Address as TestAddress>::generate(&env);
        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_ne!(result.err().unwrap().unwrap(), PoolError::RootMismatch);
    }

    #[test]
    fn test_current_root_accepted_for_withdraw() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
        let current_root = client.get_root().unwrap();

        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[..32].copy_from_slice(&current_root.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let recipient = <Address as TestAddress>::generate(&env);
        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, _, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let recipient = <Address as TestAddress>::generate(&env);
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::RootNotSet);
    }

    #[test]
    fn test_withdraw_wrong_proof_length() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let bad_proof = Bytes::from_slice(&env, &[0u8; 100]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &bad_proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let bad_inputs = Bytes::from_slice(&env, &[0u8; 32]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &bad_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let empty_inputs = Bytes::from_slice(&env, &[]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &empty_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let big_inputs = Bytes::from_slice(&env, &[0u8; 128]);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &big_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[0] = 0xFF;
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::RootMismatch);
    }

    #[test]
    fn test_withdraw_zero_length_proof() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c1 = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let empty_proof = Bytes::from_slice(&env, &[]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &empty_proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);

        // Valid root, but the recipient hash in the proof does NOT correspond to
        // `recipient` — simulating a front-runner swapping in their own address.
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[..32].copy_from_slice(&root.to_array());
        for b in pi[64..96].iter_mut() {
            *b = 0xAA;
        }
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
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
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&hash_a.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        // Submitted with B as the payout address: rejected before verification.
        let result = client.try_withdraw(&recipient_b, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient_b);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        // The hash the contract derives for this recipient — what a real proof
        // for this recipient would commit to.
        let correct = recipient_hash_from_address(&env, &recipient).unwrap();

        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&correct.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        // A generated test address is a contract (C...) address; withdrawals to
        // contracts aren't supported by the recipient-binding scheme.
        let recipient = <Address as TestAddress>::generate(&env);
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[..32].copy_from_slice(&root.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::UnsupportedRecipient
        );
    }

    // ──────────────────────────────────────────────
    //  Getters / constructor
    // ──────────────────────────────────────────────

    #[test]
    fn test_get_assets_includes_initial_token() {
        // `get_token` no longer exists -- the constructor's `token` argument
        // now seeds the asset allow-list instead of being the pool's sole
        // asset, so this checks the same fact (the pool knows about the
        // asset it was deployed with) through the current API.
        let env = Env::default();
        let (pool_id, _, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let assets = client.get_assets();
        assert_eq!(assets.len(), 1);
        assert_eq!(assets.get(0).unwrap(), token_addr);
    }

    // ──────────────────────────────────────────────
    //  Variable note values
    // ──────────────────────────────────────────────

    #[test]
    fn test_deposits_of_different_amounts_transfer_their_own_value() {
        // The whole point of dropping denominations: one pool, notes of any
        // size, each moving exactly what its depositor named.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);
        let before = token.balance(&depositor);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &1i128);
        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 2), &7_654_321i128);
        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 3), &100_000_000i128);

        let total = 1 + 7_654_321 + 100_000_000;
        assert_eq!(token.balance(&pool_id), total);
        assert_eq!(token.balance(&depositor), before - total);
        assert_eq!(client.get_next_index(), 3);
    }

    #[test]
    fn test_deposit_rejects_zero_and_negative_amounts() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);
        let before = token.balance(&depositor);

        let zero = client.try_deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &0i128);
        assert_eq!(zero.err().unwrap().unwrap(), PoolError::InvalidAmount);

        let negative = client.try_deposit(&depositor, &token_addr, &dummy_commitment(&env, 2), &-1i128);
        assert_eq!(negative.err().unwrap().unwrap(), PoolError::InvalidAmount);

        assert_eq!(client.get_next_index(), 0);
        assert_eq!(token.balance(&depositor), before);
    }

    #[test]
    fn test_deposit_rejects_amount_beyond_circuit_range() {
        // A note worth more than the circuit can range-constrain could be
        // deposited but never withdrawn, so the deposit is refused instead of
        // silently stranding the funds.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let result =
            client.try_deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &(MAX_NOTE_AMOUNT + 1));
        assert_eq!(result.err().unwrap().unwrap(), PoolError::InvalidAmount);
    }

    #[test]
    fn test_deposit_batch_transfers_the_sum_of_its_amounts() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);
        let before = token.balance(&depositor);

        let mut commitments = SorobanVec::new(&env);
        let mut amounts = SorobanVec::new(&env);
        for (seed, amount) in [(1u8, 500_000i128), (2, 1_500_000), (3, 42)] {
            commitments.push_back(dummy_commitment(&env, seed));
            amounts.push_back(amount);
        }

        let first = client.deposit_batch(&depositor, &token_addr, &commitments, &amounts);
        assert_eq!(first, 0);
        let total = 500_000 + 1_500_000 + 42;
        assert_eq!(token.balance(&pool_id), total);
        assert_eq!(token.balance(&depositor), before - total);
    }

    #[test]
    fn test_get_commitment_index_round_trips() {
        // How a client finds the change note a withdrawal minted: its leaf slot
        // isn't predictable, so it has to be looked up after the fact.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c0 = dummy_commitment(&env, 1);
        let c1 = dummy_commitment(&env, 2);
        client.deposit(&depositor, &token_addr, &c0, &NOTE_AMOUNT);
        client.deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);

        assert_eq!(client.get_commitment_index(&c0), Some(0));
        assert_eq!(client.get_commitment_index(&c1), Some(1));
        assert_eq!(client.get_commitment(&1), Some(c1));
        assert_eq!(client.get_commitment_index(&dummy_commitment(&env, 99)), None);
    }

    #[test]
    fn test_withdraw_rejects_change_commitment_that_already_exists() {
        // A spend appends its change note as a new leaf, so it is subject to the
        // same uniqueness rule as a deposit. Checked before proof verification,
        // which is why this reports the collision rather than the (inevitable)
        // verification failure against the dummy verifier.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let existing = dummy_commitment(&env, 1);
        client.deposit(&depositor, &token_addr, &existing, &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[..32].copy_from_slice(&client.get_root().unwrap().to_array());
        pi[128..160].copy_from_slice(&existing.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::CommitmentExists);
    }

    #[test]
    fn test_withdraw_rejects_out_of_range_payout() {
        // A payout field element outside the circuit's 64-bit range is rejected
        // outright rather than truncated into some unrelated amount.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);

        let recipient = <Address as TestAddress>::generate(&env);
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[..32].copy_from_slice(&client.get_root().unwrap().to_array());
        pi[96] = 0x01; // withdraw_amount well above 2^64
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::InvalidPublicInputs
        );
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
        let short = Bytes::from_slice(&Env::default(), &[0u8; (PUBLIC_INPUT_BYTES - 1) as usize]);
        let result = parse_public_inputs(&short);
        assert_eq!(result.err().unwrap(), PoolError::InvalidPublicInputs);

        let long = Bytes::from_slice(&Env::default(), &[0u8; (PUBLIC_INPUT_BYTES + 1) as usize]);
        let result = parse_public_inputs(&long);
        assert_eq!(result.err().unwrap(), PoolError::InvalidPublicInputs);

        // The old 96-byte layout (root, nullifier, recipient) is no longer a
        // valid length: a proof from the pre-change circuit can't be replayed
        // against this pool, which is what we want -- it would have no payout
        // amount or change commitment attached.
        let legacy = Bytes::from_slice(&Env::default(), &[0u8; 96]);
        assert_eq!(
            parse_public_inputs(&legacy).err().unwrap(),
            PoolError::InvalidPublicInputs
        );

        let mut arr = [0u8; PUBLIC_INPUT_BYTES as usize];
        arr[0] = 0xAA;
        arr[32] = 0xBB;
        arr[64] = 0xCC;
        arr[96] = 0xDD;
        arr[128] = 0xEE;
        let bytes = Bytes::from_slice(&Env::default(), &arr);
        let inputs = parse_public_inputs(&bytes).unwrap();
        assert_eq!(inputs.root[0], 0xAA);
        assert_eq!(inputs.nullifier_hash[0], 0xBB);
        assert_eq!(inputs.recipient_hash[0], 0xCC);
        assert_eq!(inputs.withdraw_amount[0], 0xDD);
        assert_eq!(inputs.change_commitment[0], 0xEE);
    }

    #[test]
    fn test_amount_from_field_decodes_low_64_bits() {
        let mut bytes = [0u8; 32];
        bytes[24..32].copy_from_slice(&1_234_567_890u64.to_be_bytes());
        assert_eq!(amount_from_field(&bytes).unwrap(), 1_234_567_890i128);

        let zero = [0u8; 32];
        assert_eq!(amount_from_field(&zero).unwrap(), 0i128);

        let mut max = [0u8; 32];
        max[24..32].copy_from_slice(&u64::MAX.to_be_bytes());
        assert_eq!(amount_from_field(&max).unwrap(), MAX_NOTE_AMOUNT);
    }

    #[test]
    fn test_amount_from_field_rejects_out_of_range() {
        // The circuit range-constrains payouts to 64 bits, so anything set
        // above that never came from an honest proof. Truncating instead of
        // rejecting would let a crafted field element pay out an amount
        // unrelated to the one the proof committed to.
        let mut just_over = [0u8; 32];
        just_over[23] = 0x01;
        assert_eq!(
            amount_from_field(&just_over).err().unwrap(),
            PoolError::InvalidPublicInputs
        );

        let mut top_byte = [0u8; 32];
        top_byte[0] = 0x01;
        assert_eq!(
            amount_from_field(&top_byte).err().unwrap(),
            PoolError::InvalidPublicInputs
        );
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let c = dummy_commitment(&env, 7);
        client.deposit(&depositor, &token_addr, &c, &NOTE_AMOUNT);

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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let recipient_hash = recipient_hash_from_address(&env, &recipient).unwrap();
        let nullifier = dummy_commitment(&env, 99);

        // Public inputs for a well-formed withdrawal: known root, this
        // nullifier, and the recipient hash this payout address really binds to.
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[..32].copy_from_slice(&root.to_array());
        pi[32..64].copy_from_slice(&nullifier.to_array());
        pi[64..96].copy_from_slice(&recipient_hash.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        // Before the spend, nothing rejects on the nullifier — the dummy proof
        // fails verification instead. This proves the NullifierUsed below comes
        // from the replay, not from some unrelated check.
        let first = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
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
        let replay = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();
        assert!(client.is_known_root(&root));
    }

    #[test]
    fn test_is_known_root_true_for_historical_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let old_root = client.get_root().unwrap();
        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 2), &NOTE_AMOUNT);

        assert!(client.is_known_root(&old_root));
    }

    #[test]
    fn test_is_known_root_false_for_unknown_root() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let bogus = BytesN::from_array(&env, &[0xEE; 32]);
        assert!(!client.is_known_root(&bogus));
    }

    // ──────────────────────────────────────────────
    //  Deposit batch: overflow
    // ──────────────────────────────────────────────

    #[test]
    fn test_deposit_batch_rejects_oversized_amount() {
        // The per-note cap is what keeps a batch total in range: with every
        // amount held to MAX_NOTE_AMOUNT and at most MAX_BATCH_SIZE notes, the
        // sum cannot come near overflowing i128. The cap matters in its own
        // right too -- a note worth more than the circuit's 64-bit range could
        // be deposited but never proved, stranding the funds.
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);
        let token = TokenClient::new(&env, &token_addr);
        let balance_before = token.balance(&depositor);

        let mut commitments = SorobanVec::new(&env);
        commitments.push_back(dummy_commitment(&env, 1));
        commitments.push_back(dummy_commitment(&env, 2));
        let mut amounts = SorobanVec::new(&env);
        amounts.push_back(NOTE_AMOUNT);
        amounts.push_back(MAX_NOTE_AMOUNT + 1);

        let result = client.try_deposit_batch(&depositor, &token_addr, &commitments, &amounts);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::InvalidAmount);
        // Rejected before any transfer: the whole batch is atomic.
        assert_eq!(client.get_next_index(), 0);
        assert_eq!(token.balance(&depositor), balance_before);
    }

    #[test]
    fn test_deposit_batch_rejects_amount_count_mismatch() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let mut commitments = SorobanVec::new(&env);
        commitments.push_back(dummy_commitment(&env, 1));
        commitments.push_back(dummy_commitment(&env, 2));

        let result =
            client.try_deposit_batch(&depositor, &token_addr, &commitments, &equal_amounts(&env, 1));
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::InvalidPublicInputs
        );
    }

    #[test]
    fn test_zero_commitment_valid() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let zero_cm = BytesN::from_array(&env, &[0u8; 32]);
        let idx = client.deposit(&depositor, &token_addr, &zero_cm, &NOTE_AMOUNT);
        assert_eq!(idx, 0);
    }

    #[test]
    fn test_max_value_commitment_valid() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let max_cm = BytesN::from_array(&env, &[0xFF; 32]);
        let idx = client.deposit(&depositor, &token_addr, &max_cm, &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.pause();
        assert!(client.is_paused());

        let c1 = dummy_commitment(&env, 1);
        let result = client.try_deposit(&depositor, &token_addr, &c1, &NOTE_AMOUNT);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::Paused);
    }

    #[test]
    fn test_pause_blocks_deposit_batch() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.pause();

        let mut commitments = SorobanVec::new(&env);
        commitments.push_back(dummy_commitment(&env, 1));
        let result = client.try_deposit_batch(&depositor, &token_addr, &commitments, &equal_amounts(&env, commitments.len()));
        assert_eq!(result.err().unwrap().unwrap(), PoolError::Paused);
    }

    #[test]
    fn test_pause_blocks_withdraw() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        client.pause();

        let recipient = <Address as TestAddress>::generate(&env);
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);
        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::Paused);
    }

    #[test]
    fn test_unpause_restores_deposit() {
        let env = Env::default();
        env.mock_all_auths();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.pause();
        client.unpause();
        assert!(!client.is_paused());

        let idx = client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
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
        let (pool_id, depositor, token_addr) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_addr, &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let bogus_verifier = <Address as TestAddress>::generate(&env);
        client.set_verifier(&bogus_verifier);

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let correct = recipient_hash_from_address(&env, &recipient).unwrap();

        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[160..192]
            .copy_from_slice(&asset_id_from_address(&env, &token_addr).unwrap().to_array());
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&correct.to_array());
        let asset_id = asset_id_from_address(&env, &token_addr).unwrap();
        pi[160..192].copy_from_slice(&asset_id.to_array());
        let public_inputs = Bytes::from_slice(&env, &pi);
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(&recipient, &token_addr, &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(
            result.err().unwrap().unwrap(),
            PoolError::VerificationFailed
        );
    }

    // ──────────────────────────────────────────────
    //  Fee abstraction (issue #149): swap a carved-out relayer fee for XLM
    //  so a withdrawing caller never needs to hold the fee asset.
    // ──────────────────────────────────────────────

    // A verifier stand-in that always accepts, so these tests can drive
    // `withdraw` all the way through the fee-swap logic instead of stopping at
    // `VerificationFailed` like the dummy-proof tests above.
    #[contract]
    struct AlwaysPassVerifier;

    #[contractimpl]
    impl AlwaysPassVerifier {
        pub fn verify_proof(_env: Env, _public_inputs: Bytes, _proof: Bytes) {}
    }

    // A Soroswap-router stand-in: pulls `amount_in` of the input asset from
    // the caller and pays a fixed-rate `amount_out` of the output asset (its
    // own minted supply) to `to`, mirroring the real
    // `swap_exact_tokens_for_tokens(amount_in, amount_out_min, path, to, deadline)`
    // shape closely enough to exercise the pool's cross-contract call and
    // slippage check.
    #[contract]
    struct MockDexRouter;

    #[contractimpl]
    impl MockDexRouter {
        pub fn swap_exact_tokens_for_tokens(
            env: Env,
            amount_in: i128,
            amount_out_min: i128,
            path: soroban_sdk::Vec<Address>,
            to: Address,
            _deadline: u64,
            pool: Address,
        ) -> soroban_sdk::Vec<i128> {
            let token_in = path.get(0).unwrap();
            let token_out = path.get(path.len() - 1).unwrap();
            // Fixed 2:1 rate (token_in : fee_asset) for a deterministic test.
            let amount_out = amount_in / 2;
            assert!(amount_out >= amount_out_min, "slippage exceeded");

            let router_addr = env.current_contract_address();
            // Pull the input asset from the pool, which approved this router
            // for exactly `amount_in` before calling.
            token::Client::new(&env, &token_in).transfer_from(
                &router_addr,
                &pool,
                &router_addr,
                &amount_in,
            );

            let out_sac = StellarAssetClient::new(&env, &token_out);
            out_sac.mint(&to, &amount_out);

            let mut amounts = SorobanVec::new(&env);
            amounts.push_back(amount_in);
            amounts.push_back(amount_out);
            amounts
        }
    }

    /// Same as `setup_with_token` but with an always-pass verifier, a mock
    /// XLM-like fee asset, and a mock DEX router wired up so `withdraw` can
    /// actually reach and exercise the fee-swap path.
    fn setup_with_fee_swap(
        env: &Env,
    ) -> (
        Address,
        Address,
        soroban_sdk::testutils::StellarAssetContract,
        soroban_sdk::testutils::StellarAssetContract,
    ) {
        // The mock DEX router's `mint` call to the fee recipient happens
        // several contract-call frames below `withdraw` (pool -> router ->
        // fee-asset SAC), not as part of `withdraw`'s own top-level auth tree.
        // Plain `mock_all_auths()` only auto-approves auths tied to the root
        // invocation, so a nested `require_auth()` like the SAC's mint-admin
        // check still fails recording-auth validation; the `_allowing_non_root_auth`
        // variant is required for fee-swap tests to reach a real swap.
        env.mock_all_auths_allowing_non_root_auth();
        let admin = <Address as TestAddress>::generate(env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = StellarAssetClient::new(env, &token_id.address());

        let depositor = <Address as TestAddress>::generate(env);
        sac.mint(&depositor, &1_000_000_000);

        let verifier_id = env.register(AlwaysPassVerifier, ());
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), admin.clone()),
        );

        let fee_asset_id = env.register_stellar_asset_contract_v2(admin.clone());
        let router_id = env.register(MockDexRouter, ());
        // `register_stellar_asset_contract_v2` snapshots and restores the auth
        // manager around its own internal `set_admin` call, which can leave
        // recording-auth mode (armed above) turned back off. Re-arm it.
        env.mock_all_auths_allowing_non_root_auth();

        let client = PoolContractClient::new(env, &pool_id);
        client.set_dex_router(&router_id, &fee_asset_id.address());
        client.set_max_fee_bps(&MAX_FEE_BPS_CEILING);

        (pool_id, depositor, token_id, fee_asset_id)
    }

    fn withdraw_public_inputs(
        env: &Env,
        root: &BytesN<32>,
        recipient: &Address,
        amount: i128,
        asset: &Address,
    ) -> Bytes {
        let recipient_hash = recipient_hash_from_address(env, recipient).unwrap();
        let asset_id = asset_id_from_address(env, asset).unwrap();
        let mut pi = [0u8; PUBLIC_INPUT_BYTES as usize];
        pi[..32].copy_from_slice(&root.to_array());
        pi[64..96].copy_from_slice(&recipient_hash.to_array());
        let mut amount_bytes = [0u8; 32];
        amount_bytes[24..32].copy_from_slice(&(amount as u64).to_be_bytes());
        pi[96..128].copy_from_slice(&amount_bytes);
        pi[160..192].copy_from_slice(&asset_id_from_address(env, asset).unwrap().to_array());
        Bytes::from_slice(env, &pi)
    }

    /// A real Ed25519 account address is required for `recipient` (the pool's
    /// recipient binding only supports account-shaped addresses), but the
    /// built-in Stellar Asset Contract still enforces classic trustline rules
    /// for any account holder of the classic asset it wraps.
    /// `TestAddress::generate`/`MuxedAddress::generate` only fabricate the
    /// address value, not the ledger's Account and Trustline entries the
    /// SAC's balance checks read -- so a fee-abstraction test that needs a
    /// *real* successful transfer to a G-address has to create both by hand.
    fn fund_account_with_trustline(
        env: &Env,
        account: &Address,
        token: &soroban_sdk::testutils::StellarAssetContract,
    ) {
        use alloc::rc::Rc;
        use soroban_sdk::xdr;

        fn account_id_of(addr: &Address) -> xdr::AccountId {
            match addr.to_payload().unwrap() {
                AddressPayload::AccountIdPublicKeyEd25519(k) => xdr::AccountId(
                    xdr::PublicKey::PublicKeyTypeEd25519(xdr::Uint256(k.to_array())),
                ),
                _ => panic!("expected an account (G...) address"),
            }
        }

        let account_id = account_id_of(account);
        let issuer_id = account_id_of(&token.issuer().address());
        let asset = match token.asset() {
            xdr::Asset::CreditAlphanum4(a) => xdr::TrustLineAsset::CreditAlphanum4(a),
            xdr::Asset::CreditAlphanum12(a) => xdr::TrustLineAsset::CreditAlphanum12(a),
            xdr::Asset::Native => xdr::TrustLineAsset::Native,
        };
        let _ = &issuer_id; // already embedded in `asset` for non-native assets

        let account_entry = xdr::LedgerEntry {
            last_modified_ledger_seq: 0,
            data: xdr::LedgerEntryData::Account(xdr::AccountEntry {
                account_id: account_id.clone(),
                balance: 1_000_000_000,
                seq_num: xdr::SequenceNumber(0),
                num_sub_entries: 1,
                inflation_dest: None,
                flags: 0,
                home_domain: xdr::String32(xdr::StringM::default()),
                thresholds: xdr::Thresholds([1, 0, 0, 0]),
                signers: xdr::VecM::default(),
                ext: xdr::AccountEntryExt::V0,
            }),
            ext: xdr::LedgerEntryExt::V0,
        };
        let account_key = Rc::new(xdr::LedgerKey::Account(xdr::LedgerKeyAccount {
            account_id: account_id.clone(),
        }));
        env.host()
            .add_ledger_entry(&account_key, &Rc::new(account_entry), None)
            .unwrap();

        let trustline_entry = xdr::LedgerEntry {
            last_modified_ledger_seq: 0,
            data: xdr::LedgerEntryData::Trustline(xdr::TrustLineEntry {
                account_id: account_id.clone(),
                asset: asset.clone(),
                balance: 0,
                limit: i64::MAX,
                flags: 1, // AUTHORIZED_FLAG
                ext: xdr::TrustLineEntryExt::V0,
            }),
            ext: xdr::LedgerEntryExt::V0,
        };
        let trustline_key = Rc::new(xdr::LedgerKey::Trustline(xdr::LedgerKeyTrustLine {
            account_id,
            asset,
        }));
        env.host()
            .add_ledger_entry(&trustline_key, &Rc::new(trustline_entry), None)
            .unwrap();
    }

    #[test]
    fn test_withdraw_with_zero_fee_behaves_as_before() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_contract, _) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_contract.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = <soroban_sdk::MuxedAddress as TestMuxedAddress>::generate(&env).address();
        fund_account_with_trustline(&env, &recipient, &token_contract);
        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_contract.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let change_index =
            client.withdraw(&recipient, &token_contract.address(), &public_inputs, &proof, &0i128, &0i128, &recipient);
        assert_eq!(change_index, 1);

        let token = TokenClient::new(&env, &token_contract.address());
        assert_eq!(token.balance(&recipient), NOTE_AMOUNT);
    }

    /// Acceptance criterion: a caller holding zero XLM can still complete a
    /// withdrawal, because the relayer fee is carved out of the withdrawn
    /// asset and swapped into the fee asset on-chain -- the withdrawing
    /// recipient never needs to acquire or spend it.
    #[test]
    fn test_withdraw_with_fee_swaps_and_pays_recipient_the_remainder() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_contract, fee_asset) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_contract.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        // The recipient never gets a trustline for the fee asset at all in
        // this test -- exactly the point of fee abstraction: a caller who has
        // never held or interacted with the fee asset can still withdraw.
        let recipient = <soroban_sdk::MuxedAddress as TestMuxedAddress>::generate(&env).address();
        fund_account_with_trustline(&env, &recipient, &token_contract);
        let fee_asset_client = TokenClient::new(&env, &fee_asset.address());

        let relayer = <Address as TestAddress>::generate(&env);
        let fee_amount: i128 = 100_000; // 1% of NOTE_AMOUNT, under the 5% cap
        let fee_min_out: i128 = 40_000; // mock router pays out amount_in / 2

        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_contract.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        client.withdraw(
            &recipient,
            &token_contract.address(),
            &public_inputs,
            &proof,
            &fee_amount,
            &fee_min_out,
            &relayer,
        );

        let token = TokenClient::new(&env, &token_contract.address());
        assert_eq!(token.balance(&recipient), NOTE_AMOUNT - fee_amount);
        // The relayer receives the fee asset, not the withdrawn asset -- it
        // never has to touch the shielded token to recover its cost.
        assert_eq!(fee_asset_client.balance(&relayer), fee_amount / 2);
        assert_eq!(token.balance(&relayer), 0);
    }

    #[test]
    fn test_withdraw_emits_fee_swapped_event() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_contract, _) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_contract.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = <soroban_sdk::MuxedAddress as TestMuxedAddress>::generate(&env).address();
        fund_account_with_trustline(&env, &recipient, &token_contract);
        let relayer = <Address as TestAddress>::generate(&env);
        let fee_amount: i128 = 100_000;

        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_contract.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        client.withdraw(&recipient, &token_contract.address(), &public_inputs, &proof, &fee_amount, &0i128, &relayer);

        let raw_events = env.events().all();
        let found = raw_events.events().iter().any(|e| {
            alloc::format!("{:?}", e.body).contains("fee_swapped")
        });
        assert!(found, "expected a fee_swapped event to be published");
    }

    #[test]
    fn test_withdraw_rejects_fee_above_max_fee_bps() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_contract, _) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        // Tighten the cap well below the ceiling to make the rejection boundary
        // easy to hit deterministically.
        client.set_max_fee_bps(&100); // 1%

        client.deposit(&depositor, &token_contract.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let relayer = <Address as TestAddress>::generate(&env);
        // 2% of NOTE_AMOUNT: exceeds the 1% cap just configured.
        let fee_amount: i128 = NOTE_AMOUNT / 50;

        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_contract.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result =
            client.try_withdraw(&recipient, &token_contract.address(), &public_inputs, &proof, &fee_amount, &0i128, &relayer);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::InvalidFee);
    }

    #[test]
    fn test_withdraw_rejects_fee_exceeding_payout() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_contract, _) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_contract.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let relayer = <Address as TestAddress>::generate(&env);
        let fee_amount = NOTE_AMOUNT + 1;

        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_contract.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result =
            client.try_withdraw(&recipient, &token_contract.address(), &public_inputs, &proof, &fee_amount, &0i128, &relayer);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::InvalidFee);
    }

    #[test]
    fn test_withdraw_rejects_negative_fee() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        let (pool_id, depositor, token_contract, _) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        client.deposit(&depositor, &token_contract.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        let recipient = Address::from_str(&env, ACCOUNT_STRKEY);
        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_contract.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result =
            client.try_withdraw(&recipient, &token_contract.address(), &public_inputs, &proof, &-1i128, &0i128, &recipient);
        assert_eq!(result.err().unwrap().unwrap(), PoolError::InvalidFee);
    }

    #[test]
    fn test_withdraw_without_dex_router_configured_rejects_nonzero_fee() {
        let env = Env::default();
        env.cost_estimate().budget().reset_unlimited();
        // Deliberately use the plain setup (no router/fee-asset configured).
        env.mock_all_auths();
        let admin = <Address as TestAddress>::generate(&env);
        let token_id = env.register_stellar_asset_contract_v2(admin.clone());
        let sac = StellarAssetClient::new(&env, &token_id.address());
        let depositor = <Address as TestAddress>::generate(&env);
        sac.mint(&depositor, &1_000_000_000);
        let verifier_id = env.register(AlwaysPassVerifier, ());
        let pool_id = env.register(
            PoolContract,
            (verifier_id, token_id.address(), admin.clone()),
        );
        client_set_max_fee_bps_helper(&env, &pool_id);

        let client = PoolContractClient::new(&env, &pool_id);
        client.deposit(&depositor, &token_id.address(), &dummy_commitment(&env, 1), &NOTE_AMOUNT);
        let root = client.get_root().unwrap();

        // Needs a real trustline: the fee check happens after the recipient's
        // own (payout - fee) transfer succeeds, so without one this would fail
        // with the SAC's own TrustlineMissingError instead of the fee check
        // this test targets. Its numeric contract-error code (13) happens to
        // collide with PoolError::AmountOverflow's discriminant, which is what
        // makes that failure mode so easy to misdiagnose as a pool error.
        let recipient = <soroban_sdk::MuxedAddress as TestMuxedAddress>::generate(&env).address();
        fund_account_with_trustline(&env, &recipient, &token_id);
        let relayer = <Address as TestAddress>::generate(&env);
        let public_inputs = withdraw_public_inputs(&env, &root, &recipient, NOTE_AMOUNT, &token_id.address());
        let proof = Bytes::from_slice(&env, &[0u8; PROOF_BYTES]);

        let result = client.try_withdraw(
            &recipient,
            &token_id.address(),
            &public_inputs,
            &proof,
            &100_000i128,
            &0i128,
            &relayer,
        );
        assert_eq!(result.err().unwrap().unwrap(), PoolError::DexRouterNotSet);
    }

    fn client_set_max_fee_bps_helper(env: &Env, pool_id: &Address) {
        let client = PoolContractClient::new(env, pool_id);
        client.set_max_fee_bps(&MAX_FEE_BPS_CEILING);
    }

    #[test]
    fn test_set_dex_router_requires_admin_auth() {
        let env = Env::default();
        let (pool_id, _, _, _) = setup_with_fee_swap(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let router = <Address as TestAddress>::generate(&env);
        let fee_asset = <Address as TestAddress>::generate(&env);
        client.set_dex_router(&router, &fee_asset);
        assert!(
            env.auths().iter().any(|(_, invocation)| invocation.function
                == soroban_sdk::testutils::AuthorizedFunction::Contract((
                    pool_id.clone(),
                    Symbol::new(&env, "set_dex_router"),
                    (router.clone(), fee_asset.clone()).into_val(&env),
                ))),
            "set_dex_router must require the admin's authorization"
        );
    }

    #[test]
    fn test_set_max_fee_bps_rejects_above_ceiling() {
        let env = Env::default();
        env.mock_all_auths();
        let (pool_id, _, _) = setup_with_token(&env);
        let client = PoolContractClient::new(&env, &pool_id);

        let result = client.try_set_max_fee_bps(&(MAX_FEE_BPS_CEILING + 1));
        assert_eq!(result.err().unwrap().unwrap(), PoolError::InvalidFee);
    }
}
