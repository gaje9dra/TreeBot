import { z } from "zod";

const configSchema = z.object({
  chainId: z.coerce.number().int().refine((n) => n === 137, "Only Polygon PoS chain ID 137 is supported."),
  tradingMode: z.enum(["paper", "live"]).default("paper"),
  liveTradingEnabled: z.string().default("false").transform((v) => v === "true"),
  depositsEnabled: z.string().default("false").transform((v) => v === "true"),
  minimumCapitalPol: z.coerce.number().positive().default(150),
  gasReservePol: z.coerce.number().nonnegative().default(2),
  maximumTradePol: z.coerce.number().positive().default(5),
  maximumDailyLossPercent: z.coerce.number().positive().max(100).default(2),
  maximumDrawdownPercent: z.coerce.number().positive().max(100).default(8),
  maximumSlippageBps: z.coerce.number().int().min(1).max(5000).default(50),
  minimumExpectedNetReturnBps: z.coerce.number().int().min(1).max(10000).default(30),
  maximumTradesPerHour: z.coerce.number().int().min(1).max(1000).default(4)
}).superRefine((value, ctx) => {
  if (value.tradingMode === "live" && !value.liveTradingEnabled) {
    ctx.addIssue({ code: "custom", path: ["liveTradingEnabled"], message: "Live mode requires an explicit live-trading enable flag." });
  }
  if (value.depositsEnabled) {
    ctx.addIssue({ code: "custom", path: ["depositsEnabled"], message: "Deposits are disabled until custody and contract audits are complete." });
  }
});

export type TreeBotConfig = z.infer<typeof configSchema>;
export type ConfigEnvironment = Record<string, string | undefined>;

export function loadConfig(env: ConfigEnvironment = process.env): TreeBotConfig {
  const parsed = configSchema.safeParse({
    chainId: env.NEXT_PUBLIC_CHAIN_ID ?? 137,
    tradingMode: env.TREEBOT_TRADING_MODE ?? "paper",
    liveTradingEnabled: env.TREEBOT_LIVE_TRADING_ENABLED ?? "false",
    depositsEnabled: env.TREEBOT_DEPOSITS_ENABLED ?? "false",
    minimumCapitalPol: env.TREEBOT_MIN_CAPITAL_POL ?? 150,
    gasReservePol: env.TREEBOT_GAS_RESERVE_POL ?? 2,
    maximumTradePol: env.TREEBOT_MAX_TRADE_POL ?? 5,
    maximumDailyLossPercent: env.TREEBOT_MAX_DAILY_LOSS_PERCENT ?? 2,
    maximumDrawdownPercent: env.TREEBOT_MAX_DRAWDOWN_PERCENT ?? 8,
    maximumSlippageBps: env.TREEBOT_MAX_SLIPPAGE_BPS ?? 50,
    minimumExpectedNetReturnBps: env.TREEBOT_MIN_EXPECTED_NET_RETURN_BPS ?? 30,
    maximumTradesPerHour: env.TREEBOT_MAX_TRADES_PER_HOUR ?? 4
  });
  if (!parsed.success) throw new Error(`Invalid TreeBot configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export const LIVE_EXECUTION_AVAILABLE = false;
export const DEPOSIT_FEATURE_AVAILABLE = false;
