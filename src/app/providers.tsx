"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { polygon } from "wagmi/chains";

const config = createConfig({
  chains: [polygon],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [polygon.id]: http() },
  ssr: true
});

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 10_000, retry: 1, refetchOnWindowFocus: false } }
  }));
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
