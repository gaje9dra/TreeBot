import { describe, expect, it } from "vitest";
import { assertNonNegativeBaseUnits, assertPositiveBaseUnits, divideScaled, formatUnitsExact, parseUnitsExact } from "./amounts";

describe("exact financial arithmetic", () => {
  it("parses and formats base units without floats", () => {
    expect(parseUnitsExact("0.000000000000000001",18)).toBe(1n);
    expect(parseUnitsExact("12.3400",6)).toBe(12340000n);
    expect(formatUnitsExact(12340000n,6)).toBe("12.34");
    expect(formatUnitsExact(1n,18)).toBe("0.000000000000000001");
  });
  it("rejects rounding, exponent notation, signs and invalid decimals", () => {
    expect(() => parseUnitsExact("1.0000001",6)).toThrow(/fractional digits/);
    expect(() => parseUnitsExact("1e3",18)).toThrow();
    expect(() => parseUnitsExact("-1",18)).toThrow();
    expect(() => parseUnitsExact(" 1",18)).toThrow();
    expect(() => parseUnitsExact("1",37)).toThrow();
  });
  it("validates base-unit strings", () => {
    expect(assertPositiveBaseUnits("1000000000000000000")).toBe(1000000000000000000n);
    expect(assertNonNegativeBaseUnits("0")).toBe(0n);
    expect(() => assertPositiveBaseUnits("0")).toThrow();
    expect(() => assertNonNegativeBaseUnits("-5")).toThrow();
  });
  it("does exact rational division with truncation toward zero", () => {
    expect(divideScaled(1n,3n,6)).toBe("0.333333");
    expect(divideScaled(2n,1n,2)).toBe("2");
  });
});
