import { z } from "zod";

/** Public env (NEXT_PUBLIC_*), safe for the browser. Validated once at import. */
const schema = z.object({
  supabaseUrl: z.string().url(),
  supabasePublishableKey: z.string().min(1),
  /** apps/server base URL; only used by the demo finding viewer (GET /commits/:cid/finding). */
  serverUrl: z.string().url().default("http://localhost:8787"),
});

export const env = schema.parse({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  serverUrl: process.env.NEXT_PUBLIC_SERVER_URL || undefined,
});
