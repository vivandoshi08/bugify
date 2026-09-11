import { z } from "zod";

/** Public env (NEXT_PUBLIC_*), safe for the browser. Validated once at import. */
const schema = z.object({
  supabaseUrl: z.string().url(),
  supabasePublishableKey: z.string().min(1),
});

export const env = schema.parse({
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
});
