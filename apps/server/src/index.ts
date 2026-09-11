import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.ts";
import { account, bazaar } from "./chain.ts";
import { createApp } from "./routes.ts";
import * as sb from "./supabase.ts";
import { startIndexer } from "./indexer.ts";
import { startSettler } from "./verifier.ts";

const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY || undefined,
  ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
});
const app = createApp({ anthropic, log: (l) => console.log(`[harness] ${l}`) });

Bun.serve({ fetch: app.fetch, port: env.PORT });
console.log(`[server] listening on http://localhost:${env.PORT} · verifier ${account.address} · bazaar ${bazaar} · model ${env.TARGET_MODEL}`);
// Agent console retention: drop lines older than 24 h once per boot.
sb.pruneAgentLogs(24).then(() => console.log("[agent-logs] pruned rows older than 24 h")).catch((e) => console.log(`[agent-logs] prune failed: ${(e as Error).message}`));
startIndexer();
startSettler();
