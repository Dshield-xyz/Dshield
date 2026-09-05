import { describe, it, expect, vi, afterEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const ISSUER = "GABZWK2YLPOGBEOZT6VOCID6ROSSZGPSLAEPCTWIBGAJDHISO6DFKYYZ";
const PASSPHRASE = "Standalone Network ; February 2017";

// stellar.ts reads NEXT_PUBLIC_* env at module load, so each scenario reloads
// the module with the desired env (same pattern as indexer.test.ts).
async function loadStellar(issuer = "") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_USDC_ISSUER = issuer;
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = PASSPHRASE;
  delete process.env.NEXT_PUBLIC_DEV_SECRET_KEY;
  return await import("./stellar");
}

const XLM_SAC = "CDMLFMKMMD7MWZP3FKUBZPVHTUEDLSX4BYGYKH4GCESXYHS3IHQ4EIG4";
const DEX_ROUTER = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADEX1";
const TOKEN_ID = "CBRRTOJWMDAJEYUK2R7MKY6NGABXL52GEKKBXCIUPXOFHOFM5YPIA7WF";

async function loadStellarWithDex(routerId = DEX_ROUTER, xlmId = XLM_SAC) {
  vi.resetModules();
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = PASSPHRASE;
  process.env.NEXT_PUBLIC_DEX_ROUTER_ID = routerId;
  process.env.NEXT_PUBLIC_XLM_SAC_ID = xlmId;
  return await import("./stellar");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classicAssetForContract", () => {
  it("finds the classic asset a configured SAC address wraps", async () => {
    // A SAC's contract id is a hash of the asset, so it can't be reversed. The
    // app keeps the code:issuer pairs it knows precisely so it can still open a
    // trustline for one.
    const s = await loadStellar(ISSUER);
    const sacId = new StellarSdk.Asset("USDC", ISSUER).contractId(PASSPHRASE);
    const asset = s.classicAssetForContract(sacId);
    expect(asset?.getCode()).toBe("USDC");
    expect(asset?.getIssuer()).toBe(ISSUER);
  });

  it("returns null for an asset this deployment doesn't know", async () => {
    const s = await loadStellar(ISSUER);
    expect(s.classicAssetForContract(TOKEN_ID)).toBeNull();
  });

  it("returns null when no classic asset is configured at all", async () => {
    const s = await loadStellar("");
    expect(s.classicAssetForContract(TOKEN_ID)).toBeNull();
  });
});

describe("hasTrustline", () => {
  it("treats native XLM as always holdable, with no network call", async () => {
    // An account needs no trustline for XLM, so probing one would only add a
    // round trip that can fail spuriously.
    const s = await loadStellar(ISSUER);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const nativeSac = StellarSdk.Asset.native().contractId(PASSPHRASE);
    expect(await s.hasTrustline(nativeSac, ISSUER)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("faucetAsset", () => {
  it("POSTs the address, asset and amount to /api/faucet", async () => {
    const s = await loadStellar(ISSUER);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ hash: "h" }) });
    vi.stubGlobal("fetch", fetchMock);

    expect(await s.faucetAsset(TOKEN_ID, ISSUER, BigInt(100))).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/faucet");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      address: ISSUER,
      asset: TOKEN_ID,
      amount: "100",
    });
  });

  it("reports no faucet rather than throwing when none is available", async () => {
    // 503 (no issuer key for this asset) and 403 (mainnet) both mean "fund the
    // wallet yourself", which the caller turns into an explanation instead of
    // an error.
    const s = await loadStellar(ISSUER);
    for (const status of [503, 403]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status, json: async () => ({}) }),
      );
      expect(await s.faucetAsset(TOKEN_ID, ISSUER, BigInt(100))).toBe(false);
    }
  });

  it("throws with the server error message on a failed response", async () => {
    const s = await loadStellar(ISSUER);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: "trustline missing" }),
      }),
    );
    await expect(s.faucetAsset(TOKEN_ID, ISSUER, BigInt(100))).rejects.toThrow(
      "trustline missing",
    );
  });
});

