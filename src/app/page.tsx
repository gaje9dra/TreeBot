"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Blocks, CircleStop,
  Clock3, Gauge, Network, ShieldCheck, Wallet, Zap
} from "lucide-react";
import { formatEther, isAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import { assessNativeCapital, validateConnectedChain } from "@/lib/wallet/polygon";
import type { BacktestReport } from "@/lib/trading/backtest";
import type { MarketSnapshot, PortfolioState } from "@/lib/trading/types";
import type { PaperTradeRecord } from "@/lib/ledger/postgres";

type FeedEvent = { title: string; detail: string; time: string; type: "info" | "warn" | "good" };
type PaperDashboardPayload = {
  control: { enabled: boolean; emergencyStop: boolean };
  portfolio: PortfolioState;
  startingEquityQuote: number;
  realizedPnlQuote: number;
  trades: PaperTradeRecord[];
  marketDataAvailable: boolean;
  marketDataError?: string;
  workerAlive: boolean;
};
type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
  providers?: Eip1193Provider[];
};
declare global {
  interface Window { ethereum?: Eip1193Provider; }
}

const initialFeed: FeedEvent[] = [
  { title: "TreeBot console initialized", detail: "Paper worker runs separately and is controlled through the CLI; PostgreSQL and market-provider configuration are required.", time: "SYSTEM", type: "info" },
  { title: "Risk gates loaded", detail: "150 POL minimum · 2 POL gas reserve · 5 POL maximum simulated order.", time: "SYSTEM", type: "info" },
  { title: "Public market-data adapter ready", detail: "TreeBot uses GeckoTerminal read-only market data by default; pool liquidity and history must still validate.", time: "WAITING", type: "warn" }
];

function getInjectedProvider(): Eip1193Provider | undefined {
  if (typeof window === "undefined" || !window.ethereum) return undefined;
  return window.ethereum.providers?.find((provider) => provider && typeof provider.request === "function") ?? window.ethereum;
}

function parseChainId(value: unknown): number {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return Number.NaN;
  return Number.parseInt(value, 16);
}

