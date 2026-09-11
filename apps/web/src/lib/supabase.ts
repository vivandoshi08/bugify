import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Browser-safe client (publishable key, RLS enforced). */
export const supabase = createClient(env.supabaseUrl, env.supabasePublishableKey);

/** Server-only client (secret key, bypasses RLS). Never import from client components. */
export function supabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY not set");
  return createClient(url, key, { auth: { persistSession: false } });
}
