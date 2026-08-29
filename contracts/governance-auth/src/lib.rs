#![no_std]

//! Shared helper for contracts gated behind [`dshield-governance`](../governance)'s
//! timelock. Deliberately has no `#[contract]` of its own -- `#[contract]`
//! emits a `__constructor` export, and Soroban's WASM linker rejects two of
//! those landing in the same compiled contract, so the deployed
//! `GovernanceContract` lives in its own crate and gated contracts (pool,
//! compliance) depend only on this plain-Rust helper instead.

use soroban_sdk::Address;

/// Asserts that the current invocation was authorized by `timelock` (the
/// deployed `GovernanceContract` address a gated contract was configured
/// with). A contract calling another contract is automatically authorized
/// as itself, so this succeeds only when `timelock`'s own `execute` is what
/// invoked the calling function -- i.e. only after that call was queued and
/// its delay elapsed. Gated setters (pool's `set_verifier`/admin rotation,
/// compliance's disclosure-VK rotation) call this in place of the direct
/// `admin.require_auth()` they used before the timelock existed.
pub fn require_timelock(timelock: &Address) {
    timelock.require_auth();
}
