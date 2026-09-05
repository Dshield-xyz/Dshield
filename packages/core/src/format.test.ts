import { describe, it, expect } from "vitest";
import {
  DEFAULT_DECIMALS,
  toBaseUnits,
  fromBaseUnits,
  formatUnits,
  truncateMiddle,
} from "./format.js";

describe("toBaseUnits", () => {
  it("converts whole and fractional amounts exactly", () => {
    expect(toBaseUnits("1", 7)).toBe("10000000");
    expect(toBaseUnits("0.5", 7)).toBe("5000000");
    expect(toBaseUnits("137.42", 7)).toBe("1374200000");
  });

  it("is exact for values a float round-trip would corrupt", () => {
    // The amount is hashed into the note's commitment AND transferred on-chain.
    // If the two disagree by one unit the note can never be withdrawn, and
    // nothing surfaces the problem until proving fails.
    expect(toBaseUnits("1234567.8912345", 7)).toBe("12345678912345");
    expect(toBaseUnits("0.0000001", 7)).toBe("1");
  });

  it("scales to the asset's own precision, not a fixed 7", () => {
    expect(toBaseUnits("1", 6)).toBe("1000000");
    expect(toBaseUnits("1", 18)).toBe("1000000000000000000");
    expect(toBaseUnits("1.5", 2)).toBe("150");
    expect(toBaseUnits("42", 0)).toBe("42");
  });

  it("truncates beyond the asset's precision rather than rounding up", () => {
    // Rounding up would ask the wallet for more than the user typed.
    expect(toBaseUnits("0.00000019", 7)).toBe("1");
    expect(toBaseUnits("1.999", 2)).toBe("199");
  });

  it("returns 0 for input that isn't a plain decimal amount", () => {
    for (const bad of ["", ".", "abc", "-1", "1e5", "0x10", " 1.2.3 "]) {
      expect(toBaseUnits(bad, 7)).toBe("0");
    }
  });

  it("tolerates surrounding whitespace and a bare leading dot", () => {
    expect(toBaseUnits("  2.5  ", 7)).toBe("25000000");
    expect(toBaseUnits(".5", 7)).toBe("5000000");
    expect(toBaseUnits("3.", 7)).toBe("30000000");
  });

  it("defaults to the SAC convention when no precision is given", () => {
    expect(toBaseUnits("1")).toBe(toBaseUnits("1", DEFAULT_DECIMALS));
  });
});

describe("fromBaseUnits", () => {
  it("shows only the decimals a value actually needs", () => {
    expect(fromBaseUnits("10000000", 7)).toBe("1");
    expect(fromBaseUnits("15000000", 7)).toBe("1.5");
    expect(fromBaseUnits("1374200000", 7)).toBe("137.42");
  });

  it("never rounds a non-zero balance away to zero", () => {
    // A change note worth 0.4 displayed as "0" would read as "gone".
    expect(fromBaseUnits("4000000", 7)).toBe("0.4");
    expect(fromBaseUnits("1", 7)).not.toBe("0");
  });

  it("renders at the asset's own precision", () => {
    expect(fromBaseUnits("1000000", 6)).toBe("1");
    expect(fromBaseUnits("1000000000000000000", 18)).toBe("1");
    expect(fromBaseUnits("150", 2)).toBe("1.5");
    expect(fromBaseUnits("42", 0)).toBe("42");
  });

  it("handles zero, bigint, and number inputs", () => {
    expect(fromBaseUnits("0", 7)).toBe("0");
    expect(fromBaseUnits(BigInt("25000000"), 7)).toBe("2.5");
    expect(fromBaseUnits(25000000, 7)).toBe("2.5");
  });

  it("stays exact past the precision a JS number can hold", () => {
    expect(fromBaseUnits("90071992547409910", 7)).toBe("9007199254.740991");
    expect(fromBaseUnits("18446744073709551615", 7)).toBe("1844674407370.9551615");
  });

  it("degrades to 0 rather than throwing on unparseable input", () => {
    expect(fromBaseUnits("not-a-number", 7)).toBe("0");
  });

  it("round-trips against toBaseUnits at any precision", () => {
    for (const decimals of [0, 2, 6, 7, 18]) {
      for (const amount of ["1", "42", "137"]) {
        expect(fromBaseUnits(toBaseUnits(amount, decimals), decimals)).toBe(amount);
      }
    }
    expect(fromBaseUnits(toBaseUnits("0.5", 7), 7)).toBe("0.5");
    expect(fromBaseUnits(toBaseUnits("1234567.8912345", 7), 7)).toBe("1234567.8912345");
  });
});

describe("formatUnits", () => {
  it("labels the amount with the asset's own symbol", () => {
    expect(formatUnits("15000000", "XLM", 7)).toBe("1.5 XLM");
    expect(formatUnits("1500000", "USDC", 6)).toBe("1.5 USDC");
  });
});

describe("truncateMiddle", () => {
  it("elides the middle of a long identifier", () => {
    expect(truncateMiddle("abcdef123456", 4, 4)).toBe("abcd…3456");
  });

  it("leaves a short value alone", () => {
    expect(truncateMiddle("abcd", 4, 4)).toBe("abcd");
  });
});
