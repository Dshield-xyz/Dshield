#!/usr/bin/env bash
# End-to-end test: deploy contracts, deposit, withdraw, compliance
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_ROOT"

export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass=0
fail=0

ok() {
  echo -e "  ${GREEN}PASS${NC} $1"
  pass=$((pass + 1))
}

err() {
  echo -e "  ${RED}FAIL${NC} $1: $2"
  fail=$((fail + 1))
}

section() {
  echo -e "\n${YELLOW}=== $1 ===${NC}"
}

# ─── Prerequisites ───
section "Checking prerequisites"

command -v stellar >/dev/null || { echo "stellar CLI not found"; exit 1; }
command -v nargo >/dev/null || { echo "nargo not found"; exit 1; }
command -v bb >/dev/null || { echo "bb not found"; exit 1; }
ok "CLI tools available"

# ─── Start localnet ───
section "Starting Stellar localnet"

stellar container stop stellar-local 2>/dev/null || true
docker rm stellar-stellar-local 2>/dev/null || true
stellar container start -t future --name stellar-local --limits unlimited

echo "Waiting for RPC..."
until curl -s http://localhost:8000/soroban/rpc \
  -X POST -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' 2>/dev/null | grep -q '"status"'; do
  sleep 3
done
ok "Localnet running"

# ─── Fund account ───
section "Funding test account"

stellar keys rm e2e-test 2>/dev/null || true
stellar keys generate e2e-test --network local
E2E_ADDR=$(stellar keys address e2e-test)

# RPC's getHealth can go green before Horizon (and friendbot, which sits
# behind it) has finished spinning up / syncing from genesis - especially
# on the `future` quickstart image. Hitting friendbot before Horizon is
# ingesting just yields 502s, so wait for Horizon to report a real ledger
# before even trying to fund.
echo "Waiting for Horizon to come up..."
for i in $(seq 1 60); do
  LEDGER=$(curl -s http://localhost:8000/ 2>/dev/null | grep -o '"history_latest_ledger":[0-9]*' | grep -o '[0-9]*$')
  [[ -n "$LEDGER" && "$LEDGER" -gt 0 ]] && break
  sleep 3
done

# Fund via friendbot. Trust friendbot's HTTP status (200 = funded; "already
# funded" also counts) rather than parsing its JSON body or Horizon, whose
# availability/shape vary by quickstart image. On failure, surface the last
# response for debugging.
FUNDED=0
CODE=000
FB_BODY=/tmp/friendbot_resp.json
for i in $(seq 1 40); do
  # Preferred: let the CLI fund via the network's configured friendbot.
  if stellar keys fund e2e-test --network local >/dev/null 2>&1; then
    FUNDED=1
    break
  fi
  # Fallback: hit friendbot directly and trust its HTTP status.
  CODE=$(curl -s -o "$FB_BODY" -w '%{http_code}' "http://localhost:8000/friendbot?addr=$E2E_ADDR" || echo 000)
  if [[ "$CODE" == "200" ]] || grep -qiE 'already.*fund|op_already_exists|already.*exist' "$FB_BODY" 2>/dev/null; then
    FUNDED=1
    break
  fi
  sleep 3
done
if [[ "$FUNDED" == "1" ]]; then
  ok "Account funded: ${E2E_ADDR:0:10}..."
else
  err "Funding" "friendbot failed (last http=$CODE): $(head -c 300 "$FB_BODY" 2>/dev/null)"
  echo -e "${RED}Cannot continue without a funded account - stopping here instead of cascading into deploy failures.${NC}"
  stellar container stop stellar-local 2>/dev/null || true
  exit 1
fi

# ─── Build circuits ───
section "Building circuits"

cd circuits/shielded_pool && nargo compile 2>&1 && cd "$PROJECT_ROOT"
bb write_vk --scheme ultra_honk --oracle_hash keccak \
  --bytecode_path circuits/shielded_pool/target/shielded_pool.json \
  --output_path circuits/shielded_pool/target --output_format bytes_and_fields 2>&1
ok "Shielded pool circuit compiled"

cd circuits/compliance && nargo compile 2>&1 && cd "$PROJECT_ROOT"
bb write_vk --scheme ultra_honk --oracle_hash keccak \
  --bytecode_path circuits/compliance/target/compliance.json \
  --output_path circuits/compliance/target --output_format bytes_and_fields 2>&1
ok "Compliance circuit compiled"

cd circuits/hasher && nargo compile 2>&1 && cd "$PROJECT_ROOT"
ok "Hasher circuit compiled"

# ─── Build contracts ───
section "Building contracts"

stellar contract build 2>&1
ok "Contracts built"

# ─── Deploy token ───
section "Deploying token"

TOKEN_ID=$(stellar contract asset deploy \
  --asset native \
  --source e2e-test --network local 2>&1 | tail -1)
ok "Native XLM SAC token: ${TOKEN_ID:0:12}..."

DEPOSIT_AMOUNT=10000000  # 1 XLM in stroops

# ─── Deploy contracts ───
section "Deploying contracts"

VERIFIER_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/dshield_verifier.wasm \
  --source e2e-test --network local \
  -- --vk_bytes-file-path circuits/shielded_pool/target/vk)
