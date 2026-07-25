import { describe, it, expect, vi } from "vitest";
import { saveKyc, getKyc, clearKyc, onKycChange, type KycRecord } from "./kyc";

function makeKyc(overrides: Partial<KycRecord> = {}): KycRecord {
  return {
    preimage: "00aabbcc",
    hash: "ddeeff00",
    registeredOnChain: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("saveKyc / getKyc", () => {
  it("returns null when nothing saved", () => {
    expect(getKyc()).toBeNull();
  });

  it("saves and retrieves a KYC record", () => {
    const kyc = makeKyc();
    saveKyc(kyc);
    const retrieved = getKyc();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.preimage).toBe("00aabbcc");
    expect(retrieved!.hash).toBe("ddeeff00");
    expect(retrieved!.registeredOnChain).toBe(true);
  });

  it("overwrites previous KYC record", () => {
    saveKyc(makeKyc({ hash: "first" }));
    saveKyc(makeKyc({ hash: "second" }));
    expect(getKyc()!.hash).toBe("second");
  });
});

describe("clearKyc", () => {
  it("removes stored KYC data", () => {
    saveKyc(makeKyc());
    expect(getKyc()).not.toBeNull();
    clearKyc();
    expect(getKyc()).toBeNull();
  });

  it("does not throw when nothing to clear", () => {
    expect(() => clearKyc()).not.toThrow();
  });
});

describe("onKycChange", () => {
  it("triggers listener on storage event", () => {
    const spy = vi.fn();
    const unsubscribe = onKycChange(spy);

    saveKyc(makeKyc({ hash: "test-event" }));
    const event = new StorageEvent("storage", { key: "dshield_kyc" });
    window.dispatchEvent(event);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ hash: "test-event" }));

    unsubscribe();
  });
});

