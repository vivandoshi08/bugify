import { z } from "zod";

/** Public env (NEXT_PUBLIC_*), safe for the browser. Validated once at import. */
const schema = z.object({
  chainId: z.coerce.number().int().default(84532),
  rpcUrl: z.string().url().optional(),
  privyAppId: z.string().min(1),
  supabaseUrl: z.string().url(),
  supabasePublishableKey: z.string().min(1),
});

export const env = schema.parse({
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID,
  rpcUrl: process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL,
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID,
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