ok "Verifier deployed: ${VERIFIER_ID:0:12}..."

POOL_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/dshield_pool.wasm \
  --source e2e-test --network local \
  -- --verifier "$VERIFIER_ID" --token "$TOKEN_ID" --deposit_amount "$DEPOSIT_AMOUNT" --admin "$E2E_ADDR")
ok "Pool deployed: ${POOL_ID:0:12}..."

COMPLIANCE_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/dshield_compliance.wasm \
  --source e2e-test --network local \
  -- --vk_bytes-file-path circuits/compliance/target/vk --admin "$E2E_ADDR" --pools "[\"$POOL_ID\"]")
ok "Compliance deployed: ${COMPLIANCE_ID:0:12}..."

# ─── Test: get_next_index starts at 0 ───
section "Contract state tests"

IDX=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local -- get_next_index 2>&1 | tail -1)
[[ "$IDX" == "0" ]] && ok "get_next_index == 0" || err "get_next_index" "expected 0, got $IDX"

DEP_AMT=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local -- get_deposit_amount 2>&1 | tail -1)
DEP_AMT="${DEP_AMT%\"}"
DEP_AMT="${DEP_AMT#\"}"
[[ "$DEP_AMT" == "$DEPOSIT_AMOUNT" ]] && ok "get_deposit_amount == $DEPOSIT_AMOUNT" || err "get_deposit_amount" "expected $DEPOSIT_AMOUNT, got $DEP_AMT"

# ─── Test: deposit ───
section "Deposit test"

COMMITMENT=$(printf '%064d' 12345)
DEPOSIT_RESULT=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local --send=yes \
  -- deposit --depositor "$E2E_ADDR" --commitment "$COMMITMENT" 2>&1 | tail -1)
[[ "$DEPOSIT_RESULT" == "0" ]] && ok "Deposit returned index 0" || err "Deposit" "expected 0, got $DEPOSIT_RESULT"

IDX=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local -- get_next_index 2>&1 | tail -1)
[[ "$IDX" == "1" ]] && ok "get_next_index == 1 after deposit" || err "get_next_index" "expected 1, got $IDX"

ROOT=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local -- get_root 2>&1 | tail -1)
[[ -n "$ROOT" && "$ROOT" != "null" ]] && ok "Merkle root exists" || err "get_root" "no root found"

# ─── Test: duplicate deposit fails ───
section "Duplicate deposit test"

DUP_RESULT=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local --send=yes \
  -- deposit --depositor "$E2E_ADDR" --commitment "$COMMITMENT" 2>&1 || true)
echo "$DUP_RESULT" | grep -qi "error\|fail\|CommitmentExists" && ok "Duplicate deposit rejected" || err "Duplicate deposit" "should have failed"

# ─── Test: nullifier not used ───
section "Nullifier tests"

NULL_HASH=$(printf '%064d' 99999)
IS_USED=$(stellar contract invoke --id "$POOL_ID" --source e2e-test --network local \
  -- is_nullifier_used --nullifier_hash "$NULL_HASH" 2>&1 | tail -1)
[[ "$IS_USED" == "false" ]] && ok "Nullifier not used" || err "is_nullifier_used" "expected false, got $IS_USED"

# ─── Test: KYC registration ───
section "Compliance tests"

KYC_HASH=$(printf '%064d' 77777)
KYC_RESULT=$(stellar contract invoke --id "$COMPLIANCE_ID" --source e2e-test --network local --send=yes \
  -- register_kyc --kyc_hash "$KYC_HASH" 2>&1 || true)
echo "$KYC_RESULT" | grep -qvi "error" && ok "KYC registered" || err "register_kyc" "$KYC_RESULT"

IS_REG=$(stellar contract invoke --id "$COMPLIANCE_ID" --source e2e-test --network local \
  -- is_kyc_registered --kyc_hash "$KYC_HASH" 2>&1 | tail -1)
[[ "$IS_REG" == "true" ]] && ok "KYC hash is registered" || err "is_kyc_registered" "expected true, got $IS_REG"

UNKNOWN_HASH=$(printf '%064d' 88888)
IS_REG2=$(stellar contract invoke --id "$COMPLIANCE_ID" --source e2e-test --network local \
  -- is_kyc_registered --kyc_hash "$UNKNOWN_HASH" 2>&1 | tail -1)
