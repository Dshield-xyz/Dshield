set dotenv-load

export PATH := env("HOME") + "/.bb:" + env("HOME") + "/.nargo/bin:" + env("PATH")
export STELLAR_NETWORK := env("STELLAR_NETWORK", "local")

default:
    @just --list

# Check all dependencies are installed
setup:
    @echo "Checking dependencies..."
    @nargo --version
    @bb --version
    @stellar --version | head -1
    @just --version
    @rustup target list --installed | grep wasm
    @echo "All dependencies OK."

# Start Stellar localnet with Protocol 26 (future) and unlimited resource limits
start:
    stellar container start -t future --name stellar-local --limits unlimited
    @echo "Waiting for RPC to become healthy..."
    @until curl -s http://localhost:8000/soroban/rpc -X POST -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"status"'; do sleep 3; done
    @echo "Localnet ready at http://localhost:8000"

# Stop Stellar localnet
stop:
    stellar container stop stellar-local 2>/dev/null || true

# Fund the deployer account on localnet
fund:
    stellar keys generate alice --network local 2>/dev/null || true
    @echo "Account funded."

# Compile all Noir circuits and generate VKs
build-circuits:
    @echo "Building shielded_pool circuit..."
    cd circuits/shielded_pool && nargo compile
    cd circuits/shielded_pool && bb write_vk --scheme ultra_honk --oracle_hash keccak --bytecode_path target/shielded_pool.json --output_path target --output_format bytes_and_fields
    @echo "Building compliance circuit..."
    cd circuits/compliance && nargo compile
    cd circuits/compliance && bb write_vk --scheme ultra_honk --oracle_hash keccak --bytecode_path target/compliance.json --output_path target --output_format bytes_and_fields
    @echo "Building disclosure circuit..."
    cd circuits/disclosure && nargo compile
    cd circuits/disclosure && bb write_vk --scheme ultra_honk --oracle_hash keccak --bytecode_path target/disclosure.json --output_path target --output_format bytes_and_fields
    @echo "Building view_disclosure circuit..."
    cd circuits/view_disclosure && nargo compile
    cd circuits/view_disclosure && bb write_vk --scheme ultra_honk --oracle_hash keccak --bytecode_path target/view_disclosure.json --output_path target --output_format bytes_and_fields
    @just sync-circuits
    @echo "All circuits built."

# Copy freshly compiled circuits to the clients that prove against them.
#
# The app and the CLI ship their own copy of the circuit bytecode (they can't
# read circuits/*/target at runtime), so a compile that isn't copied leaves them
# proving against an older circuit than the one the deployed verifier's VK was
# built from. That failure is silent until a withdrawal is attempted, and it is
# exactly what happened between the multi-asset/relayer-fee work and this
# recipe existing: the clients were still on a 12-input circuit while the
# contract expected 14. `just verify-circuit-sync` fails CI if they drift again.
sync-circuits:
    #!/usr/bin/env bash
    set -euo pipefail
    for c in shielded_pool compliance disclosure view_disclosure hasher; do
        src="circuits/$c/target/$c.json"
        [ -f "$src" ] || continue
        cp "$src" "frontend/src/circuits/$c.json"
        [ -f "packages/core/src/circuits/$c.json" ] && cp "$src" "packages/core/src/circuits/$c.json"
        echo "  synced $c"
    done

# Fail if a client's circuit copy differs from the compiled artifact.
verify-circuit-sync:
    #!/usr/bin/env bash
    set -euo pipefail
    status=0
    for c in shielded_pool compliance disclosure view_disclosure hasher; do
        src="circuits/$c/target/$c.json"
        [ -f "$src" ] || continue
        for dest in "frontend/src/circuits/$c.json" "packages/core/src/circuits/$c.json"; do
            [ -f "$dest" ] || continue
            if ! cmp -s "$src" "$dest"; then
                echo "STALE: $dest differs from $src — run 'just sync-circuits'"
                status=1
            fi
        done
    done
    [ $status -eq 0 ] && echo "All client circuit copies match the compiled artifacts."
    exit $status

# Generate a test proof from the shielded_pool circuit
prove-pool:
    cd circuits/shielded_pool && nargo execute
    cd circuits/shielded_pool && bb prove --scheme ultra_honk --oracle_hash keccak --bytecode_path target/shielded_pool.json --witness_path target/shielded_pool.gz --output_path target --output_format bytes_and_fields
    @echo "Pool proof generated."

