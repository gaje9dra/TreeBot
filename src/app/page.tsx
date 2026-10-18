"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Blocks, CircleStop, Clock3, Gauge, Network, ShieldCheck, Wallet, Zap } from "lucide-react";
import { useAccount, useBalance, useChainId, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { polygon } from "wagmi/chains";
import { assessNativeCapital, validateConnectedChain } from "@/lib/wallet/polygon";

type FeedEvent = { title: string; detail: string; time: string; type: "info" | "warn" | "good" };
const initialFeed: FeedEvent[] = [
  { title: "Trading engine initialized", detail: "Paper mode only. Live order submission is hard-disabled in this build.", time: "SYSTEM", type: "good" },
  { title: "Risk gates loaded", detail: "150 POL minimum · 2 POL gas reserve · 5 POL maximum simulated order.", time: "SYSTEM", type: "info" },
  { title: "Market data not configured", detail: "Add a trusted provider endpoint before evaluating live market opportunities.", time: "WAITING", type: "warn" }
];

export default function HomePage() {
  const [stopped, setStopped] = useState(true);
  const [feed, setFeed] = useState(initialFeed);
  const account = useAccount();
  const chainId = useChainId();
  const { connect, connectors, isPending: connecting, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const balance = useBalance({ address: account.address, chainId: polygon.id, query: { enabled: Boolean(account.address) } });
  const chain = useMemo(() => validateConnectedChain(chainId), [chainId]);
  const capital = useMemo(() => balance.data ? assessNativeCapital(balance.data.value) : null, [balance.data]);

  function logEvent(title: string, detail: string, type: FeedEvent["type"] = "info") {
    setFeed((events) => [{ title, detail, type, time: new Date().toLocaleTimeString() }, ...events].slice(0, 8));
  }

  const canStart = Boolean(account.address && chain.valid && capital?.eligible && !stopped);
  return <main className="shell">
    <header className="topbar">
      <div className="brand"><div className="brand-mark">T</div><div>TREEBOT<div className="eyebrow" style={{ marginTop: 3 }}>POLYGON TRADING SYSTEM</div></div></div>
      <div className="actions">
        <span className="pill"><span className="dot" /> PAPER MODE · LIVE DISABLED</span>
        {account.isConnected
          ? <button className="btn" onClick={() => { disconnect(); logEvent("Wallet disconnected", "Read-only wallet session ended."); }}><Wallet size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 6 }} />{account.address?.slice(0, 6)}…{account.address?.slice(-4)}</button>
          : <button className="btn btn-primary" disabled={connecting || connectors.length === 0} onClick={() => connectors[0] && connect({ connector: connectors[0] })}>{connecting ? "Connecting…" : "Connect wallet"}</button>}
      </div>
    </header>

    <section className="hero">
      <div><div className="eyebrow">AUTONOMOUS STRATEGY · SAFETY FIRST</div><h1>Markets move.<br /><span style={{ color: "var(--mint)" }}>Stay in control.</span></h1><p className="lede">An explainable Polygon trading research console. Monitor wallet readiness, evaluate cost-aware signals, and test a strategy in a transparent paper environment before considering any real execution.</p></div>
      <div className="actions">
        <button className={stopped ? "btn btn-primary" : "btn btn-danger"} onClick={() => { setStopped((value) => { const next = !value; logEvent(next ? "Paper engine stopped" : "Paper engine resumed", next ? "New simulated entries paused by user." : "Paper mode resumed; no real transactions can be submitted.", next ? "warn" : "good"); return next; }); }}><CircleStop size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />{stopped ? "Resume paper engine" : "Stop engine"}</button>
        <button className="btn" onClick={() => { setFeed(initialFeed); logEvent("Activity view refreshed", "System notices restored; this is UI state, not a live exchange feed."); }}><Activity size={14} style={{ display: "inline", verticalAlign: "middle", marginRight: 7 }} />Refresh view</button>
      </div>
    </section>

    {connectError && <div className="callout" style={{ marginBottom: 14 }}>Wallet connection failed: {connectError.message}</div>}

    <div className="grid">
      <Metric icon={<Wallet size={14} />} label="WALLET BALANCE" value={capital ? capital.walletBalancePol.toFixed(4) + " POL" : "—"} meta={account.address ? "Read from Polygon RPC via wallet balance hook" : "Connect wallet to read native balance"} />
      <Metric icon={<ShieldCheck size={14} />} label="STARTING CAPITAL" value={capital ? (capital.eligible ? "ELIGIBLE" : "NOT READY") : "150 POL"} meta={capital ? `Shortfall incl. gas reserve: ${capital.shortfallPol.toFixed(4)} POL` : "150 POL minimum + 2 POL gas reserve"} tone={capital?.eligible ? "good" : "normal"} />
      <Metric icon={<Gauge size={14} />} label="ENGINE STATUS" value={stopped ? "STOPPED" : "ARMED"} meta={stopped ? "User pause · no simulated entries" : "Paper mode only · no live execution"} tone={stopped ? "warn" : "good"} />
      <Metric icon={<Blocks size={14} />} label="NETWORK" value={chain.valid ? "POLYGON POS" : "NOT VERIFIED"} meta={`Expected chain ID 137 · detected ${chainId}`} tone={chain.valid ? "good" : "warn"} />
    </div>

    <div className="section-head"><h2>Wallet & network readiness</h2><span className="eyebrow">READ-ONLY ON-CHAIN CHECKS</span></div>
    <div className="panel-grid">
      <section className="card">
        <div className="card-label"><span>Connection details</span><Network size={15} /></div>
        <div className="risk-row"><span>Wallet connection</span><span className={`status ${account.isConnected ? "good" : "warn"}`}>{account.isConnected ? "CONNECTED" : "NOT CONNECTED"}</span></div>
        <div className="risk-row"><span>Selected network</span><span className={`status ${chain.valid ? "good" : "warn"}`}>{chainId === 137 ? "CHAIN 137" : `CHAIN ${chainId}`}</span></div>
        <div className="risk-row"><span>Native POL balance</span><strong>{capital ? capital.walletBalancePol.toFixed(4) : "—"}</strong></div>
        <div className="risk-row"><span>Reserved gas (eligibility check)</span><strong>2.0000 POL</strong></div>
        <div className="risk-row"><span>Capital after reserve</span><strong>{capital ? capital.availableAfterGasReservePol.toFixed(4) + " POL" : "—"}</strong></div>
        <div className="actions" style={{ marginTop: 16 }}>
          {account.isConnected && !chain.valid && <button className="btn btn-primary" disabled={switching} onClick={() => switchChain({ chainId: polygon.id })}>{switching ? "Switching…" : "Switch to Polygon"}</button>}
          <a className="btn" href={account.address ? `https://polygonscan.com/address/${account.address}` : "https://polygonscan.com"} target="_blank" rel="noreferrer">View on Polygonscan ↗</a>
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
  </main>;
}

function Metric({ icon, label, value, meta, tone = "normal" }: { icon: React.ReactNode; label: string; value: string; meta: string; tone?: "normal" | "good" | "warn" }) {
  return <div className="card"><div className="card-label"><span>{label}</span>{icon}</div><div className="metric" style={{ color: tone === "good" ? "var(--mint)" : tone === "warn" ? "var(--amber)" : "var(--text)" }}>{value}</div><div className="meta">{meta}</div></div>;
}
function MiniCard({ icon, title, detail, state, good = false }: { icon: React.ReactNode; title: string; detail: string; state: string; good?: boolean }) {
  return <div className="card"><div className="card-label"><span>{title}</span>{icon}</div><p className="meta" style={{ minHeight: 44, marginTop: 15 }}>{detail}</p><span className={`status ${good ? "good" : "warn"}`}>{state}</span></div>;
}