[[ "$IS_REG2" == "false" ]] && ok "Unknown KYC hash returns false" || err "is_kyc_registered unknown" "expected false, got $IS_REG2"

# ─── Test: Full proof generation and verification ───
section "ZK proof generation test"

# Use known test values: nullifier=1234, secret=5678
# Circuit now has 3 public inputs: root, nullifier_hash, recipient
cd circuits/shielded_pool
cat > Prover.toml << 'TOML'
nullifier = "1234"
secret = "5678"
root = "0x10aea39ac00016e6011dbfcfa33b700d3951b3a2186fa72252e6343b18e1d293"
nullifier_hash = "0x188176ced46ba650f1f749ae68e5d688b11a7acb510335d2da255448167aa9fc"
recipient = "42"
path_bits = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
path_siblings = [
    "0x00",
    "0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1",
    "0x0e34ac2c09f45a503d2908bcb12f1cbae5fa4065759c88d501c097506a8b2290",
    "0x21f9172d72fdcdafc312eee05cf5092980dda821da5b760a9fb8dbdf607c8a20",
    "0x2373ea368857ec7af97e7b470d705848e2bf93ed7bef142a490f2119bcf82d8e",
    "0x120157cfaaa49ce3da30f8b47879114977c24b266d58b0ac18b325d878aafddf",
    "0x01c28fe1059ae0237b72334700697bdf465e03df03986fe05200cadeda66bd76",
    "0x2d78ed82f93b61ba718b17c2dfe5b52375b4d37cbbed6f1fc98b47614b0cf21b",
    "0x067243231eddf4222f3911defbba7705aff06ed45960b27f6f91319196ef97e1",
    "0x1849b85f3c693693e732dfc4577217acc18295193bede09ce8b97ad910310972",
    "0x2a775ea761d20435b31fa2c33ff07663e24542ffb9e7b293dfce3042eb104686",
    "0x0f320b0703439a8114f81593de99cd0b8f3b9bf854601abb5b2ea0e8a3dda4a7",
    "0x0d07f6e7a8a0e9199d6d92801fff867002ff5b4808962f9da2ba5ce1bdd26a73",
    "0x1c4954081e324939350febc2b918a293ebcdaead01be95ec02fcbe8d2c1635d1",
    "0x0197f2171ef99c2d053ee1fb5ff5ab288d56b9b41b4716c9214a4d97facc4c4a",
    "0x2b9cdd484c5ba1e4d6efcc3f18734b5ac4c4a0b9102e2aeb48521a661d3feee9",
    "0x14f44d672eb357739e42463497f9fdac46623af863eea4d947ca00a497dcdeb3",
    "0x071d7627ae3b2eabda8a810227bf04206370ac78dbf6c372380182dbd3711fe3",
    "0x2fdc08d9fe075ac58cb8c00f98697861a13b3ab6f9d41a4e768f75e477475bf5",
    "0x20165fe405652104dceaeeca92950aa5adc571b8cafe192878cba58ff1be49c5",
]
TOML

# Remove any stale witness/proof first: without this a failing `nargo execute`
# leaves the previous run's artifacts in place, so `bb prove`/`bb verify` below
# succeed against them and report a passing proof for inputs that never solved.
rm -f target/shielded_pool.gz target/proof target/public_inputs
nargo execute 2>&1 && ok "Circuit witness solved" || err "nargo execute" "failed"
bb prove --scheme ultra_honk --oracle_hash keccak \
  --bytecode_path target/shielded_pool.json \
  --witness_path target/shielded_pool.gz \
  --output_path target --output_format bytes_and_fields 2>&1 \
  && ok "Proof generated" || err "bb prove" "failed"

bb verify -s ultra_honk --oracle_hash keccak \
  -k target/vk -p target/proof -i target/public_inputs 2>&1 \
  && ok "Proof verified locally" || err "bb verify" "failed"

cd "$PROJECT_ROOT"

# ─── Test: Frontend build ───
section "Frontend build test"

cd frontend
pnpm install --frozen-lockfile 2>&1 || pnpm install 2>&1
pnpm run build 2>&1 && ok "Frontend builds successfully" || err "Frontend build" "failed"
cd "$PROJECT_ROOT"

# ─── Cleanup ───
section "Cleanup"

stellar container stop stellar-local 2>/dev/null || true
stellar keys rm e2e-test 2>/dev/null || true
ok "Cleaned up"

# ─── Summary ───
echo ""
echo -e "${YELLOW}━━━ Results ━━━${NC}"
echo -e "  ${GREEN}Passed: $pass${NC}"
if [[ $fail -gt 0 ]]; then
  echo -e "  ${RED}Failed: $fail${NC}"
  exit 1
else
  echo -e "  ${RED}Failed: $fail${NC}"
  echo -e "\n${GREEN}All tests passed!${NC}"
fi
