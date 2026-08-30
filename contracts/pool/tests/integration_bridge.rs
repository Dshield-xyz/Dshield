#![cfg(test)]

//! Integration tests for bridge withdrawal feature.
//!
//! These tests verify the complete flow:
//! 1. User deposits a note
//! 2. User generates bridge withdrawal proof
//! 3. Pool verifies proof and routes to bridge adapter
//! 4. Bridge adapter validates and initiates cross-chain transfer
//! 5. Change note is correctly inserted
//! 6. Nullifier is consumed (cannot be replayed)
//!
//! NOTE: These tests require the bridge_withdrawal circuit to be compiled
//! and the verification key to be available. They are integration tests,
//! not unit tests, and should be run separately from the fast unit test suite.
//!
//! Run with: cargo test --test integration_bridge -- --ignored

// TODO: Implement these tests after:
// 1. Bridge withdrawal circuit is compiled (circuits/bridge_withdrawal)
// 2. Bridge verifier contract is deployed with bridge VK
// 3. Bridge adapter contract is fully implemented with real bridge protocol
//
// Test scenarios to implement:
//
// - test_full_bridge_withdrawal_flow:
//   * Deposit → generate bridge proof → withdraw_bridge → verify change note
//
// - test_bridge_destination_cannot_be_redirected:
//   * Generate proof for Ethereum address A
//   * Attempt to submit with address B
//   * Should fail with DestinationMismatch
//
// - test_bridge_and_regular_withdrawal_nullifier_isolation:
//   * Same nullifier cannot be used for both types
//   * But different nullifiers from same note work fine
//
// - test_bridge_withdrawal_respects_min_max_amounts:
//   * Adapter rejects amounts below min_amount
//   * Adapter rejects amounts above max_amount
//
// - test_bridge_withdrawal_when_paused:
//   * Pool pause should block bridge withdrawals
//   * Adapter pause should block bridge withdrawals
//   * Both can be unpaused independently
//
// - test_bridge_withdrawal_with_zero_payout:
//   * Re-key note without bridging (payout = 0)
//   * Change note should have full original amount
//
// - test_cross_chain_replay_protection:
//   * Proof for Ethereum (chain_id=1) fails on Polygon (chain_id=2)
//   * Even with same destination address
