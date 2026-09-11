import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/** Browser-safe client (publishable key, RLS enforced). Read + realtime only. */
export const supabase = createClient(env.supabaseUrl, env.supabasePublishableKey, {
  auth: { persistSession: false },
});
