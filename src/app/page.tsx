"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Blocks, CircleStop,
  Clock3, Gauge, Network, ShieldCheck, Wallet, Zap
} from "lucide-react";
import { formatEther, isAddress, type Address } from "viem";
import { polygon } from "viem/chains";
import { assessNativeCapital, validateConnectedChain } from "@/lib/wallet/polygon";

type FeedEvent = { title: string; detail: string; time: string; type: "info" | "warn" | "good" };
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
  { title: "Trading engine initialized", detail: "Paper mode only. Live order submission is hard-disabled in this build.", time: "SYSTEM", type: "good" },
  { title: "Risk gates loaded", detail: "150 POL minimum · 2 POL gas reserve · 5 POL maximum simulated order.", time: "SYSTEM", type: "info" },
  { title: "Market data not configured", detail: "Add a trusted provider endpoint before evaluating live market opportunities.", time: "WAITING", type: "warn" }
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
  const [stopped, setStopped] = useState(true);
  const [feed, setFeed] = useState(initialFeed);
  const [address, setAddress] = useState<Address>();
  const [chainId, setChainId] = useState<number>();
  const [balanceWei, setBalanceWei] = useState<bigint>();
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [walletError, setWalletError] = useState<string>();
  const [walletProviderAvailable, setWalletProviderAvailable] = useState(false);

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
          <span className="pill"><span className="dot" /> PAPER MODE · LIVE DISABLED</span>
          {address
            ? <button className="btn" onClick={() => void disconnectWallet()}><Wallet size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />{address.slice(0, 6)}…{address.slice(-4)}</button>
            : <button className="btn btn-primary" disabled={connecting || !walletProviderAvailable} onClick={() => void connectWallet()}>{connecting ? "Connecting…" : "Connect wallet"}</button>}
        </div>
      </header>

      <section className="hero">
        <div><div className="eyebrow">AUTONOMOUS STRATEGY · SAFETY FIRST</div><h1>Markets move.<br /><span style={{ color: "var(--mint)" }}>Stay in control.</span></h1><p className="lede">An explainable Polygon trading research console. Monitor wallet readiness, evaluate cost-aware signals, and test a strategy in a transparent paper environment before considering any real execution.</p></div>
        <div className="actions">
          <button className={stopped ? "btn btn-primary" : "btn btn-danger"} onClick={() => { setStopped((value) => { const next = !value; logEvent(next ? "Paper engine stopped" : "Paper engine resumed", next ? "New simulated entries paused by user." : "Paper mode resumed; no real transactions can be submitted.", next ? "warn" : "good"); return next; }); }}><CircleStop size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />{stopped ? "Resume paper engine" : "Stop engine"}</button>
          <button className="btn" onClick={() => { setFeed(initialFeed); logEvent("Activity view refreshed", "System notices restored; this is UI state, not a live exchange feed."); }}><Activity size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Refresh view</button>
        </div>
      </section>

      {walletError && <div className="callout" style={{ marginBottom: 14 }}>Wallet notice: {walletError}</div>}

      <div className="grid">
        <Metric icon={<Wallet size={14} />} label="WALLET BALANCE" value={balanceDisplay} meta={address ? (chainId === polygon.id ? "Read from connected wallet on Polygon PoS" : "Switch to Polygon to display eligible balance") : "Connect wallet to read native balance"} />
        <Metric icon={<ShieldCheck size={14} />} label="STARTING CAPITAL" value={capitalDisplay ? (capital!.eligible ? "ELIGIBLE" : "NOT READY") : "150 POL"} meta={capitalDisplay ? `Shortfall incl. gas reserve: ${capital!.shortfallPol.toFixed(4)} POL` : "150 POL minimum + 2 POL gas reserve"} tone={capitalDisplay && capital!.eligible ? "good" : "normal"} />
        <Metric icon={<Gauge size={14} />} label="ENGINE STATUS" value={stopped ? "STOPPED" : "ARMED"} meta={stopped ? "User pause · no simulated entries" : "Paper mode only · no live execution"} tone={stopped ? "warn" : "good"} />
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
          <div className="callout" style={{ marginTop: 17 }}><AlertTriangle size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />This dashboard does not currently submit blockchain transactions. A production trading adapter and independent security review are mandatory before real funds can be exposed.</div>
        </section>
      </div>

      <div className="section-head"><h2>System activity</h2><span className="eyebrow">LOCAL SYSTEM EVENTS · NOT A LIVE CHAIN FEED</span></div>
      <section className="card">
        <div className="list">{feed.map((event, index) => <div className="event" key={event.title + event.time + index}><div className="event-dot" style={{ background: event.type === "warn" ? "var(--amber)" : event.type === "good" ? "var(--mint)" : "#8b9ab0" }} /><div><div className="event-title">{event.title}</div><div className="event-desc">{event.detail}</div></div><span className="time">{event.time}</span></div>)}</div>
      </section>

      <div className="section-head"><h2>Trade ledger</h2><span className="eyebrow">NO SIMULATED OR LIVE FILLS RECORDED</span></div>
      <section className="card table-wrap"><table><thead><tr><th>TIME</th><th>PAIR</th><th>SIDE</th><th>SIZE</th><th>EXECUTION</th><th>FEES</th><th>STATUS</th></tr></thead><tbody><tr><td colSpan={7} className="empty">No trades yet. Paper fills will only be recorded by the strategy service after an accepted decision.</td></tr></tbody></table></section>

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
