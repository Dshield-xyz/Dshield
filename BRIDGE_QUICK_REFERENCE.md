# Bridge Withdrawal Quick Reference

Quick guide for developers working with DShield's cross-chain bridge withdrawal feature.

## Key Concepts

**Regular withdrawal:** Pool → Stellar address (direct token transfer)  
**Bridge withdrawal:** Pool → Bridge adapter → Bridge protocol → Destination chain

**Destination binding:** Proof commits to `Poseidon2(chain_id, addr_left, addr_right)`  
**Change note:** Remainder stays on Stellar (always created, even if zero)  
**Nullifier space:** Shared between regular and bridge withdrawals (cannot double-spend)

## Components

| Component      | Location                                 | Purpose                             |
| -------------- | ---------------------------------------- | ----------------------------------- |
| Bridge circuit | `circuits/bridge_withdrawal/src/main.nr` | Proves spend + destination binding  |
| Bridge adapter | `contracts/bridge_adapter/src/lib.rs`    | Validates destination, calls bridge |
| Pool updates   | `contracts/pool/src/lib.rs`              | `withdraw_bridge()` entrypoint      |
| Frontend utils | `frontend/src/lib/bridge.ts`             | Client-side destination hash        |
| Tests          | `contracts/pool/src/bridge_tests.rs`     | Unit tests                          |
| Docs           | `docs/BRIDGE_WITHDRAWALS.md`             | Full documentation                  |

## Supported Chains

```typescript
enum ChainId {
  Ethereum = 1, // 0x-prefixed, 20-byte address
  Polygon = 2, // 0x-prefixed, 20-byte address
  Arbitrum = 3, // 0x-prefixed, 20-byte address
  Optimism = 4, // 0x-prefixed, 20-byte address
  Base = 5, // 0x-prefixed, 20-byte address
}
```

## Common Tasks

### Compile Bridge Circuit

```bash
cd circuits/bridge_withdrawal
nargo compile
nargo prove  # Generate sample proof + VK
```

### Run Contract Tests

```bash
cd contracts/pool
cargo test bridge_tests  # Unit tests
cargo test --test integration_bridge -- --ignored  # Integration (when ready)
```

### Deploy Contracts (Testnet)

```bash
# 1. Deploy bridge verifier with bridge VK
stellar contract deploy --wasm verifier.wasm --network testnet

# 2. Deploy bridge adapter
stellar contract deploy --wasm bridge_adapter.wasm --network testnet

# 3. Initialize adapter
stellar contract invoke --id $ADAPTER_ID --network testnet \
  -- initialize \
  --admin $ADMIN_ADDRESS \
  --pool $POOL_ADDRESS \
  --token $TOKEN_ADDRESS

# 4. Configure bridge route (example: Ethereum via Wormhole)
stellar contract invoke --id $ADAPTER_ID --network testnet \
  -- configure_bridge \
  --chain 1 \
  --config '{"protocol_address": "C...", "min_amount": "1000000", "max_amount": "1000000000000", "enabled": true}'

# 5. Set bridge verifier and adapter in pool
stellar contract invoke --id $POOL_ID --network testnet \
  -- set_bridge_verifier --verifier $BRIDGE_VERIFIER_ID

stellar contract invoke --id $POOL_ID --network testnet \
  -- set_bridge_adapter --adapter $ADAPTER_ID
```

### Client-Side Bridge Withdrawal

```typescript
import {
  computeDestinationHash,
  encodeDestination,
  ChainId,
} from "@/lib/bridge";

// 1. User inputs
const chainId = ChainId.Ethereum;
const destination = "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb";
const withdrawAmount = "5000000"; // 5 USDC

// 2. Compute destination hash
const destinationHash = await computeDestinationHash(chainId, destination);

// 3. Generate proof (TODO: implement proveBridgeWithdrawal)
const { proof, publicInputs } = await proveBridgeWithdrawal({
  // ... same as regular withdrawal but use destinationHash instead of recipientHash
  destinationHash,
});

// 4. Submit transaction
const destinationBytes = encodeDestination(chainId, destination);
const tx = await buildContractCall(
  poolId,
  "withdraw_bridge",
  [
    StellarSdk.nativeToScVal(chainId, { type: "u32" }),
    StellarSdk.xdr.ScVal.scvBytes(destinationBytes),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
    StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
  ],
  userAddress,
);
```

## Destination Hash Encoding

**CRITICAL:** Frontend and contract MUST agree on encoding.

### EVM Chains (Ethereum, Polygon, etc.)

