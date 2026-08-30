# Bridge Withdrawals

DShield supports direct cross-chain withdrawals via configurable bridge adapters, allowing users to exit their shielded funds directly to Ethereum, Polygon, Arbitrum, Optimism, Base, or other supported chains without an intermediate public withdrawal step on Stellar.

## Overview

A traditional withdrawal exposes:

1. **Stellar withdrawal**: User → Stellar address (public, traceable)
2. **Bridge transaction**: Stellar address → Destination chain (public, links to withdrawal)

Bridge withdrawals compress this into a single step:

- **Bridge withdrawal**: Shielded pool → Destination chain (only bridge sees the link)

The withdrawal amount and timing are hidden from Stellar observers. The bridge protocol sees the transfer, but the connection to the original deposit is still broken.

## Architecture

```
┌─────────────┐
│   User      │
│  (Client)   │
└─────┬───────┘
      │ Generate bridge withdrawal proof
      │ (binds destination_hash = Poseidon2(chain_id, destination))
      ▼
┌─────────────────┐
│  Pool Contract  │
│  - Verify proof │
│  - Consume      │
│    nullifier    │
│  - Insert       │
│    change note  │
└────────┬────────┘
         │ Approve tokens & call bridge_withdraw
         ▼
┌──────────────────┐
│ Bridge Adapter   │
│  - Validate      │
│    destination   │
│  - Recompute &   │
│    verify hash   │
└────────┬─────────┘
         │ Transfer tokens & initiate bridge
         ▼
┌──────────────────┐
│ Bridge Protocol  │
│ (Wormhole, CCTP, │
│  Axelar, etc.)   │
└────────┬─────────┘
         │ Cross-chain message
         ▼
┌──────────────────┐
│ Destination      │
│ Chain            │
│ (Ethereum, etc.) │
└──────────────────┘
```

## Components

### 1. Bridge Withdrawal Circuit (`circuits/bridge_withdrawal/`)

A variant of the regular withdrawal circuit with one key difference:

**Regular withdrawal:**

- Public input: `recipient_hash = Poseidon2(addr_left, addr_right)` (Stellar address)

**Bridge withdrawal:**

- Public input: `destination_hash = Poseidon2(chain_id, addr_left, addr_right)` (cross-chain destination)

The `chain_id` domain separator prevents cross-chain replay: a proof for Ethereum cannot be reused for Polygon.

**Same as regular withdrawal:**

- Value conservation: `withdraw_amount + change = note.amount`
- Change note insertion (remainder stays on Stellar)
- Nullifier consumption
- Root verification

### 2. Bridge Adapter Contract (`contracts/bridge_adapter/`)

A **swappable interface** between the pool and bridge protocols. The pool never hardcodes a specific bridge; it calls the adapter, which can be upgraded without touching pool logic.

**Responsibilities:**

- Validate destination address encoding (e.g., 20 bytes for EVM chains)
- Recompute `destination_hash` from `(chain_id, destination)` and verify it matches the proof
- Transfer tokens from pool to bridge protocol
- Initiate cross-chain transfer
- Enforce per-chain min/max amounts
- Pausable by admin

**Trust boundary:** The adapter can censor or delay withdrawals but cannot redirect funds (destination is bound in the proof). Users trust the adapter admin and the bridge protocol.

### 3. Pool Contract Updates (`contracts/pool/src/lib.rs`)

**New entrypoint:**

```rust
pub fn withdraw_bridge(
    env: Env,
    chain_id: u32,
    destination: Bytes,
    public_inputs: Bytes,
    proof_bytes: Bytes,
) -> Result<u32, PoolError>
```

**New configuration:**

- `set_bridge_adapter(adapter: Address)` - Admin-only
- `set_bridge_verifier(verifier: Address)` - Admin-only (separate VK from regular withdrawals)

**Proof verification:**

- Uses `bridge_verifier` (different verification key than regular withdrawals)
- Verifies `destination_hash` binding via adapter recomputation
- Shares same nullifier space (cannot double-spend across withdrawal types)

### 4. Frontend Support (`frontend/src/lib/bridge.ts`)

**Key functions:**

- `computeDestinationHash(chainId, destination)` - Client-side hash computation (must match contract exactly)
- `encodeDestination(chainId, destination)` - Format destination for Soroban call
- `validateDestination(chainId, destination)` - Pre-submission validation
- UI components for chain selection and destination input (to be added to `withdraw/page.tsx`)

## Supported Chains

| Chain ID | Chain Name | Address Format | Estimated Time |
| -------- | ---------- | -------------- | -------------- |
| 1        | Ethereum   | 20-byte EVM    | 15-20 minutes  |
| 2        | Polygon    | 20-byte EVM    | 10-15 minutes  |
| 3        | Arbitrum   | 20-byte EVM    | 10-15 minutes  |
| 4        | Optimism   | 20-byte EVM    | 10-15 minutes  |
| 5        | Base       | 20-byte EVM    | 10-15 minutes  |

Times assume Wormhole or CCTP integration. Actual times depend on:

- Bridge protocol (Wormhole, CCTP, Axelar, LayerZero)
- Source/destination finality
- Guardian/validator set size
- Network congestion

## Security Properties

### ✅ Enforced by Circuits + Contracts

1. **Destination binding**: Proof commits to `destination_hash`. Pool + adapter verify the hash matches `(chain_id, destination)`. Cannot front-run or redirect.

2. **Value conservation**: Circuit constrains `withdraw_amount + change = note.amount`. Cannot inflate value.

3. **Nullifier uniqueness**: Pool enforces nullifier is spent exactly once (across both withdrawal types).

