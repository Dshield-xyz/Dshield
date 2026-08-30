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

describe("getUsdcAsset / getUsdcSacId", () => {
  it("returns null when no issuer is configured", async () => {
    const s = await loadStellar("");
    expect(s.getUsdcAsset()).toBeNull();
    expect(s.getUsdcSacId()).toBeNull();
  });

  it("derives the deterministic SAC id matching the SDK", async () => {
    const s = await loadStellar(ISSUER);
    const expected = new StellarSdk.Asset("USDC", ISSUER).contractId(PASSPHRASE);
    expect(s.getUsdcSacId()).toBe(expected);
    // Sanity: a contract (C...) strkey.
    expect(StellarSdk.StrKey.isValidContract(s.getUsdcSacId()!)).toBe(true);
  });
});

describe("faucetUsdc", () => {
  it("no-ops (no request) when no asset is configured", async () => {
    const s = await loadStellar("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await s.faucetUsdc(ISSUER, 100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs the address and amount to /api/faucet", async () => {
    const s = await loadStellar(ISSUER);
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ hash: "h" }) });
    vi.stubGlobal("fetch", fetchMock);

    await s.faucetUsdc(ISSUER, BigInt(100));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/faucet");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ address: ISSUER, amount: "100" });
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
    await expect(s.faucetUsdc(ISSUER, BigInt(100))).rejects.toThrow("trustline missing");
  });
});

describe("relayWithdrawal", () => {
  const params = {
    poolId: "CBRRTOJWMDAJEYUK2R7MKY6NGABXL52GEKKBXCIUPXOFHOFM5YPIA7WF",
    recipient: ISSUER,
    publicInputs: "00",
    proof: "00",
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
    expect(await s.fetchWithdrawFeeQuote(POOL_ID)).toEqual({
      feeAmount: "0",
      expectedXlmOut: "0",
      minXlmOut: "0",
    });
  });

  it("returns the zero-fee fallback when the request throws", async () => {
    const s = await loadStellarWithDex();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    expect(await s.fetchWithdrawFeeQuote(POOL_ID)).toEqual({
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
    expect(await s.fetchWithdrawFeeQuote(POOL_ID)).toEqual(quote);

    const fetchMock = vi.mocked(globalThis.fetch);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/relay-withdraw-quote");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ poolId: POOL_ID });
  });
});
