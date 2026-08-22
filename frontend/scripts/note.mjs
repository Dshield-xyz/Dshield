// Computes note values and Merkle paths using the same Poseidon2 hasher circuit
// as the app (src/lib/poseidon2.ts) and the Noir circuits. Used by scripts that
// drive the contracts from the shell, so those never hardcode a hash that could
// drift from the three implementations that have to agree on it.
//
//   node scripts/note.mjs commitment <nullifier> <secret> <amount>
//       -> the note's leaf commitment
//   node scripts/note.mjs nullifier-hash <nullifier>
//       -> the nullifier hash the pool records when the note is spent
//   node scripts/note.mjs path <leafIndex> <leaf0> [leaf1 ...]
//       -> JSON {root, pathSiblings, pathBits} for that leaf in that tree
//
// Field arguments are passed to Noir verbatim, exactly as a Prover.toml entry
// would be: a bare "1234" is the number 1234, and hex must be written "0x4d2".
// (This differs from src/lib/poseidon2.ts, where a bare string is always hex --
// there every field comes from generateRandomField, which emits bare hex.)
// Amounts are decimal stroops.
import { Noir } from "@noir-lang/noir_js";
import { readFileSync } from "fs";

const TREE_DEPTH = 20;
const LEAF_DOMAIN = "0x4c454146";
const NULLIFIER_DOMAIN = "0x4e554c4c";

const hasher = JSON.parse(
  readFileSync(new URL("../src/circuits/hasher.json", import.meta.url)),
);
const noir = new Noir(hasher);

const norm = (v) => "0x" + String(v).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const field = (v) => String(v);
const H = async (a, b) => norm((await noir.execute({ a, b })).returnValue);

const commitment = async (nullifier, secret, amount) =>
  H(await H(await H(LEAF_DOMAIN, field(nullifier)), field(secret)), BigInt(amount).toString(10));

const nullifierHash = async (nullifier) =>
  H(await H(NULLIFIER_DOMAIN, field(nullifier)), "0x00");

async function zeroHashes() {
  const zeroes = ["0x" + "00".repeat(32)];
  for (let i = 0; i < TREE_DEPTH; i++) zeroes.push(await H(zeroes[i], zeroes[i]));
  return zeroes;
}

/** Mirrors buildMerkleTree in src/lib/poseidon2.ts. */
async function merklePath(leaves, targetIndex) {
  const zeroes = await zeroHashes();
  let level = leaves.map(norm);
  while (level.length <= targetIndex) level.push(zeroes[0]);

  const pathSiblings = [];
  const pathBits = [];
  let idx = targetIndex;

  for (let depth = 0; depth < TREE_DEPTH; depth++) {
    pathBits.push(idx & 1);
    const siblingIdx = idx ^ 1;
    pathSiblings.push(siblingIdx < level.length ? level[siblingIdx] : zeroes[depth]);

    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const right = i + 1 < level.length ? level[i + 1] : zeroes[depth];
      next.push(await H(level[i], right));
    }
    if (next.length === 0) next.push(zeroes[depth + 1]);

    level = next;
    idx >>= 1;
  }

  return { root: level[0], pathSiblings, pathBits };
}

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "commitment": {
    const [nullifier, secret, amount] = args;
    if (!nullifier || !secret || amount === undefined) {
      console.error("usage: note.mjs commitment <nullifier> <secret> <amount>");
      process.exit(1);
    }
    process.stdout.write(await commitment(nullifier, secret, amount));
    break;
  }
  case "nullifier-hash": {
    const [nullifier] = args;
    if (!nullifier) {
      console.error("usage: note.mjs nullifier-hash <nullifier>");
      process.exit(1);
    }
    process.stdout.write(await nullifierHash(nullifier));
    break;
  }
  case "path": {
    const [index, ...leaves] = args;
    if (index === undefined || leaves.length === 0) {
      console.error("usage: note.mjs path <leafIndex> <leaf0> [leaf1 ...]");
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(await merklePath(leaves, Number(index))));
    break;
  }
  default:
    console.error("usage: note.mjs <commitment|nullifier-hash|path> ...");
    process.exit(1);
}
