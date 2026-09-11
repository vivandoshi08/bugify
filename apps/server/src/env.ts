import "dotenv/config";
import { z } from "zod";
import { BAZAAR_ADDRESS } from "@bugify/sdk";

/** Block the Bazaar was deployed at on Base Sepolia (contracts/broadcast/Deploy.s.sol/84532). */
export const BAZAAR_DEPLOY_BLOCK = 46691840n;

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/, "expected 0x-hex");
const emptyToUndef = (v: unknown) => (v === "" ? undefined : v);
const num = (def: number) => z.preprocess(emptyToUndef, z.coerce.number().int().nonnegative().default(def));

const schema = z.object({
  PORT: num(8787),
  RPC_URL: z.string().url(),
  BAZAAR_ADDRESS: z.preprocess(emptyToUndef, hex.default(BAZAAR_ADDRESS)),
  VERIFIER_KEY: hex,
  ANTHROPIC_API_KEY: z.string().default(""),
  ANTHROPIC_BASE_URL: z.preprocess(emptyToUndef, z.string().url().optional()),
  TARGET_MODEL: z.preprocess(emptyToUndef, z.string().default("claude-haiku-4-5-20251001")),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  DISPUTE_WINDOW: num(60),
  REVEAL_TIMEOUT: num(120),
  K: num(3),
  INDEXER_INTERVAL_MS: num(4000),
  SETTLER_INTERVAL_MS: num(20000),
  INDEXER_START_BLOCK: z.preprocess(emptyToUndef, z.coerce.bigint().optional()),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("[env] invalid configuration:", z.prettifyError(parsed.error));
  process.exit(1);
}
export const env = parsed.data;
export type Env = typeof env;
