import { describe, it, expect, vi, beforeEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const queryContractView = vi.hoisted(() => vi.fn());
vi.mock("./chain.js", () => ({ queryContractView }));

const {
  fetchAssetInfo,
  fetchPoolAssets,
  isNativeAsset,
  nativeSacId,
  classicSacId,
  resolveAsset,
} = await import("./assets.js");

const PASSPHRASE = StellarSdk.Networks.TESTNET;
const CFG = { rpcUrl: "http://localhost:8000", networkPassphrase: PASSPHRASE };

const ISSUER = "GA5WUJ54Z23KILLCUOUNAKTPBVZWKMQVO4O6EQ5GHLAERIMLLHNCSKYH";
const NATIVE = nativeSacId(PASSPHRASE);
const USDC = classicSacId("USDC", ISSUER, PASSPHRASE);

/** Answers `symbol`/`decimals` per contract, like a set of real SAC views. */
function mockViews(table: Record<string, { symbol?: unknown; decimals?: unknown }>) {
  queryContractView.mockImplementation(
    async (_cfg: unknown, contractId: string, method: string) => {
      const entry = table[contractId];
      if (!entry) return null;
      const value = entry[method as "symbol" | "decimals"];
      if (value === undefined) return null;
      return typeof value === "number"
        ? StellarSdk.nativeToScVal(value, { type: "u32" })
        : StellarSdk.nativeToScVal(value as string, { type: "string" });
    },
  );
}

beforeEach(() => {
  queryContractView.mockReset();
});

describe("SAC address derivation", () => {
  it("derives a valid contract id for native XLM", () => {
    expect(StellarSdk.StrKey.isValidContract(NATIVE)).toBe(true);
  });

  it("recognises the native SAC and nothing else as native", () => {
    expect(isNativeAsset(NATIVE, PASSPHRASE)).toBe(true);
    expect(isNativeAsset(USDC, PASSPHRASE)).toBe(false);
  });

  it("derives a different native SAC per network", () => {
    // The contract id is network-scoped: reusing testnet's would address a
    // contract that doesn't exist on mainnet, and every deposit would fail.
    expect(nativeSacId(StellarSdk.Networks.PUBLIC)).not.toBe(NATIVE);
  });

  it("rejects a malformed address rather than throwing", () => {
    expect(isNativeAsset("not-an-address", PASSPHRASE)).toBe(false);
  });
});

describe("fetchAssetInfo", () => {
  it("shows XLM, not the SAC's internal \"native\" symbol", async () => {
    mockViews({ [NATIVE]: { symbol: "native", decimals: 7 } });
    const info = await fetchAssetInfo(CFG, NATIVE);
    expect(info).toEqual({
      contractId: NATIVE,
      symbol: "XLM",
      decimals: 7,
      native: true,
    });
  });

  it("reads symbol and decimals off a non-native token", async () => {
    mockViews({ [USDC]: { symbol: "USDC", decimals: 7 } });
    const info = await fetchAssetInfo(CFG, USDC);
    expect(info).toEqual({
      contractId: USDC,
      symbol: "USDC",
      decimals: 7,
      native: false,
    });
  });

  it("honours a token that isn't 7 decimals", async () => {
    // The whole point of reading decimals from the contract: a note's value is
    // stored in base units, so a 6-decimal token formatted as 7 would show
    // every balance 10x too small.
    mockViews({ [USDC]: { symbol: "USDX", decimals: 6 } });
    expect((await fetchAssetInfo(CFG, USDC)).decimals).toBe(6);
  });

  it("falls back to a readable label when metadata calls fail", async () => {
    // An allow-listed asset must stay usable even if its metadata views are
    // missing — notes denominated in it may already exist in the tree.
    mockViews({});
    const info = await fetchAssetInfo(CFG, USDC);
    expect(info.decimals).toBe(7);
    expect(info.symbol).toContain("…");
    expect(info.native).toBe(false);
  });

  it("ignores an out-of-range decimals value", async () => {
    mockViews({ [USDC]: { symbol: "BAD", decimals: 999 } });
    expect((await fetchAssetInfo(CFG, USDC)).decimals).toBe(7);
  });
});

describe("fetchPoolAssets", () => {
  it("resolves metadata for every allow-listed asset", async () => {
    queryContractView.mockImplementation(
      async (_cfg: unknown, contractId: string, method: string) => {
        if (method === "get_assets") {
          return StellarSdk.xdr.ScVal.scvVec([
            StellarSdk.nativeToScVal(NATIVE, { type: "address" }),
            StellarSdk.nativeToScVal(USDC, { type: "address" }),
          ]);
        }
        if (method === "symbol") {
          return StellarSdk.nativeToScVal(
            contractId === NATIVE ? "native" : "USDC",
            { type: "string" },
          );
        }
        if (method === "decimals") {
          return StellarSdk.nativeToScVal(7, { type: "u32" });
        }
        return null;
      },
    );

    const assets = await fetchPoolAssets(CFG, "POOL");
    expect(assets.map((a) => a.symbol)).toEqual(["XLM", "USDC"]);
    expect(assets[0].native).toBe(true);
  });

  it("returns an empty list when the allow-list can't be read", async () => {
    // Never a partial list: mistaking an RPC failure for "this pool supports
    // one asset" would shield funds into the wrong token.
    queryContractView.mockResolvedValue(null);
    expect(await fetchPoolAssets(CFG, "POOL")).toEqual([]);
  });
});

describe("resolveAsset", () => {
  const XLM = { contractId: NATIVE, symbol: "XLM", decimals: 7, native: true };

  it("finds the asset a note is denominated in", () => {
    expect(resolveAsset([XLM], NATIVE)).toBe(XLM);
  });

  it("degrades to a placeholder for a de-listed asset rather than undefined", () => {
    // A note whose asset was removed from the allow-list still exists and is
    // still spendable if it is re-added, so its amount must still render.
    const orphan = resolveAsset([XLM], USDC);
    expect(orphan.contractId).toBe(USDC);
    expect(orphan.decimals).toBe(7);
  });
});
