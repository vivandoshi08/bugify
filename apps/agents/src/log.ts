// Shared logger for the autonomous agents: every line goes to stdout and, when SERVER_URL is set, is also
// POSTed to `${SERVER_URL}/agent-logs` so the web UI can show a live agent feed. The POST is fire-and-forget
// with a 2 s timeout and never throws or logs: the route may not exist yet (a 404 is silent by design).

export type AgentName = "buyer" | "seller";
export type LogLevel = "info" | "tx" | "warn";
export type LogMeta = { agent?: AgentName; level?: LogLevel };
export type AgentLogEntry = { agent: string; level: LogLevel; line: string; ts: string };

const POST_TIMEOUT_MS = 2_000;

function defaultAgent(): string {
  const n = process.env.AGENT_NAME?.trim();
  return n && n.length > 0 ? n : "agent";
}

function post(entry: AgentLogEntry): void {
  const base = process.env.SERVER_URL?.trim().replace(/\/+$/, "");
  if (!base) return;
  try {
    fetch(`${base}/agent-logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
      .then((res) => {
        // Drain the body so the socket is released; status codes (including 404) are deliberately ignored.
        res.body?.cancel().catch(() => {});
      })
      .catch(() => {});
  } catch {
    // fetch itself can throw synchronously on a malformed URL; swallow, logging must never fail the agent.
  }
}

/** Print `line` to stdout and mirror it to the server's agent-log feed (if SERVER_URL is set). */
export function emit(line: string, meta: LogMeta = {}): void {
  const entry: AgentLogEntry = {
    agent: meta.agent ?? defaultAgent(),
    level: meta.level ?? "info",
    line,
    ts: new Date().toISOString(),
  };
  const tag = entry.level === "info" ? "" : ` ${entry.level}`;
  process.stdout.write(`[${entry.agent}${tag}] ${line}\n`);
  post(entry);
}
