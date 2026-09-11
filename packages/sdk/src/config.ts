import type { Hex } from "./types.ts";
import deployments from "../../../contracts/deployments/84532.json" with { type: "json" };

export const CHAIN_ID = 84532 as const;
export const DEFAULT_RPC_URL = "https://sepolia.base.org";
export const EXPLORER_URL = "https://sepolia.basescan.org";

export const BAZAAR_ADDRESS = deployments.Bazaar as Hex;
export const SINGLE_VERIFIER_ADDRESS = deployments.SingleVerifier as Hex;
export const PLATFORM_ADDRESS = deployments.verifier as Hex;

export const explorerTx = (hash: string) => `${EXPLORER_URL}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${EXPLORER_URL}/address/${addr}`;

/**
 * Demo amounts. Production numbers from docs/ARCHITECTURE.md divided by DEMO_SCALE because the
 * platform wallet holds ~1e-4 ETH of testnet gas. Override with BUGIFY_DEMO_SCALE.
 */
export const DEMO_SCALE = Number(process.env.BUGIFY_DEMO_SCALE ?? 100);

/** Plain decimal string (never scientific notation) so viem's parseEther accepts it. */
export const ethString = (n: number): string => n.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");

export const DEMO = {
  rewardEth: ethString(0.02 / DEMO_SCALE),
  minBondEth: ethString(0.002 / DEMO_SCALE),
  expiryHours: 48,
  k: 3,
} as const;
