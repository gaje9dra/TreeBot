import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TreeBot — Polygon Trading Research",
  description: "Transparent Polygon PoS trading research, paper trading, and risk monitoring.",
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
