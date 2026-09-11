// Load .env BEFORE @bugify/sdk is imported anywhere (DEMO reads BUGIFY_DEMO_SCALE at module init).
import "dotenv/config";
import type { Hex } from "viem";

export const RPC_URL = process.env.RPC_URL ?? "https://sepolia.base.org";
export const SERVER_URL = process.env.SERVER_URL ?? "http://localhost:8787";
export const BAZAAR_ADDRESS = (process.env.BAZAAR_ADDRESS || undefined) as Hex | undefined;

export function requireKey(name: "BUYER_KEY" | "SELLER_KEY" | "PLATFORM_KEY"): Hex {
  const v = process.env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} missing or not a 0x-prefixed 32-byte hex key (see .env.example)`);
  return v as Hex;
}

export const flag = (name: string) => process.argv.includes(`--${name}`);
export function opt(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const short = (s: string) => `${s.slice(0, 6)}…${s.slice(-4)}`;
export const compact = (v: unknown, max = 160) => {
  const s = JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
