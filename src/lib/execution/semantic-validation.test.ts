import { describe, expect, it } from "vitest";
import { encodeFunctionData, getAddress, parseAbi, type Address } from "viem";
import { validateReviewedSwapCalldata, type ReviewedSwapRoute } from "./semantic-validation";

const sell = getAddress("0x0000000000000000000000000000000000000001");
const buy = getAddress("0x0000000000000000000000000000000000000002");
const recipient = getAddress("0x0000000000000000000000000000000000000003");
const spender = getAddress("0x0000000000000000000000000000000000000004");
const target = getAddress("0x0000000000000000000000000000000000000005");
const abi = parseAbi(["function swap(address sellToken,address buyToken,address recipient,uint256 sellAmount,uint256 minimumOutput,address spender)"]);
const route: ReviewedSwapRoute = {
  target: target as Address,
  abi,
  functionName: "swap",
  arguments: { sellToken: 0, buyToken: 1, recipient: 2, sellAmount: 3, minimumOutput: 4, spender: 5 },
  allowedSpenders: [spender as Address],
};
const data = encodeFunctionData({ abi, functionName: "swap", args: [sell, buy, recipient, 100n, 90n, spender] });
const expectation = {
  chainId: 137,
  target,
  data,
  sellToken: sell,
  buyToken: buy,
  recipient,
  sellAmount: 100n,
  minimumOutput: 90n,
  spender,
};

describe("reviewed swap calldata semantic validation", () => {
  it("accepts a reviewed selector with exact authorized arguments", () => {
    expect(validateReviewedSwapCalldata(expectation, [route])).toMatchObject({
      target, sellToken: sell, buyToken: buy, recipient, sellAmount: 100n, minimumOutput: 90n, spender,
    });
  });

  it("rejects an unknown target and an unsupported selector", () => {
    expect(() => validateReviewedSwapCalldata({ ...expectation, target: sell }, [route])).toThrow(/target/i);
    expect(() => validateReviewedSwapCalldata({ ...expectation, data: "0x12345678" }, [route])).toThrow(/selector/i);
  });

  it("rejects calldata that changes recipient, token pair, amount or minimum output", () => {
    const tampered = [
      encodeFunctionData({ abi, functionName: "swap", args: [sell, buy, sell, 100n, 90n, spender] }),
      encodeFunctionData({ abi, functionName: "swap", args: [buy, sell, recipient, 100n, 90n, spender] }),
      encodeFunctionData({ abi, functionName: "swap", args: [sell, buy, recipient, 101n, 90n, spender] }),
      encodeFunctionData({ abi, functionName: "swap", args: [sell, buy, recipient, 100n, 91n, spender] }),
    ];
    for (const candidate of tampered) {
      expect(() => validateReviewedSwapCalldata({ ...expectation, data: candidate }, [route])).toThrow();
    }
  });

  it("rejects an unapproved spender and wrong chain", () => {
    const badSpender = getAddress("0x0000000000000000000000000000000000000006");
    const altered = encodeFunctionData({ abi, functionName: "swap", args: [sell, buy, recipient, 100n, 90n, badSpender] });
    expect(() => validateReviewedSwapCalldata({ ...expectation, data: altered, spender: badSpender }, [route])).toThrow(/spender/i);
    expect(() => validateReviewedSwapCalldata({ ...expectation, chainId: 1 }, [route])).toThrow(/chain/i);
  });
});
