/**
 * Node-side Poseidon2 hasher, backed by the same compiled `hasher` Noir
 * circuit the frontend runs in the browser (`frontend/src/lib/poseidon2.ts`).
 * Both MUST compute byte-identical output — this is what lets a Merkle path
 * built by this service verify against a root the pool contract actually
 * produced.
 *
 * `circuits/hasher.json` here is a copy of the artifact `nargo compile`
 * produces from `circuits/hasher/` at the repo root (see this package's
 * README and the CI workflow, which recompiles it fresh before every build
 * so it can't silently drift from the circuit source).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Noir } from "@noir-lang/noir_js";
import type { Hash2 } from "@dshield/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hasherCircuit = JSON.parse(
  readFileSync(path.join(__dirname, "..", "circuits", "hasher.json"), "utf8"),
) as Record<string, unknown>;

let noirInstance: InstanceType<typeof Noir> | null = null;

function getHasher(): InstanceType<typeof Noir> {
  if (!noirInstance) {
    noirInstance = new Noir(hasherCircuit as never);
  }
  return noirInstance;
}

/**
 * Left-pads a field element to a canonical 32-byte (64 hex char) 0x-prefixed
 * string. The Noir hasher returns field values without leading-zero padding,
 * but on-chain the same value is always a full 32-byte BytesN<32> — comparing
 * the two as raw strings silently breaks unless both are normalized first.
 */
export function normalizeField(v: string): string {
  const hex = v.replace(/^0x/, "").toLowerCase();
  if (hex.length > 64) {
    throw new Error(`field element exceeds 32 bytes: ${v}`);
  }
  return "0x" + hex.padStart(64, "0");
}

export const poseidon2Hash: Hash2 = async (a, b) => {
  const noir = getHasher();
  const result = await noir.execute({ a, b });
  return normalizeField(result.returnValue as string);
};
