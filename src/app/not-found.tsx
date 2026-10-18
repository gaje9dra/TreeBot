import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell">
      <section className="card" style={{ maxWidth: 620, margin: "10vh auto" }}>
        <div className="eyebrow">404 / NOT FOUND</div>
        <h1 style={{ fontSize: 32 }}>This route does not exist.</h1>
        <p className="lede">Return to the TreeBot dashboard.</p>
        <Link className="btn btn-primary" href="/">Back to dashboard</Link>
      </section>
    </main>
  );
}
