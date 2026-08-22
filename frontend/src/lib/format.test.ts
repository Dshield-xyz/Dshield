import { describe, it, expect } from "vitest";
import {
  formatAmount,
  formatAmountBare,
  usdcToStroops,
  TOKEN_DECIMALS,
} from "./format";

const SCALE = BigInt(10) ** BigInt(TOKEN_DECIMALS);

describe("usdcToStroops", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(usdcToStroops("1")).toBe(SCALE.toString());
    expect(usdcToStroops("10")).toBe((SCALE * BigInt(10)).toString());
    expect(usdcToStroops("0.5")).toBe((SCALE / BigInt(2)).toString());
    expect(usdcToStroops("137.42")).toBe("1374200000");
  });

  it("is exact for values a float round-trip would corrupt", () => {
    // The whole reason this doesn't use parseFloat: the amount is hashed into
    // the note's commitment AND transferred on-chain. If the two disagree by a
    // single stroop the note can never be withdrawn, and nothing surfaces the
    // problem until proving fails a minute into the withdrawal.
    expect(usdcToStroops("1234567.8912345")).toBe("12345678912345");
    expect(usdcToStroops("0.0000001")).toBe("1");
    expect(usdcToStroops("99999999.9999999")).toBe("999999999999999");
  });

  it("truncates beyond the token's precision rather than rounding up", () => {
    // Rounding up would ask the wallet for more than the user typed.
    expect(usdcToStroops("0.00000019")).toBe("1");
    expect(usdcToStroops("1.99999999")).toBe("19999999");
  });

  it("returns 0 for input that isn't a plain decimal amount", () => {
    for (const bad of ["", ".", "abc", "-1", "1e5", "0x10", " 1.2.3 "]) {
      expect(usdcToStroops(bad)).toBe("0");
    }
  });

  it("tolerates surrounding whitespace and a bare leading dot", () => {
    expect(usdcToStroops("  2.5  ")).toBe("25000000");
    expect(usdcToStroops(".5")).toBe("5000000");
    expect(usdcToStroops("3.")).toBe("30000000");
  });
});

describe("formatAmount", () => {
  it("shows only the decimals a value actually needs", () => {
    expect(formatAmount("10000000")).toBe("1 USDC");
    expect(formatAmount("15000000")).toBe("1.5 USDC");
    expect(formatAmount("1374200000")).toBe("137.42 USDC");
    expect(formatAmount("1")).toBe("0.0000001 USDC");
  });

  it("never rounds a non-zero balance away to zero", () => {
    // A change note worth 0.4 displayed as "0 USDC" would read as "gone".
    expect(formatAmountBare("4000000")).toBe("0.4");
    expect(formatAmountBare("1")).not.toBe("0");
  });

  it("handles zero, bigint, and number inputs", () => {
    expect(formatAmount("0")).toBe("0 USDC");
    expect(formatAmount(BigInt("25000000"))).toBe("2.5 USDC");
    expect(formatAmount(25000000)).toBe("2.5 USDC");
  });

  it("stays exact past the precision a JS number can hold", () => {
    expect(formatAmountBare("90071992547409910")).toBe("9007199254.740991");
    expect(formatAmountBare("18446744073709551615")).toBe("1844674407370.9551615");
  });

  it("degrades to 0 rather than throwing on unparseable input", () => {
    expect(formatAmountBare("not-a-number")).toBe("0");
  });

  it("round-trips against usdcToStroops", () => {
    for (const usdc of ["1", "0.5", "137.42", "1234567.8912345", "0.0000001"]) {
      expect(formatAmountBare(usdcToStroops(usdc))).toBe(
        usdc.replace(/^0+(?=\d)/, ""),
      );
    }
  });
});
