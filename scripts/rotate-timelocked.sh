#!/usr/bin/env bash
# Queues, waits out the delay for, and executes a timelock-gated admin call
# (pool's set_verifier/propose_admin, compliance's set_disclosure_vk/
# propose_admin) through the deployed governance contract.
#
# Usage:
#   scripts/rotate-timelocked.sh <network> <governance_id> <target_id> <function> [-- <function-args...>]
#
# Example (rotate the pool's verifier):
#   scripts/rotate-timelocked.sh local "$(cat .governance_id)" "$(cat .pool_id)" \
#     set_verifier --verifier CNEWVERIFIER...
#
# Example (set compliance's disclosure VK):
#   scripts/rotate-timelocked.sh local "$(cat .governance_id)" "$(cat .compliance_id)" \
#     set_disclosure_vk --vk_bytes-file-path circuits/disclosure/target/vk
#
# Uses the `alice` identity (the demo admin) to queue and execute; execute is
# actually callable by anyone once the delay has elapsed. This script has been
# exercised against the CLI's documented `--build-only`/`xdr decode`/`xdr
# encode` flags but not against a live network in this environment -- smoke
# test it against `just start && just deploy local` before relying on it.
set -euo pipefail

NETWORK="${1:?network required, e.g. local or testnet}"
GOVERNANCE="${2:?governance contract id required}"
TARGET="${3:?target contract id required}"
FUNCTION="${4:?function name required}"
shift 4
FUNCTION_ARGS=("$@")

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
say() { echo -e "${YELLOW}$1${NC}"; }
ok() { echo -e "  ${GREEN}$1${NC}"; }

say "Building the target call to extract its arguments"
# --build-only writes the unsigned transaction envelope XDR (base64) instead
# of submitting it, which is enough to read back the exact ScVal args the CLI
# encoded for `$FUNCTION` -- reusing the CLI's own arg parsing rather than
# hand-encoding each type ourselves.
TX_XDR=$(stellar contract invoke --id "$TARGET" --source alice --network "$NETWORK" --build-only \
    -- "$FUNCTION" "${FUNCTION_ARGS[@]}")

ARGS_JSON=$(stellar xdr decode --type TransactionEnvelope --input single-base64 --output json <<<"$TX_XDR" \
    | python3 -c '
import json, sys
env = json.load(sys.stdin)
op = env["v1"]["tx"]["operations"][0]["body"]["invoke_host_function"]
args = op["host_function"]["invoke_contract"]["args"]
json.dump(args, sys.stdout)
')

# Re-encode just the args array as an ScVec, which is what governance.queue's
# `args: Bytes` parameter expects (see contracts/governance/src/lib.rs).
ARGS_XDR=$(stellar xdr encode --type ScVec --output single-base64 <<<"$ARGS_JSON")

say "Queuing $FUNCTION on $TARGET via governance $GOVERNANCE"
QUEUE_OUTPUT=$(stellar contract invoke --id "$GOVERNANCE" --source alice --network "$NETWORK" --send=yes \
    -- queue --target "$TARGET" --function "$FUNCTION" --args "$ARGS_XDR")
CALL_ID=$(echo "$QUEUE_OUTPUT" | tail -1)
ok "queued as call #$CALL_ID"

DELAY=$(stellar contract invoke --id "$GOVERNANCE" --source alice --network "$NETWORK" -- get_delay | tail -1)
say "Waiting ${DELAY}s for the timelock delay to elapse..."
sleep "$DELAY"

say "Executing call #$CALL_ID"
stellar contract invoke --id "$GOVERNANCE" --source alice --network "$NETWORK" --send=yes \
    -- execute --id "$CALL_ID" >/dev/null
ok "$FUNCTION executed on $TARGET"
