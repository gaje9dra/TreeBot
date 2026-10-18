import { describe, expect, it } from "vitest";
import { assertTransactionTransition, canTransitionTransaction, classifySubmissionError } from "./lifecycle";

describe("transaction lifecycle", () => {
  it("allows pending-to-confirmed/reverted and prevents terminal state reuse", () => {
    expect(canTransitionTransaction("pending", "confirmed")).toBe(true);
    expect(canTransitionTransaction("pending", "reverted")).toBe(true);
    expect(canTransitionTransaction("confirmed", "pending")).toBe(false);
    expect(() => assertTransactionTransition("confirmed", "pending")).toThrow();
  });
  it("treats RPC submission timeouts as unknown and never immediately retryable", () => {
    expect(classifySubmissionError(new Error("socket timeout"))).toEqual({
      status: "unknown", retryAllowed: false, message: "socket timeout",
    });
  });
});
