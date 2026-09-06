import { describe, it, expect } from "vitest";
import {
  poseidon2Hash,
  computeCommitment,
  computeNullifierHash,
  buildMerkleTree,
  normalizeField,
  assetToField,
  assetFieldFromContractId,
  BN254_SCALAR_MODULUS,
} from "./poseidon2.js";

const ZERO_32 = "0x" + "00".repeat(32);
const KNOWN_ZERO_HASH =
  "0x0b63a53787021a4a962a452c2921b3663aff1ffd8d5510540f8e659e782956f1";
const KNOWN_NULLIFIER_HASH =
  "0x162e3a2744c870a14bcdbd4028e3400ba6ae1d2e869fa850b1b411e57a370e04";
// hash_leaf(nullifier=1234, secret=5678, amount=1000000, asset=7) as computed
// by the Noir circuits — the exact fixture in circuits/shielded_pool/Prover.toml.
// Pinning it here is what keeps the TypeScript hasher in @dshield/core from
// drifting from the circuit and the on-chain contract: if any of the three
// disagree, every note the app or CLI mints becomes unwithdrawable.
const KNOWN_LEAF =
  "0x16a7837ad782bec94584ff0aa6b46490108419c80b92a3b1f870538bdabb19d8";
// The root and change commitment the same Prover.toml pins, reached from
// KNOWN_LEAF. Matching them proves this hasher agrees with the circuit end to
// end, not just on one leaf.
const KNOWN_ROOT =
  "0x147cdc1d655aa3b64028f43a78ca592c2b83c7e5e101559d1ed8c632f4615e96";
const KNOWN_CHANGE_COMMITMENT =
  "0x28465f07afc7f919583712bf8c4410df8661327896357a30962af5fb3df2ec42";

describe("normalizeField", () => {
  it("left-pads a value whose top byte is zero to 32 bytes", () => {
    expect(
      normalizeField("0x301b2607fdf1a5aed8e781d63cd1b03545333687293c81aceeb7e9ea61c140"),
    ).toBe(
      "0x00301b2607fdf1a5aed8e781d63cd1b03545333687293c81aceeb7e9ea61c140",
    );
  });

  it("throws if the value exceeds 32 bytes", () => {
    expect(() => normalizeField("0x" + "ff".repeat(33))).toThrow();
  });
});

describe("poseidon2Hash", () => {
  it("hashes two zero fields to the known zero hash", async () => {
    expect(await poseidon2Hash(ZERO_32, ZERO_32)).toBe(KNOWN_ZERO_HASH);
  });
});

describe("computeCommitment", () => {
  it("matches the Noir circuits' hash_leaf for the shared fixture", async () => {
    expect(await computeCommitment("04d2", "162e", "1000000", "0x07")).toBe(
      KNOWN_LEAF,
    );
  });

  it("matches the circuit's change commitment for the same fixture", async () => {
    // change_nullifier=4321, change_secret=8765, change=600000, asset=7 —
    // i.e. the remainder of a 400000 payout from the note above.
    expect(await computeCommitment("10e1", "223d", "600000", "0x07")).toBe(
      KNOWN_CHANGE_COMMITMENT,
    );
  });

  it("binds the amount: same secrets with a different value differ", async () => {
    const a = await computeCommitment("00aabb", "00ccdd", "1000000", "0x07");
    const b = await computeCommitment("00aabb", "00ccdd", "1000001", "0x07");
    expect(a).not.toBe(b);
  });

  it("binds the asset: same secrets and value in a different asset differ", async () => {
    // This is what stops a proof for one asset opening a note of another.
    const a = await computeCommitment("00aabb", "00ccdd", "1000000", "0x07");
    const b = await computeCommitment("00aabb", "00ccdd", "1000000", "0x08");
    expect(a).not.toBe(b);
  });
});

describe("assetToField", () => {
  // Cross-checked against the pool contract's asset_id_from_address in
  // contracts/pool/src/lib.rs (test_asset_field_matches_clients). If these two
  // disagree, every note of that asset is shielded and unwithdrawable.
  const TESTNET_XLM_SAC =
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const PUBNET_XLM_SAC =
    "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";

  it("reduces a contract id that exceeds the field modulus", () => {
    // Roughly four in five real contract addresses land here, so this is the
    // common path, not an edge case.
    expect(assetToField(TESTNET_XLM_SAC)).toBe(
      "0x160151a73da9bc2909b6d4c5eee9ebdba98607979316d8ffff1af1f2f4d1ce5d",
    );
  });

  it("passes through a contract id already below the modulus", () => {
    expect(assetToField(PUBNET_XLM_SAC)).toBe(
      "0x25b4fcd859aec2fa6348438c489b3c3c10c98b6d21be4fd3cb30cb68953ef977",
    );
  });

  it("always returns a canonical value inside the field", () => {
    for (const sac of [TESTNET_XLM_SAC, PUBNET_XLM_SAC]) {
      const field = assetToField(sac);
      expect(field).toHaveLength(66);
      expect(BigInt(field)).toBeLessThan(BN254_SCALAR_MODULUS);
    }
  });

  it("rejects a contract id that isn't 32 bytes", () => {
    expect(() => assetFieldFromContractId(new Uint8Array(31))).toThrow();
  });
});

describe("computeNullifierHash", () => {
  it("matches the circuit's nullifier hash for the shared fixture", async () => {
    expect(await computeNullifierHash("04d2")).toBe(KNOWN_NULLIFIER_HASH);
  });
});

describe("buildMerkleTree", () => {
  it("reproduces the circuit's root for the single-leaf fixture", async () => {
    const { root, pathSiblings, pathBits } = await buildMerkleTree([KNOWN_LEAF], 0);
    expect(pathSiblings).toHaveLength(20);
    expect(pathBits).toHaveLength(20);
    expect(root).toBe(KNOWN_ROOT);
  });
});
