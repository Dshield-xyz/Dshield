#!/usr/bin/env bash
# Multi-asset demo: shields native XLM in a pool that was deployed with USDC,
# spends part of it, and checks the asset binding holds on-chain.
#
# The point is that both assets live in ONE tree and one nullifier set — the
# anonymity set is everyone in the pool rather than everyone holding that one
# token — while a proof for one asset still cannot open a note of another. The
# negative check at the end is the load-bearing part: it re-submits the XLM
# proof asking for a USDC payout and requires the contract to refuse.
#
# Pass the network as $1 (default: local). Run after `just deploy`; unlike
# `just demo` it does not need a fresh pool, so the two can run back to back.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
export PATH="$HOME/.nargo/bin:$HOME/.bb:$PATH"

NETWORK="${1:-local}"
POOL=$(cat .pool_id)
ALICE=$(stellar keys address alice)
RELAYER=$(stellar keys address relayer)
XLM=$(stellar contract id asset --asset native --network "$NETWORK" 2>&1 | tail -1)

# The native SAC is permissionless to deploy and its address is deterministic,
# so this is idempotent: deploy it only if it isn't there yet.
if ! stellar contract invoke --id "$XLM" --source alice --network "$NETWORK" -- name >/dev/null 2>&1; then
  stellar contract asset deploy --asset native --source alice --network "$NETWORK" >/dev/null 2>&1
fi

note() { (cd frontend && node scripts/note.mjs "$@"); }
invoke() { stellar contract invoke --id "$POOL" --source "$1" --network "$NETWORK" "${@:2}"; }

DEPOSIT=50000000   # 5 XLM
PAYOUT=20000000    # 2 XLM out, 3 re-shielded
CHANGE=30000000    # 3 XLM


echo "pool:  $POOL"
echo "XLM:   $XLM"

# The field the note's leaf commits to: the contract id reduced modulo the
# BN254 scalar field, exactly as the pool's asset_id_from_address does. Most
# real contract ids exceed the modulus, so an unreduced value here would build
# a note the pool never recognises.
ASSET_FIELD=$(note asset-field "$XLM")
echo "asset field: $ASSET_FIELD"

echo
echo "== allow-listing XLM on a pool deployed with USDC =="
invoke alice --send=yes -- add_asset --asset "$XLM" >/dev/null
echo "assets now: $(invoke alice -- get_assets 2>&1 | tail -1)"

START_IDX=$(invoke alice -- get_next_index 2>&1 | tail -1)
echo "tree starts at leaf $START_IDX"

# Demo secrets, varied by the tree's current size so the script can be re-run
# against the same pool: a commitment is unique per (nullifier, secret, amount,
# asset), and re-depositing an identical one is rejected as CommitmentExists.
# Public demo values, not secret, and written as Noir decimal literals.
X_NULL=$((7770000 + START_IDX)); X_SECRET=$((8880000 + START_IDX))
Y_NULL=$((9990000 + START_IDX)); Y_SECRET=$((1010000 + START_IDX))

CM_X=$(note commitment $X_NULL $X_SECRET $DEPOSIT "$ASSET_FIELD")
CM_Y=$(note commitment $Y_NULL $Y_SECRET $CHANGE "$ASSET_FIELD")
NF_X=$(note nullifier-hash $X_NULL)

echo
echo "== depositing 5 XLM =="
invoke alice --send=yes -- deposit --depositor "$ALICE" --asset "$XLM" \
  --commitment "${CM_X#0x}" --amount "$DEPOSIT" >/dev/null
echo "deposited at leaf $START_IDX"

echo
echo "== proving a partial spend: 2 XLM out, 3 XLM re-shielded =="
RHASH=$(cd frontend && node scripts/recipient-hash.mjs "$ALICE")

