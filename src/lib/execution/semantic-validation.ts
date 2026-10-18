import {
  decodeFunctionData,
  getAddress,
  isAddress,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";

/**
 * A route is explicitly configured by the operator after review of the target ABI.
 * Never accept an ABI or argument mapping from a quote/client request.
 */
export interface ReviewedSwapRoute {
  target: Address;
  abi: Abi;
  functionName: string;
  /** Indexes refer to decoded positional arguments in the reviewed ABI. */
  arguments: {
    sellToken: number;
    buyToken: number;
    recipient: number;
    sellAmount: number;
    minimumOutput: number;
    spender?: number;
  };
  allowedSpenders: readonly Address[];
}

export interface SwapSemanticExpectation {
  chainId: number;
  target: string;
  data: Hex;
  sellToken: string;
  buyToken: string;
  recipient: string;
  sellAmount: bigint;
  minimumOutput: bigint;
  spender?: string | null;
}

export interface ValidatedSwapSemantics {
  selector: Hex;
  target: Address;
  sellToken: Address;
  buyToken: Address;
  recipient: Address;
  sellAmount: bigint;
  minimumOutput: bigint;
  spender: Address | null;
}

/**
 * Decodes and validates only a pre-reviewed ABI route. Unknown selectors and targets
 * fail closed. This does not claim that arbitrary 0x Settler calldata is supported;
 * each deployed route must be reviewed and explicitly configured first.
 */
export function validateReviewedSwapCalldata(
  expected: SwapSemanticExpectation,
  routes: readonly ReviewedSwapRoute[],
): ValidatedSwapSemantics {
  if (expected.chainId !== 137) throw new Error("Only Polygon chain ID 137 is supported.");
  if (!/^0x[0-9a-fA-F]{8}/.test(expected.data)) throw new Error("Malformed swap calldata selector.");
  const addresses = [expected.target, expected.sellToken, expected.buyToken, expected.recipient];
  if (!addresses.every((address) => isAddress(address))) throw new Error("Invalid swap semantic expectation address.");
  if (expected.spender != null && !isAddress(expected.spender)) throw new Error("Invalid expected spender.");
  if (expected.sellAmount <= 0n || expected.minimumOutput <= 0n) throw new Error("Swap amounts must be positive.");
  const target = getAddress(expected.target);
  const route = routes.find((candidate) => isAddress(candidate.target) && getAddress(candidate.target) === target);
  if (!route) throw new Error("Swap target is not in the reviewed route allowlist.");
  const abiFunction = route.abi.find((item) => item.type === "function" && item.name === route.functionName);
  if (!abiFunction || abiFunction.type !== "function") throw new Error("Reviewed route ABI function is missing.");
  const selector = toFunctionSelector(abiFunction);
  if (expected.data.slice(0, 10).toLowerCase() !== selector.toLowerCase()) {
    throw new Error("Swap calldata selector does not match the reviewed route.");
  }
  let decoded: { functionName: string; args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: route.abi, data: expected.data });
  } catch {
    throw new Error("Swap calldata cannot be decoded by the reviewed ABI.");
  }
  if (decoded.functionName !== route.functionName) throw new Error("Decoded function does not match the reviewed route.");
  const args = decoded.args as readonly unknown[];
  const readAddress = (index: number, label: string): Address => {
    const value = args[index];
    if (typeof value !== "string" || !isAddress(value)) throw new Error(`Decoded ${label} is not an address.`);
    return getAddress(value);
  };
  const readUint = (index: number, label: string): bigint => {
    const value = args[index];
    if (typeof value !== "bigint" || value < 0n) throw new Error(`Decoded ${label} is not an unsigned integer.`);
    return value;
  };
  const actual = {
    sellToken: readAddress(route.arguments.sellToken, "sell token"),
    buyToken: readAddress(route.arguments.buyToken, "buy token"),
    recipient: readAddress(route.arguments.recipient, "recipient"),
    sellAmount: readUint(route.arguments.sellAmount, "sell amount"),
    minimumOutput: readUint(route.arguments.minimumOutput, "minimum output"),
    spender: route.arguments.spender === undefined ? null : readAddress(route.arguments.spender, "spender"),
  };
  if (actual.sellToken !== getAddress(expected.sellToken) || actual.buyToken !== getAddress(expected.buyToken)) {
    throw new Error("Decoded token pair does not match the authorized intent.");
  }
  if (actual.recipient !== getAddress(expected.recipient)) throw new Error("Decoded recipient does not match the authorized recipient.");
  if (actual.sellAmount !== expected.sellAmount) throw new Error("Decoded input amount does not match the authorized amount.");
  if (actual.minimumOutput !== expected.minimumOutput) throw new Error("Decoded minimum output does not match the authorized minimum.");
  if (actual.spender !== null) {
    if (!route.allowedSpenders.some((spender) => isAddress(spender) && getAddress(spender) === actual.spender)) {
      throw new Error("Decoded spender is not in the reviewed spender allowlist.");
    }
    if (expected.spender == null || actual.spender !== getAddress(expected.spender)) {
      throw new Error("Decoded spender does not match the authorized spender.");
    }
  } else if (expected.spender != null) {
    throw new Error("Authorized spender was supplied but the reviewed route has no spender argument.");
  }
  return { selector, target, ...actual };
}
