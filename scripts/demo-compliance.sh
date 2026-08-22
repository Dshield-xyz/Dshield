#!/usr/bin/env bash
# DShield compliant-disclosure demo: register a KYC hash, generate a real
# compliance ZK proof, and verify it on-chain. Pass the network as $1
# (default: local). Uses the deployed compliance contract (.compliance_id) whose
# admin is the `alice` identity.
set -euo pipefail

NETWORK="${1:-local}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say() { echo -e "${YELLOW}$1${NC}"; }
ok() { echo -e "  ${GREEN}$1${NC}"; }

COMPLIANCE=$(cat .compliance_id)
POOL=$(cat .pool_id)
ALICE=$(stellar keys address alice)

# The fixture note the committed circuits/compliance/Prover.toml proves about:
# nullifier=1234, secret=5678, worth 1000000 stroops. Written as Noir literals.
FIXTURE_NULL=1234
FIXTURE_SECRET=5678
FIXTURE_AMOUNT=1000000

say "DShield compliance demo on '$NETWORK'"
echo "  contract: $COMPLIANCE"
echo "  pool:     $POOL"
echo "  admin:    $ALICE"

# The proof is about a note in the pool, and the contract only accepts a
# merkle_root one of its configured pools actually reached. So the fixture note
# has to be deposited first, as leaf 0, for the Prover.toml root to be real.
say "1/5  Shielding the fixture note the proof is about"
IDX=$(stellar contract invoke --id "$POOL" --source alice --network "$NETWORK" -- get_next_index 2>&1 | tail -1)
if [ "$IDX" != "0" ]; then
  echo -e "${RED}Pool already has $IDX leaf/leaves. This demo proves against a single-leaf tree, so it needs a fresh pool — run 'just deploy $NETWORK' first.${NC}"
  exit 1
fi
FIXTURE_CM=$(cd frontend && node scripts/note.mjs commitment $FIXTURE_NULL $FIXTURE_SECRET $FIXTURE_AMOUNT)
stellar contract invoke --id "$POOL" --source alice --network "$NETWORK" --send=yes \
  -- deposit --depositor "$ALICE" --commitment "${FIXTURE_CM#0x}" --amount "$FIXTURE_AMOUNT" >/dev/null
ok "fixture note deposited at leaf 0 (worth 0.1 USDC)"

say "2/5  Generating compliance ZK proof (KYC + note ownership + selective disclosure)"
( cd circuits/compliance
  nargo execute >/dev/null 2>&1
  bb prove --scheme ultra_honk --oracle_hash keccak \
    --bytecode_path target/compliance.json --witness_path target/compliance.gz \
    --output_path target --output_format bytes_and_fields >/dev/null 2>&1 )
PI=circuits/compliance/target/public_inputs
PROOF=circuits/compliance/target/proof
# public inputs layout: [merkle_root(32), kyc_hash(32), disclosed_amount(32), auditor_key(32)]
KYC=$(xxd -p "$PI" | tr -d '\n' | cut -c65-128)
ok "proof generated; kyc_hash 0x${KYC:0:16}..."

say "3/5  Registering the KYC hash (admin-only)"
stellar contract invoke --id "$COMPLIANCE" --source alice --network "$NETWORK" --send=yes \
  -- register_kyc --kyc_hash "$KYC" >/dev/null
REG=$(stellar contract invoke --id "$COMPLIANCE" --source alice --network "$NETWORK" -- is_kyc_registered --kyc_hash "$KYC" 2>&1 | tail -1)
[ "$REG" = "true" ] && ok "kyc_hash registered" || { echo -e "${RED}  registration failed${NC}"; exit 1; }

say "4/5  Verifying the compliance proof on-chain"
stellar contract invoke --id "$COMPLIANCE" --source alice --network "$NETWORK" --send=yes \
  -- verify_compliance --public_inputs-file-path "$PI" --proof_bytes-file-path "$PROOF" >/dev/null
ok "compliance verified on-chain (ComplianceVerifiedEvent emitted)"
ok "the disclosed amount is proved against the note's committed value, not asserted"

say "5/5  Negative check: an unregistered KYC hash must be rejected"
python3 - "$PI" > /tmp/dshield_pi_bad.bin <<'PY'
import sys
b = bytearray(open(sys.argv[1],"rb").read())
for i in range(32,64): b[i] = 0xBB  # unregistered kyc_hash
sys.stdout.buffer.write(bytes(b))
PY
if stellar contract invoke --id "$COMPLIANCE" --source alice --network "$NETWORK" --send=yes \
    -- verify_compliance --public_inputs-file-path /tmp/dshield_pi_bad.bin --proof_bytes-file-path "$PROOF" >/dev/null 2>&1; then
  echo -e "${RED}  unregistered KYC was accepted — gate broken${NC}"; exit 1
else
  ok "unregistered KYC rejected (KycNotRegistered)"
fi
rm -f /tmp/dshield_pi_bad.bin

echo ""
echo -e "${GREEN}Done — register KYC -> ZK proof -> on-chain verification proven, and the KYC gate enforced.${NC}"
