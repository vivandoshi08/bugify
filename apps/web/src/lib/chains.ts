import { defineChain, http, type Chain } from "viem";
import { anvil as viemAnvil, baseSepolia } from "viem/chains";
import { env } from "@/lib/env";

/** Local anvil chain for contract dev. */
export const anvil = defineChain({
  ...viemAnvil,
  id: 31337,
  name: "Bugify local",
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

export const chains = [baseSepolia, anvil] as const;
export type SupportedChainId = (typeof chains)[number]["id"];

export function chainById(id: number): Chain {
  const c = chains.find((x) => x.id === id);
  if (!c) throw new Error(`unsupported chain ${id}`);
  return c;
}

export const activeChain = chainById(env.chainId);

export function rpcUrlFor(chain: Chain): string {
  if (chain.id === env.chainId && env.rpcUrl) return env.rpcUrl;
  return chain.rpcUrls.default.http[0];
}

export const transportFor = (chain: Chain) => http(rpcUrlFor(chain));

export function explorerTxUrl(chainId: number, hash: string): string | null {
  const base = chains.find((x) => x.id === chainId)?.blockExplorers?.default?.url;
  return base ? `${base}/tx/${hash}` : null;
}