# Generate a test proof from the compliance circuit
prove-compliance:
    cd circuits/compliance && nargo execute
    cd circuits/compliance && bb prove --scheme ultra_honk --oracle_hash keccak --bytecode_path target/compliance.json --witness_path target/compliance.gz --output_path target --output_format bytes_and_fields
    @echo "Compliance proof generated."

# Verify pool proof locally (off-chain)
verify-pool:
    cd circuits/shielded_pool && bb verify -s ultra_honk --oracle_hash keccak -k target/vk -p target/proof -i target/public_inputs
    @echo "Pool proof verified."

# Generate a test proof from the disclosure circuit
prove-disclosure:
    cd circuits/disclosure && nargo execute
    cd circuits/disclosure && bb prove --scheme ultra_honk --oracle_hash keccak --bytecode_path target/disclosure.json --witness_path target/disclosure.gz --output_path target --output_format bytes_and_fields
    @echo "Disclosure proof generated."

# Verify compliance proof locally (off-chain)
verify-compliance:
    cd circuits/compliance && bb verify -s ultra_honk --oracle_hash keccak -k target/vk -p target/proof -i target/public_inputs
    @echo "Compliance proof verified."

# Verify disclosure proof locally (off-chain)
verify-disclosure:
    cd circuits/disclosure && bb verify -s ultra_honk --oracle_hash keccak -k target/vk -p target/proof -i target/public_inputs
    @echo "Disclosure proof verified."

# Generate a test proof from the view_disclosure circuit
prove-view-disclosure:
    cd circuits/view_disclosure && nargo execute
    cd circuits/view_disclosure && bb prove --scheme ultra_honk --oracle_hash keccak --bytecode_path target/view_disclosure.json --witness_path target/view_disclosure.gz --output_path target --output_format bytes_and_fields
    @echo "View-disclosure proof generated."

# Verify view_disclosure proof locally (off-chain)
verify-view-disclosure:
    cd circuits/view_disclosure && bb verify -s ultra_honk --oracle_hash keccak -k target/vk -p target/proof -i target/public_inputs
    @echo "View-disclosure proof verified."