export default function HomePage() {
  const [feed, setFeed] = useState(initialFeed);
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [balanceWei, setBalanceWei] = useState<bigint>();
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [walletError, setWalletError] = useState<string>();
  const [walletProviderAvailable, setWalletProviderAvailable] = useState(false);
  const [marketPair, setMarketPair] = useState("WMATIC/USDC");
  const [marketSnapshot, setMarketSnapshot] = useState<MarketSnapshot>();
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketError, setMarketError] = useState<string>();
  const [marketCheckedAt, setMarketCheckedAt] = useState<number>();
  const [backtestEquity, setBacktestEquity] = useState("1000");
  const [backtestNotional, setBacktestNotional] = useState("100");
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestError, setBacktestError] = useState<string>();
  const [backtestReport, setBacktestReport] = useState<BacktestReport>();
  const [paperDashboard, setPaperDashboard] = useState<PaperDashboardPayload>();
  const [paperDashboardError, setPaperDashboardError] = useState<string>();
  const [liveModeNotice, setLiveModeNotice] = useState(false);

  const chain = useMemo(() => validateConnectedChain(chainId), [chainId]);
  const capital = useMemo(() => balanceWei === undefined ? null : assessNativeCapital(balanceWei), [balanceWei]);

  const logEvent = useCallback((title: string, detail: string, type: FeedEvent["type"] = "info") => {
    setFeed((events) => [{ title, detail, type, time: new Date().toLocaleTimeString() }, ...events].slice(0, 8));
  }, []);

  const refreshWallet = useCallback(async (provider = getInjectedProvider(), selectedAddress = address) => {
    if (!provider) {
      setWalletProviderAvailable(false);
      setAddress(undefined);
      setChainId(undefined);
      setBalanceWei(undefined);
      return;
    }
    setWalletProviderAvailable(true);
    try {
      const chainValue = await provider.request({ method: "eth_chainId" });
      const currentChain = parseChainId(chainValue);
      setChainId(Number.isFinite(currentChain) ? currentChain : undefined);
      if (!selectedAddress || !isAddress(selectedAddress)) {
        setBalanceWei(undefined);
        return;
      }
      const balanceHex = await provider.request({ method: "eth_getBalance", params: [selectedAddress, "latest"] });
      if (typeof balanceHex === "string" && /^0x[0-9a-f]+$/i.test(balanceHex)) {
        setBalanceWei(BigInt(balanceHex));
      } else {
        setBalanceWei(undefined);
      }
    } catch {
      setWalletError("Wallet RPC query failed. Check the wallet connection and network.");
      setBalanceWei(undefined);
    }
  }, [address]);

  useEffect(() => {
    const provider = getInjectedProvider();
    setWalletProviderAvailable(Boolean(provider));
    if (!provider) return;
    let mounted = true;
    const handleAccountsChanged = (...args: unknown[]) => {
      const next = Array.isArray(args[0]) && typeof args[0][0] === "string" && isAddress(args[0][0]) ? args[0][0] as Address : undefined;
      if (mounted) {
        setAddress(next);
        setBalanceWei(undefined);
        void refreshWallet(provider, next);
        logEvent(next ? "Wallet account changed" : "Wallet disconnected", next ? "The selected account changed in the wallet." : "No wallet account is currently authorized.", "info");
      }
    };
    const handleChainChanged = () => { if (mounted) void refreshWallet(provider); };
    provider.on?.("accountsChanged", handleAccountsChanged);
    provider.on?.("chainChanged", handleChainChanged);
    void refreshWallet(provider);
    return () => {
      mounted = false;
      provider.removeListener?.("accountsChanged", handleAccountsChanged);
      provider.removeListener?.("chainChanged", handleChainChanged);
    };
  }, [logEvent, refreshWallet]);


  useEffect(() => {
    let active = true;
    const refreshPaperDashboard = async () => {
      try {
        const response = await fetch("/api/paper/status?pair=" + encodeURIComponent(marketPair), { cache: "no-store" });
        const payload = await response.json() as PaperDashboardPayload & { error?: string };
        if (!response.ok) throw new Error(payload.error ?? "Paper ledger status is unavailable.");
        if (active) {
          setPaperDashboard(payload);
          setPaperDashboardError(undefined);
        }
      } catch (error) {
        if (active) {
          setPaperDashboard(undefined);
          setPaperDashboardError(error instanceof Error ? error.message : "Paper ledger status is unavailable.");
        }
      }
    };
    void refreshPaperDashboard();
    const interval = window.setInterval(() => void refreshPaperDashboard(), 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [marketPair]);

  async function refreshMarketData() {
    const pair = marketPair.trim();
    setMarketLoading(true);
    setMarketError(undefined);
    try {
      const response = await fetch("/api/market/snapshot?pair=" + encodeURIComponent(pair), { cache: "no-store" });
      const payload = await response.json() as { data?: MarketSnapshot; error?: string };
      if (!response.ok || !payload.data) throw new Error(payload.error ?? "Market provider returned no snapshot.");
      setMarketSnapshot(payload.data);
      setMarketCheckedAt(Date.now());
      logEvent("Market data refreshed", payload.data.pair + " · " + payload.data.candles.length + " validated candles · provider timestamp checked", "good");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Market data request failed.";
      setMarketSnapshot(undefined);
      setMarketError(message);
      logEvent("Market data unavailable", message, "warn");
    } finally {
      setMarketLoading(false);
    }
  }

  async function runBacktest() {
    setBacktestLoading(true);
    setBacktestError(undefined);
    setBacktestReport(undefined);
    try {
      const response = await fetch("/api/backtest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          pair: marketPair.trim(),
          startingEquityQuote: Number(backtestEquity),
          notionalQuote: Number(backtestNotional)
        })
      });
      const payload = await response.json() as { report?: BacktestReport; error?: string };
      if (!response.ok || !payload.report) throw new Error(payload.error ?? "Backtest could not be completed.");
      setBacktestReport(payload.report);
      logEvent("Historical backtest completed", payload.report.tradeCount + " simulated round trips · " + payload.report.netReturnPercent.toFixed(2) + "% modeled net return", "info");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Backtest request failed.";
      setBacktestError(message);
      logEvent("Backtest unavailable", message, "warn");
    } finally {
      setBacktestLoading(false);
    }
  }

  async function connectWallet() {
    const provider = getInjectedProvider();
    setWalletError(undefined);
    if (!provider) {
      setWalletError("No injected wallet was detected. Install MetaMask or a compatible EVM browser wallet.");
      return;
    }
    setConnecting(true);
    try {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const nextAddress = Array.isArray(accounts) && typeof accounts[0] === "string" && isAddress(accounts[0]) ? accounts[0] as Address : undefined;
      if (!nextAddress) throw new Error("Wallet did not return a valid EVM address.");
      setAddress(nextAddress);
      await refreshWallet(provider, nextAddress);
      logEvent("Wallet connected", "Read-only session established. Connecting does not authorize token approvals or trading.", "good");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection was rejected.";
      setWalletError(message);
      logEvent("Wallet connection failed", message, "warn");
    } finally {
      setConnecting(false);
    }
  }

  async function disconnectWallet() {
    setAddress(undefined);
    setBalanceWei(undefined);
    setWalletError(undefined);
    // EIP-1193 has no universally supported programmatic disconnect method.
    logEvent("Wallet disconnected in TreeBot", "Local app session cleared. Revoke site access in the wallet to revoke the browser permission.", "info");
  }

  async function switchToPolygon() {
    const provider = getInjectedProvider();
    if (!provider) return;
    setSwitching(true);
    setWalletError(undefined);
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x89" }] });
      await refreshWallet(provider);
      logEvent("Network switched", "Wallet selected Polygon PoS (chain ID 137).", "good");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet network switch failed.";
      setWalletError(message);
      logEvent("Network switch failed", message, "warn");
    } finally {
      setSwitching(false);
    }
  }

  const balanceDisplay = balanceWei !== undefined && chainId === polygon.id ? Number(formatEther(balanceWei)).toFixed(4) + " POL" : "—";
  const capitalDisplay = capital && chainId === polygon.id;
  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark">T</div><div>TREEBOT<div className="eyebrow" style={{ marginTop: 3 }}>POLYGON TRADING SYSTEM</div></div></div>
        <div className="actions">
          <div className="mode-switch" role="group" aria-label="Trading mode">
            <button type="button" className="mode-option active" aria-pressed="true" onClick={() => setLiveModeNotice(false)}>
              <span className="mode-indicator" /> Paper Mode
            </button>
            <button type="button" className="mode-option locked" aria-pressed="false" aria-describedby="live-mode-status" onClick={() => setLiveModeNotice(true)}>
              <ShieldCheck size={13} aria-hidden="true" /> Real Funds <span className="mode-lock">LOCKED</span>
            </button>
          </div>
          {address
            ? <button className="btn" onClick={() => void disconnectWallet()}><Wallet size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />{address.slice(0, 6)}…{address.slice(-4)}</button>
            : <button className="btn btn-primary" disabled={connecting || !walletProviderAvailable} onClick={() => void connectWallet()}>{connecting ? "Connecting…" : "Connect wallet"}</button>}
        </div>
      </header>

      <section className="hero">
        <div><div className="eyebrow">AUTONOMOUS STRATEGY · SAFETY FIRST</div><h1>Markets move.<br /><span style={{ color: "var(--mint)" }}>Stay in control.</span></h1><p className="lede">An explainable Polygon trading research console. Monitor wallet readiness, evaluate cost-aware signals, and test a strategy in a transparent paper environment before considering any real execution.</p></div>
        <div className="actions">
          <button className="btn" disabled title="The worker is a separate process. Use the documented CLI controls to enable or stop paper cycles."><CircleStop size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Worker controlled via CLI</button>
          <button className="btn" onClick={() => { setFeed(initialFeed); logEvent("Activity view refreshed", "System notices restored; this is UI state, not a live exchange feed."); }}><Activity size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Refresh view</button>
        </div>
      </section>

      {liveModeNotice && <div id="live-mode-status" className="callout mode-notice" role="status" style={{ marginBottom: 14 }}>
        <strong>Real Funds mode is unavailable in this build.</strong> Live execution is hard-disabled server-side. No live orders, deposits, or withdrawals can be activated from this toggle. Keep using Paper Mode until the execution adapter, transaction reconciliation, accounting, security review, and release gates are complete.
        <button type="button" className="btn" style={{ marginLeft: 12 }} onClick={() => setLiveModeNotice(false)}>Dismiss</button>
      </div>}
      {walletError && <div className="callout" style={{ marginBottom: 14 }}>Wallet notice: {walletError}</div>}

      <div className="grid">
        <Metric icon={<Wallet size={14} />} label="WALLET BALANCE" value={balanceDisplay} meta={address ? (chainId === polygon.id ? "Read from connected wallet on Polygon PoS" : "Switch to Polygon to display eligible balance") : "Connect wallet to read native balance"} />
        <Metric icon={<ShieldCheck size={14} />} label="STARTING CAPITAL" value={capitalDisplay ? (capital!.eligible ? "ELIGIBLE" : "NOT READY") : "150 POL"} meta={capitalDisplay ? `Shortfall incl. gas reserve: ${capital!.shortfallPol.toFixed(4)} POL` : "150 POL minimum + 2 POL gas reserve"} tone={capitalDisplay && capital!.eligible ? "good" : "normal"} />
        <Metric icon={<Gauge size={14} />} label="PAPER WORKER" value={paperDashboard ? (paperDashboard.control.emergencyStop ? "EMERGENCY STOP" : !paperDashboard.control.enabled ? "DISABLED" : paperDashboard.workerAlive ? "ENABLED" : "WORKER OFFLINE") : "UNKNOWN"} meta={paperDashboard ? (paperDashboard.workerAlive ? (paperDashboard.marketDataAvailable ? "Recent worker heartbeat · provider mark available" : "Recent worker heartbeat · provider mark unavailable") : "No recent worker heartbeat detected") : paperDashboardError ?? "Checking durable paper ledger"} tone={paperDashboard?.control.emergencyStop || !paperDashboard || (paperDashboard.control.enabled && !paperDashboard.workerAlive) ? "warn" : paperDashboard.control.enabled ? "good" : "warn"} />
        <Metric icon={<Blocks size={14} />} label="NETWORK" value={chain.valid ? "POLYGON POS" : "NOT VERIFIED"} meta={`Expected chain ID 137 · detected ${chainId ?? "unknown"}`} tone={chain.valid ? "good" : "warn"} />
      </div>

      <div className="section-head"><h2>Wallet & network readiness</h2><span className="eyebrow">READ-ONLY ON-CHAIN CHECKS</span></div>
      <div className="panel-grid">
        <section className="card">
          <div className="card-label"><span>Connection details</span><Network size={15} /></div>
          <div className="risk-row"><span>Wallet connection</span><span className={`status ${address ? "good" : "warn"}`}>{address ? "CONNECTED" : "NOT CONNECTED"}</span></div>
          <div className="risk-row"><span>Selected network</span><span className={`status ${chain.valid ? "good" : "warn"}`}>{chainId === 137 ? "CHAIN 137" : `CHAIN ${chainId ?? "UNKNOWN"}`}</span></div>
          <div className="risk-row"><span>Native POL balance</span><strong>{balanceDisplay}</strong></div>
          <div className="risk-row"><span>Reserved gas (eligibility check)</span><strong>2.0000 POL</strong></div>
          <div className="risk-row"><span>Capital after reserve</span><strong>{capitalDisplay ? capital!.availableAfterGasReservePol.toFixed(4) + " POL" : "—"}</strong></div>
          <div className="actions" style={{ marginTop: 16 }}>
            {address && !chain.valid && <button className="btn btn-primary" disabled={switching} onClick={() => void switchToPolygon()}>{switching ? "Switching…" : "Switch to Polygon"}</button>}
            <a className="btn" href={address ? `https://polygonscan.com/address/${address}` : "https://polygonscan.com"} target="_blank" rel="noreferrer">View on Polygonscan ↗</a>
          </div>
          <p className="meta" style={{ marginTop: 13 }}>Connecting a wallet does not authorize token approvals, deposits, or trades. TreeBot never requests a seed phrase.</p>
        </section>
        <section className="card">
          <div className="card-label"><span>Trading safeguards</span><ShieldCheck size={15} /></div>
          <div className="risk-row"><span>Execution mode</span><span className="status good">PAPER ONLY</span></div>
          <div className="risk-row"><span>Live order submission</span><span className="status warn">DISABLED</span></div>
          <div className="risk-row"><span>Deposits / vault contract</span><span className="status warn">DISABLED</span></div>
          <div className="risk-row"><span>Max simulated order</span><strong>5 POL</strong></div>
          <div className="risk-row"><span>Daily loss threshold</span><strong>2%</strong></div>
          <div className="risk-row"><span>Maximum drawdown</span><strong>8%</strong></div>
          <div className="risk-row"><span>Paper portfolio equity</span><strong>{paperDashboard ? paperDashboard.portfolio.equityQuote.toFixed(2) + " quote units" : "—"}</strong></div>
          <div className="risk-row"><span>Realized paper P&amp;L</span><strong style={{ color: paperDashboard && paperDashboard.realizedPnlQuote >= 0 ? "var(--mint)" : "var(--red)" }}>{paperDashboard ? (paperDashboard.realizedPnlQuote >= 0 ? "+" : "") + paperDashboard.realizedPnlQuote.toFixed(4) : "—"}</strong></div>
          <div className="risk-row"><span>Available simulated cash</span><strong>{paperDashboard ? paperDashboard.portfolio.availableQuote.toFixed(2) : "—"}</strong></div>
          {paperDashboardError && <div className="callout" style={{ marginTop: 12 }}>Paper ledger status unavailable: {paperDashboardError}</div>}
          <div className="callout" style={{ marginTop: 17 }}><AlertTriangle size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />This dashboard does not currently submit blockchain transactions. A production trading adapter and independent security review are mandatory before real funds can be exposed.</div>
        </section>
      </div>


      <div className="section-head"><h2>Live market data</h2><span className={"status " + (marketSnapshot ? "good" : "warn")}>{marketSnapshot ? "FRESH PROVIDER SNAPSHOT" : "PROVIDER NOT VERIFIED"}</span></div>
      <section className="card">
        <div className="market-controls">
          <label className="field-label" htmlFor="market-pair">Provider pair identifier
            <input id="market-pair" className="field" value={marketPair} maxLength={64} onChange={(event) => setMarketPair(event.target.value)} placeholder="WMATIC/USDC" />
          </label>
          <button className="btn btn-primary" disabled={marketLoading || !marketPair.trim()} onClick={() => void refreshMarketData()}>{marketLoading ? "Fetching provider data…" : "Fetch market snapshot"}</button>
        </div>
        {marketError && <div className="callout" style={{ marginTop: 14 }}>Market data unavailable: {marketError}</div>}
        {marketSnapshot ? <>
          <div className="grid" style={{ marginTop: 16 }}>
            <Metric icon={<Activity size={14} />} label="MARKET PRICE" value={marketSnapshot.price.toPrecision(8) + " " + marketSnapshot.quoteToken} meta={"Base token: " + marketSnapshot.baseToken} />
            <Metric icon={<Gauge size={14} />} label="24H VOLUME" value={marketSnapshot.volume24h.toLocaleString()} meta="Provider-reported volume; units depend on provider contract" />
            <Metric icon={<Blocks size={14} />} label="LIQUIDITY (USD)" value={"$" + marketSnapshot.liquidityUsd.toLocaleString()} meta="Provider-reported liquidity estimate" />
            <Metric icon={<ShieldCheck size={14} />} label="HISTORY / EXIT" value={marketSnapshot.candles.length + " candles"} meta={marketSnapshot.executableExit ? "Provider reports exit route available; not independently executed" : "No executable exit route reported"} tone={marketSnapshot.executableExit ? "good" : "warn"} />
          </div>
          <p className="meta" style={{ marginTop: 12 }}>Snapshot timestamp: {new Date(marketSnapshot.observedAt).toLocaleString()} · Last fetched in this browser: {marketCheckedAt ? new Date(marketCheckedAt).toLocaleTimeString() : "—"}. Freshness is checked server-side; this view does not place orders.</p>
        </> : <div className="empty">No provider data loaded. TreeBot tries GeckoTerminal by default. If no matching liquid Polygon pool is found, verify the pair symbols or configure MARKET_DATA_BASE_URL for a trusted normalized snapshot service. No sample prices are used.</div>}
      </section>

      <div className="section-head"><h2>Historical backtest</h2><span className="eyebrow">SIMULATED · NOT EARNINGS</span></div>
      <section className="card">
        <div className="market-controls">
          <label className="field-label" htmlFor="backtest-equity">Starting quote equity
            <input id="backtest-equity" className="field" inputMode="decimal" value={backtestEquity} onChange={(event) => setBacktestEquity(event.target.value)} />
          </label>
          <label className="field-label" htmlFor="backtest-notional">Order notional per entry
            <input id="backtest-notional" className="field" inputMode="decimal" value={backtestNotional} onChange={(event) => setBacktestNotional(event.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={backtestLoading || marketLoading} onClick={() => void runBacktest()}>{backtestLoading ? "Running replay…" : "Run backtest"}</button>
        </div>
        <p className="meta" style={{ marginTop: 12 }}>The backtest replays provider-supplied historical candles and models fees, slippage, and gas. Quote equity is a simulation input, not your wallet balance. No real transactions occur.</p>
        {backtestError && <div className="callout" style={{ marginTop: 14 }}>Backtest unavailable: {backtestError}</div>}
        {backtestReport && <>
          <div className="grid" style={{ marginTop: 16 }}>
            <Metric icon={<Activity size={14} />} label="MODELED NET RETURN" value={backtestReport.netReturnPercent.toFixed(2) + "%"} meta="Historical replay; no profit guarantee" tone={backtestReport.netReturnPercent >= 0 ? "good" : "warn"} />
            <Metric icon={<Gauge size={14} />} label="MAX DRAWDOWN" value={backtestReport.maximumDrawdownPercent.toFixed(2) + "%"} meta="Peak-to-trough modeled decline" tone="warn" />
            <Metric icon={<Blocks size={14} />} label="ROUND TRIPS" value={String(backtestReport.tradeCount)} meta={"Win rate " + backtestReport.winRate.toFixed(1) + "%"} />
            <Metric icon={<ShieldCheck size={14} />} label="FINAL QUOTE EQUITY" value={backtestReport.finalEquityQuote.toFixed(2)} meta={"Buy-and-hold benchmark " + backtestReport.benchmarkReturnPercent.toFixed(2) + "%"} />
          </div>
          <div className="risk-row"><span>Modeled fees / slippage / gas</span><strong>{backtestReport.feesQuote.toFixed(4)} / {backtestReport.slippageQuote.toFixed(4)} / {backtestReport.gasQuote.toFixed(4)}</strong></div>
          <div className="callout" style={{ marginTop: 14 }}>{backtestReport.notes.join(" ")}</div>
        </>}
      </section>

      <div className="section-head"><h2>System activity</h2><span className="eyebrow">LOCAL SYSTEM EVENTS · NOT A LIVE CHAIN FEED</span></div>
      <section className="card">
        <div className="list">{feed.map((event, index) => <div className="event" key={event.title + event.time + index}><div className="event-dot" style={{ background: event.type === "warn" ? "var(--amber)" : event.type === "good" ? "var(--mint)" : "#8b9ab0" }} /><div><div className="event-title">{event.title}</div><div className="event-desc">{event.detail}</div></div><span className="time">{event.time}</span></div>)}</div>
      </section>

      <div className="section-head"><h2>Trade ledger</h2><span className="eyebrow">NO SIMULATED OR LIVE FILLS RECORDED</span></div>
      <section className="card table-wrap"><table><thead><tr><th>TIME</th><th>PAIR</th><th>SIDE</th><th>NOTIONAL</th><th>EXECUTION</th><th>FEES + GAS</th><th>REALIZED P&amp;L</th><th>STATUS</th></tr></thead><tbody>
        {paperDashboard?.trades.length ? paperDashboard.trades.map((trade) => <tr key={trade.id}>
          <td>{new Date(trade.createdAt).toLocaleString()}</td><td>{trade.pair}</td><td>{trade.side.toUpperCase()}</td><td>{trade.notionalQuote.toFixed(4)}</td><td>{trade.executionPrice.toPrecision(8)}</td><td>{(trade.feesQuote + trade.gasQuote).toFixed(4)}</td><td>{trade.realizedPnlQuote === null ? "—" : (trade.realizedPnlQuote >= 0 ? "+" : "") + trade.realizedPnlQuote.toFixed(4)}</td><td><span className="status warn">SIMULATED</span></td>
        </tr>) : <tr><td colSpan={8} className="empty">{paperDashboardError ? "Paper ledger unavailable: " + paperDashboardError : "No simulated fills recorded yet. The worker is disabled by default and must be explicitly enabled from the CLI."}</td></tr>}
        </tbody></table></section>

      <div className="section-head"><h2>Coming online in guarded stages</h2><span className="eyebrow">PRODUCTION READINESS</span></div>
      <div className="grid">
        <MiniCard icon={<Zap size={15} />} title="Market feed" detail="Provider integration and freshness monitoring need credentials." state="NOT CONFIGURED" />
        <MiniCard icon={<ArrowUpRight size={15} />} title="Strategy signals" detail="Engine rejects stale, illiquid, costly, or over-risk candidates." state="CORE MODULE ADDED" good />
        <MiniCard icon={<ArrowDownRight size={15} />} title="Backtesting" detail="Historical replay includes modeled fees, slippage, and gas." state="CORE MODULE ADDED" good />
        <MiniCard icon={<Clock3 size={15} />} title="Live execution" detail="DEX route and secure authorization adapter not enabled." state="HARD DISABLED" />
      </div>
      <footer className="footer"><span>TREEBOT / BUILD 0.1 · POLYGON POS CHAIN ID 137</span><span>Crypto assets are volatile. Simulations are not actual earnings and do not establish profitability.</span></footer>
    </main>
  );
}

function Metric({ icon, label, value, meta, tone = "normal" }: { icon: React.ReactNode; label: string; value: string; meta: string; tone?: "normal" | "good" | "warn" }) {
  return <div className="card"><div className="card-label"><span>{label}</span>{icon}</div><div className="metric" style={{ color: tone === "good" ? "var(--mint)" : tone === "warn" ? "var(--amber)" : "var(--text)" }}>{value}</div><div className="meta">{meta}</div></div>;
}
function MiniCard({ icon, title, detail, state, good = false }: { icon: React.ReactNode; title: string; detail: string; state: string; good?: boolean }) {
  return <div className="card"><div className="card-label"><span>{title}</span>{icon}</div><p className="meta" style={{ minHeight: 44, marginTop: 15 }}>{detail}</p><span className={`status ${good ? "good" : "warn"}`}>{state}</span></div>;
}
