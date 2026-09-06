#!/usr/bin/env bash
# DShield end-to-end demo, all on-chain against the currently deployed pool:
#
#   deposit 10 USDC -> spend 4 (re-shielding 6) -> spend the remaining 6
#
# The second spend is the point: a note is not all-or-nothing. Each withdrawal
# retires one nullifier and appends one change note, so a shielded balance can
# be drawn down over as many withdrawals as the holder likes. On-chain the two
# spends are the same shape, including the final one that empties the balance --
# nothing distinguishes "took part" from "took the lot".
#
# Pass the network as $1 (default: local). Requires a freshly deployed pool
# (run `just deploy` first).
set -euo pipefail

NETWORK="${1:-local}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
say() { echo -e "${YELLOW}$1${NC}"; }
ok() { echo -e "  ${GREEN}$1${NC}"; }

POOL=$(cat .pool_id)
TOKEN=$(cat .token_id)
ALICE=$(stellar keys address alice)
RELAYER=$(stellar keys address relayer)

note() { (cd frontend && node scripts/note.mjs "$@"); }
invoke() { stellar contract invoke --id "$POOL" --source "$1" --network "$NETWORK" "${@:2}"; }

# Fixed demo notes. Public demo values, not secret. Written as Noir literals:
# bare numbers are decimal, exactly as they appear in a Prover.toml.
DEPOSIT_AMOUNT=100000000   # 10 USDC
FIRST_PAYOUT=40000000      #  4 USDC out, 6 re-shielded
CHANGE_AMOUNT=60000000     #  6 USDC

A_NULL=1234;  A_SECRET=5678    # the deposited note
B_NULL=4321;  B_SECRET=8765    # the change note it leaves behind
C_NULL=1111;  C_SECRET=2222    # the (empty) note the second spend leaves behind

say "DShield demo on '$NETWORK'"
echo "  pool:    $POOL"
echo "  asset:   $TOKEN"
echo "  user:    $ALICE"
echo "  relayer: $RELAYER"

IDX=$(invoke alice -- get_next_index 2>&1 | tail -1)
if [ "$IDX" != "0" ]; then
  echo -e "${RED}Pool already has $IDX leaf/leaves. The demo needs a fresh pool — run 'just deploy $NETWORK' first.${NC}"
  exit 1
fi

# All commitments are derived here rather than hardcoded: the leaf hash has to
# agree bit for bit with the Noir circuit and the pool contract, so there is
# exactly one definition of it (frontend/scripts/note.mjs) and everything reads
# from that.
# The asset is part of the leaf, so every commitment is derived against the
# field the pool will recompute from the payout token's address. A note built
# with an unreduced asset id hashes to a leaf the contract never recognises,
# and the withdrawal fails with AssetMismatch.
ASSET_FIELD=$(note asset-field "$TOKEN")
CM_A=$(note commitment $A_NULL $A_SECRET $DEPOSIT_AMOUNT "$ASSET_FIELD")
CM_B=$(note commitment $B_NULL $B_SECRET $CHANGE_AMOUNT "$ASSET_FIELD")
CM_C=$(note commitment $C_NULL $C_SECRET 0 "$ASSET_FIELD")
NF_A=$(note nullifier-hash $A_NULL)
NF_B=$(note nullifier-hash $B_NULL)

say "1/6  Depositing 10 USDC into the shielded pool"
invoke alice --send=yes -- deposit \
  --depositor "$ALICE" --asset "$TOKEN" \
  --commitment "${CM_A#0x}" --amount "$DEPOSIT_AMOUNT" >/dev/null
ok "deposited; note worth 10 USDC at leaf 0"

say "2/6  Computing recipient hash (binds the proof to the recipient)"
RHASH=$(cd frontend && node scripts/recipient-hash.mjs "$ALICE")
ok "recipient hash ${RHASH:0:18}..."

# Builds a Prover.toml for one spend and proves it.
#   $1 leaf index   $2..$3 note nullifier/secret   $4 note value
#   $5 payout       $6..$7 change nullifier/secret $8 change commitment
#   $9.. the pool's leaves, in order
prove_spend() {
  local index="$1" nullifier="$2" secret="$3" amount="$4" payout="$5"
  local change_null="$6" change_secret="$7" change_cm="$8"
  shift 8
  local path
  path=$(note path "$index" "$@")

  local root siblings bits
  root=$(echo "$path" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).root))')
  siblings=$(echo "$path" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).pathSiblings.map(v=>`    "${v}",`).join("\n")))')
  bits=$(echo "$path" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).pathBits.join(", ")))')

  cat > circuits/shielded_pool/Prover.toml <<TOML
