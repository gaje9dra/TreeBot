"use client";

import { useEffect } from "react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error("TreeBot UI boundary", error.digest ?? error.message); }, [error]);
  return <main className="shell"><section className="card" style={{ maxWidth: 620, margin: "10vh auto" }}><div className="eyebrow">APPLICATION ERROR</div><h1 style={{ fontSize: 32 }}>The dashboard hit a problem.</h1><p className="lede">No trade was authorized by this screen. Verify network connectivity and try reloading the view.</p><button className="btn btn-primary" onClick={reset}>Try again</button></section></main>;
}
