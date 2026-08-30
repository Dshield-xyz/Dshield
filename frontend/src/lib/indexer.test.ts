import { describe, it, expect, vi, afterEach } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./stellar");
});

describe("indexer", () => {
  it("syncDepositsFromChain is importable", async () => {
    const mod = await import("./indexer");
    expect(typeof mod.syncDepositsFromChain).toBe("function");
  });

  it("syncDepositsFromChain returns 0 when POOL_CONTRACT_ID is empty", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "",
      getRpcServer: vi.fn(),
      queryContract: vi.fn(),
    }));
    const { syncDepositsFromChain } = await import("./indexer");
    const result = await syncDepositsFromChain();
    expect(result).toBe(0);
  });
});

describe("fetchMerkleProofFromService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when no service URL is configured", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "POOL_X",
      INDEXER_SERVICE_URL: "",
      getRpcServer: vi.fn(),
      queryContract: vi.fn(),
    }));
    const { fetchMerkleProofFromService } = await import("./indexer");
    expect(await fetchMerkleProofFromService("POOL_X", 0)).toBeNull();
  });

  it("returns null when the request fails", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "POOL_X",
      INDEXER_SERVICE_URL: "http://localhost:8091",
      getRpcServer: vi.fn(),
      queryContract: vi.fn(),
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { fetchMerkleProofFromService } = await import("./indexer");
    expect(await fetchMerkleProofFromService("POOL_X", 0)).toBeNull();
  });

  it("returns null when the service reports a different pool", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "POOL_X",
      INDEXER_SERVICE_URL: "http://localhost:8091",
      getRpcServer: vi.fn(),
      queryContract: vi.fn(),
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          poolId: "POOL_OTHER",
          root: "0x" + "00".repeat(32),
          pathSiblings: [],
          pathBits: [],
        }),
      }),
    );
    const { fetchMerkleProofFromService } = await import("./indexer");
    expect(await fetchMerkleProofFromService("POOL_X", 0)).toBeNull();
  });

  it("returns the proof when the service reports the requested pool", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "POOL_X",
      INDEXER_SERVICE_URL: "http://localhost:8091/",
      getRpcServer: vi.fn(),
      queryContract: vi.fn(),
    }));
    const root = "0x" + "ab".repeat(32);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        poolId: "POOL_X",
        root,
        pathSiblings: ["0x01"],
        pathBits: [1],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { fetchMerkleProofFromService } = await import("./indexer");
    expect(await fetchMerkleProofFromService("POOL_X", 5)).toEqual({
      root,
      pathSiblings: ["0x01"],
      pathBits: [1],
    });
    // Trailing slash on the base URL must not produce a doubled slash.
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:8091/proof/5");
  });
});

describe("fetchCommitmentsFromChain", () => {
  it("returns null when no pool id is configured", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "",
      getRpcServer: vi.fn(),
      queryContract: vi.fn(),
    }));
    const { fetchCommitmentsFromChain } = await import("./indexer");
    expect(await fetchCommitmentsFromChain()).toBeNull();
  });

  it("returns null when the contract call fails", async () => {
    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "POOL_X",
      getRpcServer: vi.fn(),
      queryContract: vi.fn().mockResolvedValue(null),
    }));
    const { fetchCommitmentsFromChain } = await import("./indexer");
    expect(await fetchCommitmentsFromChain("POOL_X")).toBeNull();
  });

  it("returns ordered 0x-prefixed 32-byte hex commitments", async () => {
    const leaf0 = new Uint8Array(32).fill(0);
    leaf0[31] = 0xaa;
    const leaf1 = new Uint8Array(32).fill(0);
    leaf1[31] = 0xbb;
    // get_commitments returns an ScVec of ScBytes; build it so scValToNative
    // yields the array of byte buffers the function expects.
    const scVal = StellarSdk.nativeToScVal([Buffer.from(leaf0), Buffer.from(leaf1)]);

    vi.doMock("./stellar", () => ({
      POOL_CONTRACT_ID: "POOL_X",
      getRpcServer: vi.fn(),
      queryContract: vi.fn().mockResolvedValue(scVal),
    }));
    const { fetchCommitmentsFromChain } = await import("./indexer");
    const result = await fetchCommitmentsFromChain("POOL_X");
    expect(result).toEqual([
      "0x" + "00".repeat(31) + "aa",
      "0x" + "00".repeat(31) + "bb",
    ]);
  });
});
