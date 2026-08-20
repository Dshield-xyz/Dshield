import { describe, it, expect, vi, afterEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

const ISSUER = "GABZWK2YLPOGBEOZT6VOCID6ROSSZGPSLAEPCTWIBGAJDHISO6DFKYYZ";
const PASSPHRASE = "Standalone Network ; February 2017";

// stellar.ts reads NEXT_PUBLIC_* env at module load, so each scenario reloads
// the module with the desired env (same pattern as indexer.test.ts).
async function loadStellar(issuer = "", devSecret = "") {
  vi.resetModules();
  process.env.NEXT_PUBLIC_USDC_ISSUER = issuer;
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE = PASSPHRASE;
  process.env.NEXT_PUBLIC_DEV_SECRET_KEY = devSecret;
  return await import("./stellar");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
});

describe("dev key guard (NEXT_PUBLIC_DEV_SECRET_KEY)", () => {
  const VALID_SECRET = StellarSdk.Keypair.random().secret();

  it("canUseDevKey allows in non-production builds with no window hostname info", async () => {
    const s = await loadStellar("", VALID_SECRET);
    expect(s.canUseDevKey()).toBe(true);
  });

  it("canUseDevKey blocks when NODE_ENV is production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const s = await loadStellar("", VALID_SECRET);
    expect(s.canUseDevKey()).toBe(false);
  });

  it("canUseDevKey blocks on non-localhost origins even in dev builds", async () => {
    vi.stubGlobal("location", { hostname: "staging.dshield.example.com" });
    const s = await loadStellar("", VALID_SECRET);
    expect(s.canUseDevKey()).toBe(false);
  });

  it("canUseDevKey allows on localhost origins", async () => {
    vi.stubGlobal("location", { hostname: "localhost" });
    const s = await loadStellar("", VALID_SECRET);
    expect(s.canUseDevKey()).toBe(true);
  });

  it("returns null (no warning) when no dev key is configured", async () => {
    const s = await loadStellar("");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(s.getDevKeypair()).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the keypair when the dev key is set and the guard passes", async () => {
    const kp = StellarSdk.Keypair.random();
    vi.stubGlobal("location", { hostname: "localhost" });
    const s = await loadStellar("", kp.secret());
    expect(s.getDevKeypair()?.publicKey()).toBe(kp.publicKey());
  });

  it("is inert and warns loudly when the dev key is set but the guard blocks it", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = await loadStellar("", VALID_SECRET);
    expect(s.getDevKeypair()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