```
Input: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb" (20 bytes)

Split into 10 + 10 bytes:
  left  = 742d35Cc6634C0532925
  right = a3b844Bc9e7595f0bEb

Right-align each in 32-byte buffer:
  left_padded  = 0x0000000000000000000000000000000000000000000000742d35Cc6634C0532925
  right_padded = 0x000000000000000000000000000000000000000000000000a3b844Bc9e7595f0bEb

Chain ID as 32-byte big-endian:
  chain_id_padded = 0x0000000000000000000000000000000000000000000000000000000000000001

Hash:
  destination_hash = Poseidon2(chain_id_padded, left_padded, right_padded)
```

### Testing Encoding Match

```typescript
// Frontend
const hash1 = await computeDestinationHash(ChainId.Ethereum, "0x742d...");

// Contract (in test)
let hash2 = compute_destination_hash(&env, ChainId::Ethereum, &destination_bytes);

assert_eq!(hash1, hash2);  // Must match exactly
```

## Error Codes

| Error                  | Code  | Meaning                                  |
| ---------------------- | ----- | ---------------------------------------- |
| `BridgeAdapterNotSet`  | 18    | Pool has no adapter configured           |
| `BridgeVerifierNotSet` | 19    | Pool has no bridge VK configured         |
| `DestinationMismatch`  | 20    | Destination hash doesn't match proof     |
| `NullifierUsed`        | 2     | Note already spent (same for both types) |
| `InvalidDestination`   | 5     | Bad address format (adapter error)       |
| `AmountTooSmall`       | 7     | Below bridge min (adapter error)         |
| `AmountTooLarge`       | 8     | Above bridge max (adapter error)         |
| `UnsupportedChain`     | 9     | Chain not configured (adapter error)     |
| `Paused`               | 10/16 | Adapter or pool is paused                |

## Security Checklist

Before deploying:

- [ ] Bridge circuit compiled and VK generated
- [ ] Frontend `computeDestinationHash` matches contract `compute_destination_hash` (test proves this)
- [ ] Bridge adapter configured with real bridge protocol (not stub)
- [ ] Min/max amounts set per chain (check bridge protocol limits)
- [ ] Test on testnet: deposit → bridge withdraw → verify destination receipt
- [ ] External audit of bridge adapter contract
- [ ] Document bridge protocol trust assumptions for users
- [ ] UI warnings about bridge risks (non-atomic, protocol trust)

## Debugging Tips

**"Proof verification failed":**

- Check bridge VK matches compiled circuit
- Verify public inputs are in correct order
- Ensure proof was generated with matching circuit version

**"Destination mismatch":**

- Frontend and contract encoding must match exactly
- Check byte order (big-endian) and padding
- Verify chain ID is correct

**"Bridge adapter not set":**

- Admin must call `set_bridge_adapter()` on pool
- Check adapter address is correct (not verifier address)

**"Nullifier already used":**

- Cannot reuse nullifiers across withdrawal types
- Check if note was already spent (regular or bridge)
- Generate fresh change note after each spend

**Bridge delivery failed:**

- Check bridge protocol status (Wormhole VAA, CCTP attestation)
- Verify destination address is valid on target chain
- Check destination chain finality (reorg protection)
- No automatic refund - requires manual recovery if supported

## Further Reading

- [BRIDGE_WITHDRAWALS.md](docs/BRIDGE_WITHDRAWALS.md) - Full feature documentation
- [THREAT_MODEL.md](docs/THREAT_MODEL.md) - Security properties and trust boundaries
- [Bridge adapter source](contracts/bridge_adapter/src/lib.rs) - Contract implementation
- [Bridge circuit source](circuits/bridge_withdrawal/src/main.nr) - Circuit logic
- [Bridge tests](contracts/pool/src/bridge_tests.rs) - Test examples

## Common Gotchas

1. **Change note is ALWAYS created:** Even for full withdrawals (amount = payout). This is intentional for privacy.

2. **No atomicity:** Stellar-side withdrawal is atomic, but destination delivery is asynchronous. UI should show "pending" state.

3. **No nullifier reversal:** If bridge fails after pool processes withdrawal, nullifier is permanently spent. Recovery requires adapter support.

4. **Chain ID domain separation:** Same destination address on different chains produces different hashes. This prevents cross-chain replay.

5. **Adapter is swappable:** Pool doesn't hardcode bridge protocol. Adapter can be upgraded to support new bridges without touching pool.

6. **Bridge visibility:** Bridge protocol sees withdrawal amount/destination. Privacy only holds _within_ the shielded pool.

7. **Separate verifier:** Bridge withdrawals use different VK than regular withdrawals. Both must be configured.

8. **Shared nullifier space:** Regular and bridge withdrawals use same nullifier storage. Cannot spend same nullifier via both paths.
