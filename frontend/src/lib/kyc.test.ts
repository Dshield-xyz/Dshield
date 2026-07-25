import { describe, it, expect, beforeEach } from "vitest";
import { saveKyc, getKyc, clearKyc, type KycRecord } from "./kyc";

function makeKycRecord(overrides: Partial<KycRecord> = {}): KycRecord {
  return {
    preimage: "test-preimage-123",
    hash: "test-hash-456",
    registeredOnChain: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe("saveKyc / getKyc", () => {
  it("returns null when nothing saved", () => {
    expect(getKyc()).toBeNull();
  });

  it("saves and retrieves a KYC record", async () => {
    const record = makeKycRecord();
    await saveKyc(record);
    const retrieved = getKyc();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.preimage).toBe("test-preimage-123");
    expect(retrieved!.hash).toBe("test-hash-456");
    expect(retrieved!.registeredOnChain).toBe(false);
  });

  it("overwrites existing KYC record", async () => {
    await saveKyc(makeKycRecord({ preimage: "first" }));
    await saveKyc(makeKycRecord({ preimage: "second" }));
    const retrieved = getKyc();
    expect(retrieved!.preimage).toBe("second");
  });
});

describe("clearKyc", () => {
  it("removes KYC record from storage", async () => {
    await saveKyc(makeKycRecord());
    expect(getKyc()).not.toBeNull();
    clearKyc();
    expect(getKyc()).toBeNull();
  });

  it("does not throw when clearing non-existent record", () => {
    expect(() => clearKyc()).not.toThrow();
  });
});

describe("Cross-tab synchronization", () => {
  it("concurrent saves do not corrupt data", async () => {
    const record1 = makeKycRecord({ preimage: "concurrent1" });
    const record2 = makeKycRecord({ preimage: "concurrent2" });

    // Fire both saves simultaneously - last one should win cleanly
    await Promise.all([saveKyc(record1), saveKyc(record2)]);

    const retrieved = getKyc();
    expect(retrieved).not.toBeNull();
    // One of them should have won (not corrupted JSON)
    expect(["concurrent1", "concurrent2"]).toContain(retrieved!.preimage);
  });

  it("lock timeout throws error if lock cannot be acquired", async () => {
    // Manually set a lock with a recent timestamp that won't be considered stale
    const stubbornLock = JSON.stringify({
      id: "stuck-lock",
      timestamp: Date.now() // Fresh timestamp, won't be cleared as stale
    });
    localStorage.setItem("dshield_kyc_lock", stubbornLock);

    // Attempt to save should timeout and throw
    await expect(saveKyc(makeKycRecord())).rejects.toThrow(
      "Failed to acquire KYC storage lock after timeout"
    );

    // Clean up
    localStorage.removeItem("dshield_kyc_lock");
  }, 10000); // 10 second timeout for this test
});
