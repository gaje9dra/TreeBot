/**
 * Exact base-unit helpers for financial accounting. Avoid JS Number for token quantities.
 */
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const POSITIVE_UINT_RE = /^[1-9][0-9]*$/;

export function parseUnitsExact(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Token decimals must be an integer from 0 to 36.");
  }
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.startsWith("-") || value.startsWith("+")) {
    throw new Error("Amount must be a non-negative decimal string without signs or whitespace.");
  }
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(value);
  if (!match) throw new Error("Amount must be a plain decimal string.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error("Amount has more fractional digits than the token supports.");
  const base = 10n ** BigInt(decimals);
  return BigInt(match[1]!) * base + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function formatUnitsExact(value: bigint, decimals: number): string {
  if (value < 0n) throw new Error("Amount cannot be negative.");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Token decimals must be an integer from 0 to 36.");
  if (decimals === 0) return value.toString();
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return fraction ? whole + "." + fraction : whole;
}

export function assertPositiveBaseUnits(value: string, label = "amount"): bigint {
  if (!POSITIVE_UINT_RE.test(value)) throw new Error(`Invalid ${label}: expected a positive base-unit integer.`);
  return BigInt(value);
}

export function assertNonNegativeBaseUnits(value: string, label = "amount"): bigint {
  if (!UINT_RE.test(value)) throw new Error(`Invalid ${label}: expected a non-negative base-unit integer.`);
  return BigInt(value);
}

/** Divide exact base-unit integers using rational arithmetic and render a decimal string. */
export function divideScaled(numerator: bigint, denominator: bigint, precision = 18): string {
  if (numerator < 0n || denominator <= 0n) throw new Error("Invalid rational amount.");
  if (!Number.isInteger(precision) || precision < 0 || precision > 36) throw new Error("Invalid rational precision.");
  const scale = 10n ** BigInt(precision);
  return formatUnitsExact(numerator * scale / denominator, precision);
}