# Every leaf in the tree, in order, so the Merkle path is built against the
# real state (mixed USDC and XLM leaves — one tree).
LEAVES=()
for i in $(seq 0 "$START_IDX"); do
  LEAVES+=("0x$(invoke alice -- get_commitment --index "$i" 2>&1 | tail -1 | tr -d '"')")
done

PATH_JSON=$(note path "$START_IDX" "${LEAVES[@]}")
ROOT=$(echo "$PATH_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).root))')
SIBS=$(echo "$PATH_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).pathSiblings.map(v=>`    "${v}",`).join("\n")))')
BITS=$(echo "$PATH_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).pathBits.join(", ")))')

cat > circuits/shielded_pool/Prover.toml <<TOML
root = "${ROOT}"
nullifier_hash = "${NF_X}"
recipient = "${RHASH}"
withdraw_amount = "${PAYOUT}"
relayer_fee = "0"
change_commitment = "${CM_Y}"
asset = "${ASSET_FIELD}"
nullifier = "${X_NULL}"
secret = "${X_SECRET}"
amount = "${DEPOSIT}"
change_nullifier = "${Y_NULL}"
change_secret = "${Y_SECRET}"
path_bits = [${BITS}]
path_siblings = [
${SIBS}
]
TOML

rm -f circuits/shielded_pool/target/shielded_pool.gz \
      circuits/shielded_pool/target/proof \
      circuits/shielded_pool/target/public_inputs
(cd circuits/shielded_pool && nargo execute >/dev/null 2>&1)
(cd circuits/shielded_pool && bb prove --scheme ultra_honk --oracle_hash keccak \
  --bytecode_path target/shielded_pool.json --witness_path target/shielded_pool.gz \
  --output_path target --output_format bytes_and_fields >/dev/null 2>&1)
echo "proof generated ($(wc -c < circuits/shielded_pool/target/proof) bytes)"

echo
echo "== relaying the XLM withdrawal =="
stellar contract invoke --id "$POOL" --source relayer --network "$NETWORK" --send=yes \
  -- withdraw --recipient "$ALICE" --asset "$XLM" \
  --public_inputs-file-path circuits/shielded_pool/target/public_inputs \
  --proof_bytes-file-path circuits/shielded_pool/target/proof \
  --fee_amount 0 --fee_min_out 0 --fee_recipient "$RELAYER" >/dev/null
echo "withdrew 2 XLM; 3 XLM re-shielded"

echo
echo "== negative check: the same XLM proof must not pay out USDC =="
USDC=$(cat .token_id)
if stellar contract invoke --id "$POOL" --source relayer --network "$NETWORK" --send=yes \
   -- withdraw --recipient "$ALICE" --asset "$USDC" \
   --public_inputs-file-path circuits/shielded_pool/target/public_inputs \
   --proof_bytes-file-path circuits/shielded_pool/target/proof \
   --fee_amount 0 --fee_min_out 0 --fee_recipient "$RELAYER" >/dev/null 2>&1; then
  echo "FAIL: an XLM proof withdrew USDC"; exit 1
else
  echo "rejected, as it must be (asset binding holds on-chain)"
fi

echo
echo "== final state =="
USED=$(invoke alice -- is_nullifier_used --nullifier_hash "${NF_X#0x}" 2>&1 | tail -1)
if [ "$USED" != "true" ]; then
  echo "FAIL: the XLM nullifier was not consumed"; exit 1
fi
echo "XLM nullifier consumed: $USED"
echo "change note at leaf:    $(invoke alice -- get_commitment_index --commitment "${CM_Y#0x}" 2>&1 | tail -1)"
echo "leaves total:           $(invoke alice -- get_next_index 2>&1 | tail -1)"
echo "pool XLM balance:       $(stellar contract invoke --id "$XLM" --source alice --network "$NETWORK" -- balance --id "$POOL" 2>&1 | tail -1)"
echo "pool USDC balance:      $(stellar contract invoke --id "$USDC" --source alice --network "$NETWORK" -- balance --id "$POOL" 2>&1 | tail -1)"
