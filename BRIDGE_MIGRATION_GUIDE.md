# Bridge Withdrawal Migration Guide

Guide for updating existing DShield deployments to support cross-chain bridge withdrawals.

## Overview

Bridge withdrawals are an **optional feature** that can be added to existing pools without disrupting regular withdrawals. The pool contract changes are **backward compatible**:

- Regular withdrawals continue to work exactly as before
- New `withdraw_bridge` entrypoint is independent
- Bridge configuration is optional (pool works without it)
- No changes to deposit flow or note format

## Prerequisites

- Existing DShield pool contract deployed
- Admin access to pool contract
- Noir compiler (`nargo`) installed
- Stellar CLI (`stellar`) installed
- Bridge protocol account/credentials (Wormhole, CCTP, etc.)

## Migration Steps

### 1. Compile Bridge Circuit

```bash
cd circuits/bridge_withdrawal

# Compile circuit
nargo compile

# Generate verification key
nargo prove

# Extract VK (format depends on verifier implementation)
# For UltraHonk verifier, extract from proof artifacts
```

**Output:** Bridge withdrawal verification key (VK)

### 2. Deploy Bridge Verifier

```bash
# Use same verifier contract as regular withdrawals, but with bridge VK
stellar contract deploy \
  --wasm contracts/verifier/target/wasm32-unknown-unknown/release/verifier.wasm \
  --network mainnet \
  --source $ADMIN_SECRET

# Note the returned contract ID: $BRIDGE_VERIFIER_ID
```

**Initialize verifier:**

```bash
stellar contract invoke \
  --id $BRIDGE_VERIFIER_ID \
  --network mainnet \
  --source $ADMIN_SECRET \
  -- initialize \
  --vk_bytes $(cat bridge_vk.bin | base64)
```

### 3. Deploy Bridge Adapter

```bash
cd contracts/bridge_adapter

# Build contract
cargo build --release --target wasm32-unknown-unknown

# Deploy
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/bridge_adapter.wasm \
  --network mainnet \
  --source $ADMIN_SECRET

# Note the returned contract ID: $BRIDGE_ADAPTER_ID
```

**Initialize adapter:**

```bash
stellar contract invoke \
  --id $BRIDGE_ADAPTER_ID \
  --network mainnet \
  --source $ADMIN_SECRET \
  -- initialize \
  --admin $ADMIN_ADDRESS \
  --pool $EXISTING_POOL_ID \
  --token $TOKEN_ADDRESS  # Same token as pool
```

### 4. Configure Bridge Routes

For each destination chain you want to support:

```bash
# Example: Ethereum via Wormhole
stellar contract invoke \
  --id $BRIDGE_ADAPTER_ID \
  --network mainnet \
  --source $ADMIN_SECRET \
  -- configure_bridge \
  --chain 1 \
  --config '{
    "protocol_address": "C...",  # Wormhole Token Bridge contract
    "min_amount": "1000000",     # 1 USDC (adjust per bridge limits)
    "max_amount": "100000000000", # 100k USDC
    "enabled": true
  }'

# Repeat for each chain (Polygon, Arbitrum, etc.)
```

**Finding bridge protocol addresses:**

