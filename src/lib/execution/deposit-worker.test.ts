import { describe, expect, it } from "vitest";
import type { Hash } from "viem";
import {
  assertDepositWorkerActivation,
  assertRpcProviderAgreement,
  parseDepositWorkerSettings,
  shouldNotifyDepositAlert,
} from "./deposit-worker";
import type { DepositRangeReader } from "./deposit-scanner";

const token = "0x0000000000000000000000000000000000000020";
const vault = "0x0000000000000000000000000000000000000030";
const sender = "0x0000000000000000000000000000000000000040";
const accountId = "account-1";

function validEnv(): Record<string, string> {
  return {
    TREEBOT_DEPOSITS_ENABLED: "true",
    TREEBOT_DEPOSITS_OPERATOR_APPROVED: "true",
    TREEBOT_DEPOSITS_SECURITY_REVIEWED: "true",
    TREEBOT_DEPOSITS_NETWORK_VERIFIED: "true",
    TREEBOT_DEPOSIT_ALERT_WEBHOOK: "https://alerts.example.test/treebot",
    POLYGON_RPC_URL: "https://polygon-primary.example.test/rpc",
    POLYGON_RPC_FALLBACK_URL: "https://polygon-fallback.example.test/rpc",
    TREEBOT_DEPOSIT_WATCHER_KEY: "polygon-vault-main",
    TREEBOT_DEPOSIT_VAULT_ADDRESS: vault,
    TREEBOT_DEPOSIT_TOKENS_JSON: JSON.stringify([token]),
    TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON: JSON.stringify({ [token]: 6 }),
    TREEBOT_DEPOSIT_SENDER_MAP_JSON: JSON.stringify({ [sender]: accountId }),
    TREEBOT_DEPOSIT_START_BLOCK: "100",
    TREEBOT_DEPOSIT_CONFIRMATIONS: "64",
    TREEBOT_DEPOSIT_MAX_BLOCK_RANGE: "100",
    TREEBOT_DEPOSIT_POLL_INTERVAL_MS: "10000",
    TREEBOT_DEPOSIT_STALL_AFTER_MS: "120000",
  };
}

describe("deposit worker release configuration", () => {
  it("validates explicit RPC, token-decimals and sender-mapping policy", () => {
    const settings = parseDepositWorkerSettings(validEnv());
    expect(settings).toMatchObject({
      workerKey: "polygon-vault-main",
      vaultAddress: vault,
      tokenAddresses: [token],
      tokenDecimalsByAddress: { [token]: 6 },
      senderAccountMap: { [sender]: accountId },
      startBlock: 100n,
      confirmations: 64,
      maxBlockRange: 100,
    });
  });

  it("rejects a token allowlist without explicit decimals", () => {
    const env = validEnv();
    env.TREEBOT_DEPOSIT_TOKEN_DECIMALS_JSON = "{}";
    expect(() => parseDepositWorkerSettings(env)).toThrow(/explicit token-decimals/);
  });

  it("rejects duplicate RPC providers", () => {
    const env = validEnv();
    env.POLYGON_RPC_FALLBACK_URL = env.POLYGON_RPC_URL;
    expect(() => parseDepositWorkerSettings(env)).toThrow(/must be different/);
  });

  it("does not activate deposits while the build-level release gate is false", () => {
    expect(() => assertDepositWorkerActivation(validEnv())).toThrow(/hard-disabled in this build/);
  });
});

function fakeReader(input: { chainId?: number; head: bigint; hash?: Hash }): DepositRangeReader {
  const blockHash = input.hash ?? ("0x" + "a".repeat(64)) as Hash;
  return {
    getChainId: async () => input.chainId ?? 137,
    getBlockNumber: async () => input.head,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, hash: blockHash, parentHash: blockHash }),
    getLogs: async () => [],
    getTransactionReceipt: async () => { throw new Error("unused"); },
    getTransaction: async () => { throw new Error("unused"); },
  } as unknown as DepositRangeReader;
}

describe("deposit worker alert throttling", () => {
  const now = Date.parse("2026-10-19T12:00:00.000Z");

  it("notifies immediately when an existing warning escalates to critical", () => {
    expect(shouldNotifyDepositAlert({
      resolvedAt: null,
      lastNotifiedAt: new Date(now - 1_000),
      severity: "warning",
    }, "critical", now)).toBe(true);
  });

  it("throttles repeated alerts of the same severity", () => {
    expect(shouldNotifyDepositAlert({
      resolvedAt: null,
      lastNotifiedAt: new Date(now - 60_000),
      severity: "critical",
    }, "critical", now)).toBe(false);
  });

  it("notifies again after the throttle interval or when an alert is resolved", () => {
    expect(shouldNotifyDepositAlert({
      resolvedAt: null,
      lastNotifiedAt: new Date(now - 15 * 60_000),
      severity: "warning",
    }, "warning", now)).toBe(true);
    expect(shouldNotifyDepositAlert({
      resolvedAt: new Date(now - 1_000),
      lastNotifiedAt: new Date(now - 1_000),
      severity: "warning",
    }, "warning", now)).toBe(true);
  });
});

describe("deposit worker RPC agreement", () => {
  it("checks the same finalized block against both RPC providers", async () => {
    const primary = fakeReader({ head: 100n });
    const fallback = fakeReader({ head: 100n });
    await expect(assertRpcProviderAgreement(primary, fallback, 10, 0n)).resolves.toBe(91n);
  });

  it("fails closed when providers disagree on the finalized block hash", async () => {
    const primary = fakeReader({ head: 100n, hash: ("0x" + "a".repeat(64)) as Hash });
    const fallback = fakeReader({ head: 100n, hash: ("0x" + "b".repeat(64)) as Hash });
    await expect(assertRpcProviderAgreement(primary, fallback, 10)).rejects.toThrow(/canonical hash/);
  });

  it("rejects a provider that reports a non-Polygon chain ID", async () => {
    const primary = fakeReader({ head: 100n, chainId: 1 });
    const fallback = fakeReader({ head: 100n });
    await expect(assertRpcProviderAgreement(primary, fallback, 10)).rejects.toThrow(/chain ID 137/);
  });

  it("rejects excessive head lag between providers", async () => {
    const primary = fakeReader({ head: 1000n });
    const fallback = fakeReader({ head: 1n });
    await expect(assertRpcProviderAgreement(primary, fallback, 10, 20n)).rejects.toThrow(/head height/);
  });
});