root = "${root}"
nullifier_hash = "$(note nullifier-hash "$nullifier")"
recipient = "${RHASH}"
withdraw_amount = "${payout}"
relayer_fee = "0"
change_commitment = "${change_cm}"
asset = "${ASSET_FIELD}"
nullifier = "${nullifier}"
secret = "${secret}"
amount = "${amount}"
change_nullifier = "${change_null}"
change_secret = "${change_secret}"
path_bits = [${bits}]
path_siblings = [
${siblings}
]
TOML

  # Clear stale artifacts: without this a failed execute leaves the previous
  # run's witness and proof in place, and the withdrawal below would submit a
  # proof for the wrong spend entirely.
  rm -f circuits/shielded_pool/target/shielded_pool.gz \
        circuits/shielded_pool/target/proof \
        circuits/shielded_pool/target/public_inputs
  (cd circuits/shielded_pool && nargo execute >/dev/null 2>&1)
  (cd circuits/shielded_pool && bb prove --scheme ultra_honk --oracle_hash keccak \
    --bytecode_path target/shielded_pool.json --witness_path target/shielded_pool.gz \
    --output_path target --output_format bytes_and_fields >/dev/null 2>&1)
}

relay_withdraw() {
  # The fee arguments are zero: the relayer here eats the gas rather than
  # carving a slice out of the payout, which is also what the app does on its
  # wallet-signed path. A non-zero fee would have to be committed to by the
  # proof as well (relayer_fee above), since the circuit constrains
  # payout + fee + change == amount.
  stellar contract invoke --id "$POOL" --source relayer --network "$NETWORK" --send=yes \
    -- withdraw --recipient "$ALICE" --asset "$TOKEN" \
    --public_inputs-file-path circuits/shielded_pool/target/public_inputs \
    --proof_bytes-file-path circuits/shielded_pool/target/proof \
    --fee_amount 0 --fee_min_out 0 --fee_recipient "$RELAYER" >/dev/null
}

say "3/6  Proving a PARTIAL spend: 4 USDC out, 6 USDC re-shielded"
prove_spend 0 $A_NULL $A_SECRET $DEPOSIT_AMOUNT $FIRST_PAYOUT \
  $B_NULL $B_SECRET "$CM_B" "$CM_A"
ok "proof generated ($(wc -c < circuits/shielded_pool/target/proof) bytes)"

say "4/6  Relaying it (the user's account never signs or pays)"
relay_withdraw
ok "4 USDC paid out; 6 USDC re-shielded as a new note, submitted by $RELAYER"

CHANGE_INDEX=$(invoke alice -- get_commitment_index --commitment "${CM_B#0x}" 2>&1 | tail -1)
ok "change note landed at leaf $CHANGE_INDEX"

say "5/6  Spending the re-shielded remainder: the other 6 USDC"
# The tree now holds the original note and the change note it produced.
prove_spend 1 $B_NULL $B_SECRET $CHANGE_AMOUNT $CHANGE_AMOUNT \
  $C_NULL $C_SECRET "$CM_C" "$CM_A" "$CM_B"
relay_withdraw
ok "the remaining 6 USDC withdrawn from the change note"

say "6/6  Verifying on-chain state"
USED_A=$(invoke alice -- is_nullifier_used --nullifier_hash "${NF_A#0x}" 2>&1 | tail -1)
USED_B=$(invoke alice -- is_nullifier_used --nullifier_hash "${NF_B#0x}" 2>&1 | tail -1)
FINAL_IDX=$(invoke alice -- get_next_index 2>&1 | tail -1)

if [ "$USED_A" != "true" ] || [ "$USED_B" != "true" ]; then
  echo -e "${RED}  a nullifier was not consumed — a withdrawal may have failed${NC}"; exit 1
fi
ok "both nullifiers consumed (neither note can be spent again)"

# One leaf per deposit plus one per spend: the deposit, the change from the
# partial spend, and the empty note the final spend left behind.
if [ "$FINAL_IDX" != "3" ]; then
  echo -e "${RED}  expected 3 leaves, found $FINAL_IDX${NC}"; exit 1
fi
ok "3 leaves: the deposit, plus one change note per spend"

echo ""
echo -e "${GREEN}Done — 10 USDC shielded, drawn down over two spends, verified on-chain.${NC}"
echo -e "${GREEN}Every spend looked the same to an observer, including the one that emptied it.${NC}"
