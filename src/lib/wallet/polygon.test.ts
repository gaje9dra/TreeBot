import { describe, expect, it } from "vitest";
import { assessNativeCapital, validateConnectedChain, validateWalletAddress } from "./polygon";

describe("Polygon wallet safety checks", () => {
  it("requires chain ID 137", () => {
    expect(validateConnectedChain(137).valid).toBe(true);
    expect(validateConnectedChain(1).valid).toBe(false);
    expect(validateConnectedChain(undefined).valid).toBe(false);
  });
  it("validates EVM addresses", () => {
    expect(validateWalletAddress("0x0000000000000000000000000000000000000001")).toBe(true);
    expect(validateWalletAddress("invalid")).toBe(false);
    expect(validateWalletAddress(undefined)).toBe(false);
  });
  it("requires 150 POL plus gas reserve", () => {
    expect(assessNativeCapital(152n * 10n ** 18n).eligible).toBe(true);
    const low = assessNativeCapital(151n * 10n ** 18n);
    expect(low.eligible).toBe(false);
    expect(low.shortfallPol).toBe(1);
  });
  it("rejects invalid gas reserve", () => {
    expect(() => assessNativeCapital(1n, -1)).toThrow();
  });
});
