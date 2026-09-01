import { describe, it, expect } from "vitest";
import { friendlyError } from "./errors";

describe("friendlyError — hardware wallet (Ledger) failures", () => {
  it("maps a locked device to an unlock hint", () => {
    expect(friendlyError(new Error("Locked device"))).toBe(
      "Your Ledger is locked — unlock it and try again.",
    );
    expect(friendlyError(new Error("Device is locked"))).toBe(
      "Your Ledger is locked — unlock it and try again.",
    );
    expect(friendlyError(new Error("Please unlock your device"))).toBe(
      "Your Ledger is locked — unlock it and try again.",
    );
  });

  it("maps wrong-app status codes to an 'open the Stellar app' hint", () => {
    // 0x6d00 (INS not supported) / 0x6e00 (CLA not supported) are how
    // hw-app-str surfaces "the Stellar app is not open on the device".
    expect(friendlyError(new Error("Invalid status 6d00"))).toBe(
      "Open the Stellar app on your Ledger and try again.",
    );
    expect(friendlyError(new Error("Invalid status 0x6e00"))).toBe(
      "Open the Stellar app on your Ledger and try again.",
    );
    expect(friendlyError(new Error("Wrong app for signature"))).toBe(
      "Open the Stellar app on your Ledger and try again.",
    );
  });

  it("maps an on-device rejection to a device-specific cancel message", () => {
    expect(
      friendlyError(new Error("Condition of use not satisfied, denied by the user")),
    ).toBe("Cancelled — you declined the request on your Ledger device.");
  });

  it("maps missing-device / WebUSB failures to a connect hint", () => {
    expect(friendlyError(new Error("No WebUSB device found"))).toBe(
      "Couldn't reach your Ledger device — connect it via USB, allow the browser to access it, and try again.",
    );
    expect(friendlyError(new Error("Ledger can not be used with this device."))).toBe(
      "Couldn't reach your Ledger device — connect it via USB, allow the browser to access it, and try again.",
    );
    expect(friendlyError(new Error("Ledger Transport was not created."))).toBe(
      "Couldn't reach your Ledger device — connect it via USB, allow the browser to access it, and try again.",
    );
  });

  it("still maps plain software-wallet declines to the generic cancel message", () => {
    expect(friendlyError(new Error("User rejected the request"))).toBe(
      "Cancelled — you declined the signature in your wallet.",
    );
    expect(friendlyError(new Error("The user declined access"))).toBe(
      "Cancelled — you declined the signature in your wallet.",
    );
  });
});