4. **Change note correctness**: Circuit proves change note commits to `amount - withdraw_amount` with fresh secrets.

5. **Chain-specific binding**: `chain_id` is part of `destination_hash`. A proof for Ethereum fails on Polygon.

### ⚠️ Trust Assumptions (NOT Enforceable)

1. **Bridge protocol security**: The bridge (Wormhole, CCTP, etc.) must deliver funds correctly. Protocol exploits, guardian failures, or censorship are outside DShield's control.

2. **Bridge adapter admin**: Can pause bridging, change bridge routes, or upgrade the adapter. Cannot steal funds already in the pool (requires valid proof) but can censor future bridge withdrawals.

3. **Destination chain finality**: Re-org attacks or finality reversions on the destination chain are not DShield's responsibility.

4. **Bridge protocol fees**: Some bridges charge fees in the bridged token or the destination's native gas token. The adapter does not currently handle fee estimation or balance checks for destination gas.

### 🔴 Known Limitations

1. **No atomicity**: The Stellar-side withdrawal (nullifier spent, change inserted) is atomic, but the destination-chain delivery is not. The bridge protocol may fail, delay, or require manual VAA submission.

2. **No refunds**: If the bridge protocol fails to deliver (e.g., invalid destination address), funds are locked in the bridge. The pool contract has already spent the nullifier and cannot reverse.

3. **Exposed to bridge observers**: The bridge protocol (and any chain indexers watching it) see the withdrawal amount, timing, and destination. Privacy is only maintained _within the shielded pool_. The bridge step is as public as any regular bridge transaction.

4. **Single bridge protocol per chain**: The current adapter implementation assumes one bridge integration per destination chain. Supporting multiple bridges (e.g., Wormhole vs CCTP for Ethereum) requires adapter upgrades.

## Deployment Checklist

For production deployment:

- [ ] Compile and verify bridge withdrawal circuit (`nargo compile`)
- [ ] Generate verification key (`nargo prove` → extract VK)
- [ ] Deploy bridge verifier contract with bridge VK
- [ ] Deploy bridge adapter contract
- [ ] Configure adapter with bridge protocol address for each chain
- [ ] Set `min_amount` and `max_amount` per chain (bridge protocol limits)
- [ ] Pool admin: `set_bridge_verifier(bridge_verifier_address)`
- [ ] Pool admin: `set_bridge_adapter(adapter_address)`
- [ ] Test end-to-end on testnet (full deposit → bridge withdrawal cycle)
- [ ] Verify destination funds arrive on target chain
- [ ] Audit bridge adapter integration (external security review recommended)
- [ ] Document bridge protocol trust assumptions for users
- [ ] Add destination chain indexers/explorers to UI for tracking

## Usage (Client-Side)

```typescript
import {
  computeDestinationHash,
  encodeDestination,
  ChainId,
} from "@/lib/bridge";

// 1. User selects destination chain and enters address
const chainId = ChainId.Ethereum;
const destination = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb";

// 2. Compute destination hash for proof
const destinationHash = await computeDestinationHash(chainId, destination);

// 3. Generate bridge withdrawal proof
const { proof, publicInputs } = await proveBridgeWithdrawal({
  nullifier: note.nullifier,
  secret: note.secret,
  amount: note.amount,
  withdrawAmount,
  changeNullifier: changeNote.nullifier,
  changeSecret: changeNote.secret,
  changeCommitment: changeNote.commitment,
  root: onChainRoot,
  nullifierHash,
  destinationHash, // NEW: replaces recipientHash
  pathSiblings,
  pathBits,
});

// 4. Submit bridge withdrawal
const destinationBytes = encodeDestination(chainId, destination);
await buildContractCall(
  poolId,
  "withdraw_bridge",
  [
    StellarSdk.nativeToScVal(chainId, { type: "u32" }),
    StellarSdk.xdr.ScVal.scvBytes(destinationBytes),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
  ],
  address,
);
```

## Future Enhancements

1. **Multi-bridge support**: Allow multiple bridge integrations per chain (Wormhole, CCTP, Axelar) with client-side selection.

2. **Fee estimation**: Query bridge protocol for fees and warn user if destination gas balance is too low.

3. **Delivery tracking**: Index bridge protocol events and show "pending", "delivered", or "failed" status in UI.

4. **Fallback recovery**: If bridge delivery fails, allow admin-assisted recovery (requires governance process and audit).

5. **Optimistic L2 support**: Add support for native bridges to Optimism/Arbitrum with fraud-proof-aware time estimates.

6. **Cosmos IBC**: Extend adapter to support IBC transfers (different address encoding and finality model).

## Testing

Run bridge withdrawal tests:

```bash
# Contract tests
cd contracts/pool
cargo test bridge

# Circuit tests (after implementing bridge_withdrawal circuit)
cd circuits/bridge_withdrawal
nargo test

# Full integration test (requires running Stellar + bridge protocol testnet)
cd frontend
npm run test:bridge
```

See `contracts/pool/src/bridge_tests.rs` for:

- Destination hash binding verification
- Nullifier uniqueness across withdrawal types
- Bridge verifier/adapter configuration checks
- Change note insertion correctness

## References

- [THREAT_MODEL.md](./THREAT_MODEL.md) - Bridge adapter trust boundary
- [circuits/bridge_withdrawal/src/main.nr](../circuits/bridge_withdrawal/src/main.nr) - Circuit implementation
- [contracts/bridge_adapter/src/lib.rs](../contracts/bridge_adapter/src/lib.rs) - Adapter contract
- [frontend/src/lib/bridge.ts](../frontend/src/lib/bridge.ts) - Client-side utilities