# Build Soroban contract WASM binaries
build-contracts:
    stellar contract build
    @echo "Contracts built:"
    @ls -la target/wasm32v1-none/release/*.wasm

# Build everything (circuits + contracts)
build: build-circuits build-contracts

# Deploy all contracts to the network
# Deploy all contracts. Pass `testnet` to target Stellar testnet, e.g.
# `just deploy testnet`; defaults to the local quickstart network.
deploy network="local": build
    #!/usr/bin/env bash
    set -euo pipefail

    NETWORK="{{network}}"
    if [ "$NETWORK" = "testnet" ]; then
        RPC_URL="https://soroban-testnet.stellar.org"
        PASSPHRASE="Test SDF Network ; September 2015"
        FRIENDBOT="https://friendbot.stellar.org/?addr="
        # Make sure the CLI knows the testnet network (idempotent).
        stellar network add testnet --rpc-url "$RPC_URL" \
            --network-passphrase "$PASSPHRASE" 2>/dev/null || true
    else
        RPC_URL="http://localhost:8000/soroban/rpc"
        PASSPHRASE="Standalone Network ; February 2017"
        FRIENDBOT="http://localhost:8000/friendbot?addr="
    fi
    echo "Deploying to network: $NETWORK"

    # Ensure the deployer + issuer + relayer exist and are funded (friendbot is
    # idempotent). On testnet this funds via the public friendbot. The relayer
    # submits withdrawals on users' behalf so their accounts stay off-chain.
    stellar keys generate alice --network "$NETWORK" 2>/dev/null || true
    stellar keys generate usdc-issuer --network "$NETWORK" 2>/dev/null || true
    stellar keys generate relayer --network "$NETWORK" 2>/dev/null || true
    ALICE_ADDR=$(stellar keys address alice)
    ISSUER_ADDR=$(stellar keys address usdc-issuer)
    RELAYER_ADDR=$(stellar keys address relayer)
    curl -s "${FRIENDBOT}${ALICE_ADDR}" >/dev/null 2>&1 || true
    curl -s "${FRIENDBOT}${ISSUER_ADDR}" >/dev/null 2>&1 || true
    curl -s "${FRIENDBOT}${RELAYER_ADDR}" >/dev/null 2>&1 || true

    echo "Deploying verifier contract..."
    VERIFIER_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_verifier.wasm \
        --source alice \
        --network "$NETWORK" \
        -- \
        --vk_bytes-file-path circuits/shielded_pool/target/vk)
    echo "Verifier deployed: $VERIFIER_ID"
    echo "$VERIFIER_ID" > .verifier_id

    echo "Deploying governance (timelock) contract..."
    # Delay before a queued verifier/admin/VK change becomes executable. Short
    # on local so the demo doesn't have to wait a day; a real deployment
    # should use something like 86400 (1 day) or longer.
    TIMELOCK_DELAY="${TIMELOCK_DELAY:-60}"
    GOVERNANCE_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_governance.wasm \
        --source alice \
        --network "$NETWORK" \
        -- \
        --admin "$ALICE_ADDR" \
        --delay_seconds "$TIMELOCK_DELAY")
    echo "Governance deployed: $GOVERNANCE_ID (delay: ${TIMELOCK_DELAY}s)"
    echo "$GOVERNANCE_ID" > .governance_id

    echo "Deploying USDC test token..."
    # Use a SEPARATE issuer so the deployer (alice) is a normal holder. A SAC
    # cannot mint to its own issuer ("operation invalid on issuer"), so alice
    # must not be the issuer.
    # The SAC address is deterministic; deploying an already-deployed asset
    # errors, so derive the id and only deploy if it isn't there yet. Deploy
    # from alice (already funded) — SAC deployment is permissionless and the
    # admin still becomes the issuer.
    TOKEN_ID=$(stellar contract id asset --asset "USDC:$ISSUER_ADDR" --network "$NETWORK" 2>&1 | tail -1)
    if ! stellar contract invoke --id "$TOKEN_ID" --source alice --network "$NETWORK" -- name >/dev/null 2>&1; then
        stellar contract asset deploy --asset "USDC:$ISSUER_ADDR" --source alice --network "$NETWORK" >/dev/null 2>&1
    fi
    echo "USDC token: $TOKEN_ID"
    echo "$TOKEN_ID" > .token_id

    echo "Establishing deployer trustline to USDC..."
    # Classic assets require a trustline before an account can hold them.
    stellar tx new change-trust --source alice --line "USDC:$ISSUER_ADDR" --network "$NETWORK" >/dev/null 2>&1 || true

    echo "Minting USDC to deployer..."
    stellar contract invoke --id "$TOKEN_ID" --source usdc-issuer --network "$NETWORK" --send=yes \
        -- mint --to "$ALICE_ADDR" --amount 10000000000000 > /dev/null 2>&1
    echo "Deployer funded with 1,000,000 USDC"

    echo "Deploying shielded pool..."
    # One pool, no denomination. Notes carry their own value, so every amount
    # shares a single anonymity set instead of being split across tiers.
    POOL_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_pool.wasm \
        --source alice --network "$NETWORK" \
        -- --verifier "$VERIFIER_ID" --token "$TOKEN_ID" --admin "$ALICE_ADDR" --timelock "$GOVERNANCE_ID")
    echo "Pool: $POOL_ID"

    echo "$POOL_ID" > .pool_id

    ADMIN_ADDR=$ALICE_ADDR

    echo "Deploying compliance contract..."
    # pools: the pool addresses the compliance contract cross-references to
    # confirm a proof's merkle_root is a state one of our pools actually
    # reached. The amount itself is bound inside the note's leaf and proved by
    # the circuit, so nothing here has to reconstruct it.
    COMPLIANCE_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_compliance.wasm \
        --source alice \
        --network "$NETWORK" \
        -- \
        --vk_bytes-file-path circuits/compliance/target/vk \
        --admin "$ADMIN_ADDR" \
        --pools "[\"$POOL_ID\"]" \
        --timelock "$GOVERNANCE_ID")
    echo "Compliance deployed: $COMPLIANCE_ID"
    echo "$COMPLIANCE_ID" > .compliance_id

    echo "Setting disclosure VK on compliance contract (via timelock)..."
    # set_disclosure_vk is gated behind governance now: queue, wait out the
    # delay, then execute. See scripts/rotate-timelocked.sh for the same flow
    # used to change the verifier or rotate admins after deployment.
    bash scripts/rotate-timelocked.sh "$NETWORK" "$GOVERNANCE_ID" "$COMPLIANCE_ID" \
        set_disclosure_vk --vk_bytes-file-path circuits/disclosure/target/vk
    echo "Disclosure VK set."

    echo "Setting view-disclosure VK on compliance contract..."
    stellar contract invoke --id "$COMPLIANCE_ID" --source alice --network "$NETWORK" --send=yes \
        -- set_view_vk --vk_bytes-file-path circuits/view_disclosure/target/vk >/dev/null
    echo "View-disclosure VK set."

    echo "Writing frontend/.env.local..."
    # Use alice as the dev wallet so the app deposits from the account that
    # holds USDC + the trustline. Throwaway key (local/testnet only).
    ISSUER_SECRET=$(stellar keys show usdc-issuer 2>/dev/null || stellar keys secret usdc-issuer 2>/dev/null || true)
    RELAYER_SECRET=$(stellar keys show relayer 2>/dev/null || stellar keys secret relayer 2>/dev/null || true)
    ADMIN_SECRET=$(stellar keys show alice 2>/dev/null || stellar keys secret alice 2>/dev/null || true)
    # Shared secret required as the x-admin-key header on /api/register-kyc
    # (that route grants "KYC verified" status, so it must not be callable by
    # an arbitrary visitor). Reused across redeploys if already set.
    KYC_ADMIN_API_KEY=$(grep -m1 '^KYC_ADMIN_API_KEY=' frontend/.env.local 2>/dev/null | cut -d= -f2- || true)
    [ -n "$KYC_ADMIN_API_KEY" ] || KYC_ADMIN_API_KEY=$(openssl rand -hex 24)
    # Only inject the dev secret key for local deployments (auto-connects a
    # funded wallet). For testnet/production, users connect via Freighter.
    if [ "$NETWORK" = "local" ]; then
        ALICE_SECRET=$(stellar keys show alice 2>/dev/null || stellar keys secret alice 2>/dev/null || true)
        DEV_KEY_LINE="NEXT_PUBLIC_DEV_SECRET_KEY=$ALICE_SECRET"
    else
        DEV_KEY_LINE="NEXT_PUBLIC_DEV_SECRET_KEY="
    fi
    cat > frontend/.env.local <<EOF
    NEXT_PUBLIC_RPC_URL=$RPC_URL
    NEXT_PUBLIC_NETWORK_PASSPHRASE=$PASSPHRASE
    $DEV_KEY_LINE
    NEXT_PUBLIC_USDC_CODE=USDC
    NEXT_PUBLIC_USDC_ISSUER=$ISSUER_ADDR
    USDC_ISSUER_SECRET=$ISSUER_SECRET
    RELAYER_SECRET=$RELAYER_SECRET
    COMPLIANCE_ADMIN_SECRET=$ADMIN_SECRET
    KYC_ADMIN_API_KEY=$KYC_ADMIN_API_KEY
    NEXT_PUBLIC_POOL_CONTRACT_ID=$POOL_ID
    NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID=$COMPLIANCE_ID
    NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=$GOVERNANCE_ID
    EOF
    # Strip the leading indentation the recipe block adds.
    sed -i 's/^    //' frontend/.env.local
    echo "Frontend env updated. Restart the dev server to pick up new contract IDs."

# Deploy to Stellar mainnet.
#
# Deliberately a separate recipe rather than `deploy mainnet`: almost
# everything `deploy` does is wrong with real money at stake. It generates and
# funds keys from a friendbot that doesn't exist on pubnet, issues a test USDC
# it controls the issuer of, mints a million of them, and writes every one of
# those secrets into frontend/.env.local. None of that happens here.
#
# What this recipe will NOT do, on purpose: create keys, fund accounts, issue
# or mint an asset, or write a secret to disk. Everything it needs is supplied
# by the operator, and nothing it produces can spend anything.
#
# Required environment:
#   DEPLOYER            name of an already-funded `stellar keys` identity
#   POOL_ADMIN          G… or C… that will hold admin on pool + compliance.
#                       Use a multisig or the governance contract, not a
#                       single hot key.
#   POOL_ASSETS         comma-separated SEP-41 contract ids (C…) to allow-list.
#                       The first becomes the pool's initial asset. Use
#                       `just asset-id native` / `just asset-id USDC:G…` to
#                       derive them.
#   CONFIRM=deploy-mainnet   explicit acknowledgement; the recipe refuses
#                            without it, so a stray shell-history entry can't
#                            spend real XLM.
# Optional:
#   TIMELOCK_DELAY      seconds before a queued governance change executes
#                       (default 86400 — one day)
deploy-mainnet: build
    #!/usr/bin/env bash
    set -euo pipefail

    NETWORK=mainnet
    RPC_URL="${RPC_URL:-https://mainnet.sorobanrpc.com}"
    PASSPHRASE="Public Global Stellar Network ; September 2015"

    if [ "${CONFIRM:-}" != "deploy-mainnet" ]; then
        echo "Refusing to deploy to mainnet without CONFIRM=deploy-mainnet." >&2
        echo "This spends real XLM and publishes contracts that will hold real funds." >&2
        exit 1
    fi
    : "${DEPLOYER:?set DEPLOYER to a funded stellar keys identity}"
    : "${POOL_ADMIN:?set POOL_ADMIN to the address that should hold admin}"
    : "${POOL_ASSETS:?set POOL_ASSETS to comma-separated SEP-41 contract ids}"
    TIMELOCK_DELAY="${TIMELOCK_DELAY:-86400}"

    stellar network add mainnet --rpc-url "$RPC_URL" \
        --network-passphrase "$PASSPHRASE" 2>/dev/null || true

    PRIMARY_ASSET="${POOL_ASSETS%%,*}"
    DEPLOYER_ADDR=$(stellar keys address "$DEPLOYER")
    echo "Deployer:  $DEPLOYER_ADDR"
    echo "Admin:     $POOL_ADMIN"
    echo "Assets:    $POOL_ASSETS"
    echo "Timelock:  ${TIMELOCK_DELAY}s"
    echo

    echo "Deploying verifier…"
    VERIFIER_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_verifier.wasm \
        --source "$DEPLOYER" --network "$NETWORK" \
        -- --vk_bytes-file-path circuits/shielded_pool/target/vk)
    echo "  $VERIFIER_ID"

    echo "Deploying governance (timelock)…"
    GOVERNANCE_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_governance.wasm \
        --source "$DEPLOYER" --network "$NETWORK" \
        -- --admin "$POOL_ADMIN" --delay_seconds "$TIMELOCK_DELAY")
    echo "  $GOVERNANCE_ID"

    echo "Deploying pool…"
    POOL_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_pool.wasm \
        --source "$DEPLOYER" --network "$NETWORK" \
        -- --verifier "$VERIFIER_ID" --token "$PRIMARY_ASSET" \
           --admin "$POOL_ADMIN" --timelock "$GOVERNANCE_ID")
    echo "  $POOL_ID"

    # Allow-list the remaining assets. The first is already registered by the
    # constructor, so it is skipped rather than re-added (add_asset is
    # idempotent, but a no-op transaction still costs a fee).
    IFS=',' read -ra ASSET_LIST <<< "$POOL_ASSETS"
    for asset in "${ASSET_LIST[@]:1}"; do
        echo "Allow-listing $asset…"
        stellar contract invoke --id "$POOL_ID" --source "$DEPLOYER" \
            --network "$NETWORK" --send=yes -- add_asset --asset "$asset" >/dev/null
    done

    echo "Deploying compliance…"
    COMPLIANCE_ID=$(stellar contract deploy \
        --wasm target/wasm32v1-none/release/dshield_compliance.wasm \
        --source "$DEPLOYER" --network "$NETWORK" \
        -- --vk_bytes-file-path circuits/compliance/target/vk \
           --admin "$POOL_ADMIN" --pools "[\"$POOL_ID\"]" --timelock "$GOVERNANCE_ID")
    echo "  $COMPLIANCE_ID"

    # Written to its own file, never frontend/.env.local: that file is what the
    # dev server reads, and a mainnet pool id landing there would point a
    # development build at real funds. It carries no secrets — the relayer and
    # KYC-admin keys are the operator's to supply in their deployment
    # environment, not this recipe's to generate.
    cat > .env.mainnet <<EOF
    NEXT_PUBLIC_RPC_URL=$RPC_URL
    NEXT_PUBLIC_NETWORK_PASSPHRASE=$PASSPHRASE
    NEXT_PUBLIC_POOL_CONTRACT_ID=$POOL_ID
    NEXT_PUBLIC_COMPLIANCE_CONTRACT_ID=$COMPLIANCE_ID
    NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=$GOVERNANCE_ID
    EOF
    sed -i 's/^    //' .env.mainnet

    echo
    echo "Deployed. Wrote .env.mainnet (no secrets)."
    echo
    echo "Before this serves real users:"
    echo "  1. just verify-deployment mainnet $VERIFIER_ID $COMPLIANCE_ID"
    echo "     — confirms the on-chain VKs match these circuits."
    echo "  2. Confirm admin is a multisig/timelock, not one key:  $POOL_ADMIN"
    echo "  3. Supply RELAYER_SECRET and KYC_ADMIN_API_KEY in the deployment"
    echo "     environment. Leave NEXT_PUBLIC_DEV_SECRET_KEY unset — it is"
    echo "     inlined into the client bundle and ignored on mainnet anyway."
    echo "  4. The faucet route refuses to run on mainnet; there is no on-ramp"
    echo "     for test funds by design."
    echo "  5. Get a third-party audit. Nothing here substitutes for one."

# Derive a SEP-41 contract id for a classic asset, for POOL_ASSETS.
# e.g. `just asset-id native mainnet`, `just asset-id USDC:GA5Z… mainnet`
asset-id asset network="mainnet":
    @stellar contract id asset --asset "{{asset}}" --network "{{network}}"

# Check that the VKs a deployment actually verifies against are the ones these
# circuits build to.
#
# This is the link nothing else checks: the contracts, the circuits and the
# clients can each be self-consistent while the deployed verifier still holds
# the verification key of an older circuit, and the only symptom is that every
# withdrawal fails. Run it after any deploy, and after any circuit change.
verify-deployment network verifier_id compliance_id="":
    #!/usr/bin/env bash
    set -euo pipefail
    status=0

    check() {
        local label="$1" contract="$2" method="$3" local_vk="$4"
        local onchain
        onchain=$(stellar contract invoke --id "$contract" --network "{{network}}" \
            --source-account "${DEPLOYER:-alice}" -- "$method" 2>/dev/null \
            | tr -d '"' | tr -d '\n')
        local expected
        expected=$(xxd -p -c 100000 "$local_vk")
        if [ "$onchain" = "$expected" ]; then
            echo "OK    $label VK matches $local_vk"
        else
            echo "STALE $label VK differs from $local_vk" >&2
            status=1
        fi
    }

    check "pool verifier" "{{verifier_id}}" get_vk circuits/shielded_pool/target/vk
    if [ -n "{{compliance_id}}" ]; then
        check "compliance" "{{compliance_id}}" get_vk circuits/compliance/target/vk
    fi

    just verify-circuit-sync
    exit $status

# Run the full end-to-end pipeline on localnet
e2e: start fund deploy
    @echo "End-to-end pipeline complete."

# Demo the privacy loop on-chain: deposit -> ZK proof -> relayed withdraw.
# Run against the active deployment; needs a freshly deployed pool.
# e.g. `just deploy testnet && just demo testnet`
demo network="local":
    bash scripts/demo.sh {{network}}

# Demo the compliant-disclosure loop on-chain: register KYC -> ZK proof ->
# verify_compliance, plus a negative KYC-gate check. e.g. `just demo-compliance testnet`
demo-compliance network="local":
    bash scripts/demo-compliance.sh {{network}}

# Demo multi-asset on-chain: allow-list native XLM on a pool deployed with
# USDC, shield XLM, spend part of it, and check that the same proof is refused
# when it asks for a USDC payout. Unlike `just demo` this doesn't need a fresh
# pool, so it can run straight after it.
demo-multi-asset network="local":
    bash scripts/demo-multi-asset.sh {{network}}

# Run contract unit tests
test-contracts:
    cargo test --workspace

# Run frontend unit tests
test-frontend:
    cd frontend && pnpm test

# Build the shared tree/RPC package and the standalone indexer service
build-indexer-service:
    cd packages/core && npm install && npm run build
    cd services/indexer && npm install && npm run build

# Run standalone indexer service (and shared package) unit tests
test-indexer-service: build-indexer-service
    cd packages/core && npm test
    cd services/indexer && npm test

# Run all unit tests
#
# verify-circuit-sync runs first and is cheap: a client shipping a different
# circuit than the one the deployed VK was built from makes every withdrawal
# fail, and no unit test can see it — they all exercise the same stale copy.
test: verify-circuit-sync test-contracts test-frontend test-indexer-service

# Run the formal/symbolic circuit specification harness
verify-circuits:
    node scripts/verify-circuits.mjs --self-test

# Run E2E integration tests
test-e2e:
    ./tests/e2e.sh

# Clean up artifacts and containers
clean:
    stellar container stop stellar-local 2>/dev/null || true
    rm -f .verifier_id .pool_id .compliance_id .governance_id
    rm -rf circuits/shielded_pool/target circuits/compliance/target circuits/disclosure/target
    @echo "Cleaned."