- **Wormhole:** Check [docs.wormhole.com](https://docs.wormhole.com) for Stellar contract addresses
- **CCTP:** Check [Circle docs](https://developers.circle.com/stablecoin/docs/cctp-protocol-contract) for TokenMessenger address
- **Axelar:** Check [Axelar docs](https://docs.axelar.dev/resources/contract-addresses/mainnet)

### 5. Update Pool Configuration

```bash
# Set bridge verifier in existing pool
stellar contract invoke \
  --id $EXISTING_POOL_ID \
  --network mainnet \
  --source $POOL_ADMIN_SECRET \
  -- set_bridge_verifier \
  --verifier $BRIDGE_VERIFIER_ID

# Set bridge adapter in existing pool
stellar contract invoke \
  --id $EXISTING_POOL_ID \
  --network mainnet \
  --source $POOL_ADMIN_SECRET \
  -- set_bridge_adapter \
  --adapter $BRIDGE_ADAPTER_ID
```

**Verification:**

```bash
# Check configuration
stellar contract invoke \
  --id $EXISTING_POOL_ID \
  --network mainnet \
  -- get_bridge_verifier
# Should return: $BRIDGE_VERIFIER_ID

stellar contract invoke \
  --id $EXISTING_POOL_ID \
  --network mainnet \
  -- get_bridge_adapter
# Should return: $BRIDGE_ADAPTER_ID
```

### 6. Update Frontend

**Environment variables (`.env.local`):**

```bash
# Add new variables
NEXT_PUBLIC_BRIDGE_ADAPTER_ID=C...
NEXT_PUBLIC_BRIDGE_VERIFIER_ID=C...

# Existing variables (unchanged)
NEXT_PUBLIC_POOL_CONTRACT_ID=C...
NEXT_PUBLIC_VERIFIER_CONTRACT_ID=C...
NEXT_PUBLIC_TOKEN_CONTRACT_ID=C...
```

**Load bridge circuit:**

```bash
# Copy compiled circuit artifacts to public directory
cp circuits/bridge_withdrawal/target/bridge_withdrawal.json \
   frontend/public/circuits/bridge_withdrawal.json
```

**Install dependencies (if needed):**

```bash
cd frontend
npm install  # Bridge utilities are in src/lib/bridge.ts (already created)
```

**UI updates:**

Add bridge withdrawal UI to `frontend/src/app/withdraw/page.tsx`:

```typescript
// TODO: Add this to the withdraw page
const [withdrawalType, setWithdrawalType] = useState<"regular" | "bridge">(
  "regular",
);
const [destinationChain, setDestinationChain] = useState<ChainId | null>(null);
const [destinationAddress, setDestinationAddress] = useState("");

// ... render chain selector and destination input when withdrawalType === "bridge"
```

### 7. Test on Testnet First

**Critical: Test full flow before mainnet:**

```bash
# 1. Deploy everything to testnet
# 2. Deposit test USDC
# 3. Generate bridge withdrawal proof
# 4. Submit via withdraw_bridge
# 5. Verify change note inserted on Stellar
# 6. Track bridge delivery to destination chain
# 7. Confirm funds arrived at destination address
```

**Testnet bridge protocols:**

- Wormhole testnet: Available on Stellar testnet
- CCTP testnet: Check Circle docs for testnet deployments
- Mock bridge: Use `MockBridgeAdapter` from tests for initial verification

### 8. Monitoring and Alerts

Set up monitoring for:

1. **Bridge adapter balance:** Ensure it has enough tokens to fulfill withdrawals
2. **Bridge protocol status:** Watch for outages or delays
3. **Failed deliveries:** Index bridge protocol events for failures
4. **Nullifier consumption:** Track regular vs bridge withdrawal ratio
5. **Destination chain finality:** Monitor for reorgs that could affect deliveries

**Recommended tools:**

- Stellar RPC: Poll `get_commitments_page` for new change notes
- Bridge protocol indexers: Wormhole VAA scanner, CCTP attestation tracker
- Destination chain explorers: Etherscan, Polygonscan, etc.

## Rollback Plan

If bridge feature needs to be disabled:

```bash
# Option 1: Pause adapter (bridge withdrawals fail, regular withdrawals work)
stellar contract invoke \
  --id $BRIDGE_ADAPTER_ID \
  --network mainnet \
  --source $ADMIN_SECRET \
  -- pause

# Option 2: Unset adapter in pool (bridge withdrawals fail with BridgeAdapterNotSet)
stellar contract invoke \
  --id $EXISTING_POOL_ID \
  --network mainnet \
  --source $POOL_ADMIN_SECRET \
  -- set_bridge_adapter \
  --adapter $NULL_ADDRESS  # All-zeros address

# Option 3: Disable specific chains in adapter
stellar contract invoke \
  --id $BRIDGE_ADAPTER_ID \
  --network mainnet \
  --source $ADMIN_SECRET \
  -- configure_bridge \
  --chain 1 \
  --config '{"...", "enabled": false}'
```

**Regular withdrawals are unaffected** by any of these actions.

## Upgrade Path

To update bridge adapter implementation:

```bash
# 1. Deploy new adapter version
stellar contract deploy \
  --wasm bridge_adapter_v2.wasm \
  --network mainnet \
  --source $ADMIN_SECRET

# 2. Initialize new adapter (same as original)
stellar contract invoke --id $NEW_ADAPTER_ID -- initialize ...

# 3. Re-configure all bridge routes on new adapter
stellar contract invoke --id $NEW_ADAPTER_ID -- configure_bridge ...

# 4. Update pool to use new adapter
stellar contract invoke \
  --id $EXISTING_POOL_ID \
  --network mainnet \
  --source $POOL_ADMIN_SECRET \
  -- set_bridge_adapter \
  --adapter $NEW_ADAPTER_ID

# 5. Old adapter is now orphaned (no pool references it)
```

## Common Issues

### Issue: "BridgeAdapterNotSet" after deployment

**Cause:** Admin forgot to call `set_bridge_adapter()` on pool.

**Fix:**

```bash
stellar contract invoke --id $POOL_ID -- set_bridge_adapter --adapter $ADAPTER_ID
```

### Issue: "UnsupportedChain" for Ethereum

**Cause:** Bridge route not configured in adapter.

**Fix:**

```bash
stellar contract invoke --id $ADAPTER_ID -- configure_bridge --chain 1 --config '...'
```

### Issue: Bridge delivery stuck "pending"

**Cause:** Bridge protocol requires manual VAA/attestation submission.

**Fix:**

- **Wormhole:** Retrieve VAA from Guardian API and submit to destination
- **CCTP:** Wait for Circle attestation (automatic, but may take 10-20 mins)
- **Axelar:** Check Axelar network status

### Issue: Frontend proof generation fails

**Cause:** Bridge circuit not loaded or wrong VK.

**Fix:**

1. Verify `public/circuits/bridge_withdrawal.json` exists
2. Check browser console for WASM loading errors
3. Ensure frontend's VK matches deployed verifier

### Issue: "Destination mismatch" on valid proof

**Cause:** Frontend and contract destination hash encoding don't match.

**Fix:**

1. Add test that proves both compute same hash
2. Check byte order (big-endian)
3. Verify padding (right-aligned in 32-byte buffers)
4. Confirm chain ID is included in hash

## Security Considerations

### Pre-Migration Audit

- [ ] External audit of bridge adapter contract
- [ ] Review destination hash encoding (must match circuit)
- [ ] Test nullifier uniqueness across withdrawal types
- [ ] Verify bridge protocol integration (no token approval vulnerabilities)
- [ ] Check admin key security (bridge adapter + pool admin)

### Post-Migration Monitoring

- [ ] Set up alerts for failed bridge deliveries
- [ ] Monitor bridge protocol for exploits/outages
- [ ] Track nullifier consumption (detect unusual patterns)
- [ ] Watch destination chain for reorgs
- [ ] Verify bridge adapter balance (enough to fulfill withdrawals)

## Support

For issues during migration:

1. **Check logs:** Stellar RPC error messages often indicate the exact issue
2. **Run tests:** `cargo test bridge_tests` in pool contract
3. **Testnet first:** Never migrate mainnet without full testnet validation
4. **Documentation:** See `docs/BRIDGE_WITHDRAWALS.md` for detailed explanations
5. **Community:** Ask in Stellar dev channels (Discord, GitHub discussions)

## Estimated Timeline

- **Testnet deployment:** 2-4 hours (assuming bridge protocols available)
- **Testing and validation:** 1-2 days (full deposit → withdraw → delivery cycle)
- **Mainnet deployment:** 1 hour (once tested)
- **User rollout:** Gradual (feature is opt-in, no forced migration)

## Conclusion

Bridge withdrawals are a **non-breaking addition**. Existing users can continue using regular withdrawals indefinitely. New users get the option to exit directly to other chains without an intermediate Stellar step.

The feature is **modular and upgradeable**: bridge adapter can be swapped without redeploying the pool contract, and new chains can be added by simply calling `configure_bridge` with new parameters.