describe("isMainnet / getDevKeypair", () => {
  async function loadOnNetwork(passphrase: string, devSecret: string) {
    vi.resetModules();
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = passphrase;
    process.env.NEXT_PUBLIC_DEV_SECRET_KEY = devSecret;
    return await import("./stellar");
  }

  const DEV_SECRET = StellarSdk.Keypair.random().secret();

  it("recognises the public network as mainnet", async () => {
    const s = await loadOnNetwork(StellarSdk.Networks.PUBLIC, "");
    expect(s.isMainnet()).toBe(true);
  });

  it("does not treat a test network as mainnet", async () => {
    const s = await loadOnNetwork(PASSPHRASE, "");
    expect(s.isMainnet()).toBe(false);
  });

  it("ignores a dev signing key on mainnet", async () => {
    // NEXT_PUBLIC_* is inlined into the client bundle, so honouring this key
    // against real funds would publish a spending key to every visitor.
    const s = await loadOnNetwork(StellarSdk.Networks.PUBLIC, DEV_SECRET);
    expect(s.getDevKeypair()).toBeNull();
  });

  it("still honours a dev signing key on a test network", async () => {
    const s = await loadOnNetwork(PASSPHRASE, DEV_SECRET);
    expect(s.getDevKeypair()?.secret()).toBe(DEV_SECRET);
  });
});

describe("relayWithdrawal", () => {
  const params = {
    poolId: "CBRRTOJWMDAJEYUK2R7MKY6NGABXL52GEKKBXCIUPXOFHOFM5YPIA7WF",
    recipient: ISSUER,
    publicInputs: "00",
    proof: "00",
    asset: TOKEN_ID,
  };

  it("returns null on 503 so the caller can fall back to wallet signing", async () => {
    const s = await loadStellar(ISSUER);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 503, ok: false, json: async () => ({}) }),
    );
    expect(await s.relayWithdrawal(params)).toBeNull();
  });

  it("returns the relay result on success", async () => {
    const s = await loadStellar(ISSUER);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ hash: "tx123", relayer: "GRELAYER" }),
      }),
    );
    expect(await s.relayWithdrawal(params)).toEqual({
      hash: "tx123",
      relayer: "GRELAYER",
    });
  });

  it("throws with the server error on a non-ok, non-503 response", async () => {
    const s = await loadStellar(ISSUER);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 400,
        ok: false,
        json: async () => ({ error: "Withdrawal simulation failed" }),
      }),
    );
    await expect(s.relayWithdrawal(params)).rejects.toThrow(
      "Withdrawal simulation failed",
    );
  });

  it("carries feeAmount through when the relayer reports one", async () => {
    const s = await loadStellar(ISSUER);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: async () => ({ hash: "tx123", relayer: "GRELAYER", feeAmount: "100000" }),
      }),
    );
    expect(await s.relayWithdrawal(params)).toEqual({
      hash: "tx123",
      relayer: "GRELAYER",
      feeAmount: "100000",
    });
  });
});

describe("quoteFeeSwap", () => {
  it("returns null when no DEX router or fee asset is configured", async () => {
    const s = await loadStellarWithDex("", "");
    expect(await s.quoteFeeSwap(TOKEN_ID, "100000")).toBeNull();
  });

  it("returns null for a zero or negative fee amount without any network call", async () => {
    const s = await loadStellarWithDex();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await s.quoteFeeSwap(TOKEN_ID, "0")).toBeNull();
    expect(await s.quoteFeeSwap(TOKEN_ID, "-5")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchWithdrawFeeQuote", () => {
  const POOL_ID = "CBRRTOJWMDAJEYUK2R7MKY6NGABXL52GEKKBXCIUPXOFHOFM5YPIA7WF";

  it("returns the zero-fee fallback on a non-ok response", async () => {
    const s = await loadStellarWithDex();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );
    expect(await s.fetchWithdrawFeeQuote(POOL_ID, TOKEN_ID)).toEqual({
      feeAmount: "0",
      expectedXlmOut: "0",
      minXlmOut: "0",
    });
  });

  it("returns the zero-fee fallback when the request throws", async () => {
    const s = await loadStellarWithDex();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await s.fetchWithdrawFeeQuote(POOL_ID, TOKEN_ID)).toEqual({
      feeAmount: "0",
      expectedXlmOut: "0",
      minXlmOut: "0",
    });
  });

  it("returns the server's quote on success", async () => {
    const s = await loadStellarWithDex();
    const quote = { feeAmount: "100000", expectedXlmOut: "50000", minXlmOut: "49500" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => quote }),
    );
    expect(await s.fetchWithdrawFeeQuote(POOL_ID, TOKEN_ID)).toEqual(quote);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/relay-withdraw-quote");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      poolId: POOL_ID,
      asset: TOKEN_ID,
    });
  });
});
