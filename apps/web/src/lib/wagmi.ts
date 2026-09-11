import { createConfig } from "@privy-io/wagmi";
import { chains, transportFor } from "@/lib/chains";

/** Base Sepolia (84532) + anvil (31337). Privy injects its connector at runtime. */
export const wagmiConfig = createConfig({
  chains,
  transports: {
    [chains[0].id]: transportFor(chains[0]),
    [chains[1].id]: transportFor(chains[1]),
  },
  ssr: true,
});
