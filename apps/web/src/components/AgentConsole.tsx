"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { explorerTx } from "@bugify/sdk";
import { supabase } from "@/lib/supabase";
import { AGENT_LOG_LIMIT, fetchAgentLogs, type AgentLogRow, type AgentName } from "@/lib/queries";

const PANES: Array<{ agent: AgentName; title: string }> = [
  { agent: "buyer", title: "Builder agent (buyer)" },
  { agent: "seller", title: "Finder agent (seller)" },
  { agent: "verifier", title: "Verifier" },
];
const POLL_MS = 3000;
type Lines = Record<AgentName, AgentLogRow[]>;
const EMPTY: Lines = { buyer: [], seller: [], verifier: [] };

const isAgent = (s: string): s is AgentName => s === "buyer" || s === "seller" || s === "verifier";

async function loadAll(): Promise<Lines> {
  const [buyer, seller, verifier] = await Promise.all(PANES.map((p) => fetchAgentLogs(p.agent)));
  return { buyer: buyer ?? [], seller: seller ?? [], verifier: verifier ?? [] };
}

// Only hashes that follow "tx" (e.g. "attest tx 0x…" or a /tx/ URL) are transaction hashes;
// manifest/content hashes in builder logs are the same shape and must not become dead Basescan links.
const HASH_RE = /((?:tx\s+|\/tx\/)0x[0-9a-fA-F]{64})/g;

function linkHashes(line: string): ReactNode[] {
  return line.split(HASH_RE).map((raw, i) => {
    if (i % 2 !== 1) return <span key={i}>{raw}</span>;
    const part = raw.slice(raw.indexOf("0x"));
    const prefix = raw.slice(0, raw.indexOf("0x"));
    return (
      <span key={i}>
        {prefix.replace("/tx/", "")}
        <a className="underline decoration-dotted underline-offset-2 hover:decoration-solid" href={explorerTx(part)} target="_blank" rel="noreferrer">
          {part.slice(0, 10)}…{part.slice(-6)}
        </a>
      </span>
    );
  });
}

const LEVEL_CLS: Record<string, string> = {
  info: "text-zinc-700 dark:text-zinc-300",
  tx: "text-sky-700 dark:text-sky-400",
  warn: "text-amber-700 dark:text-amber-400",
};

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  return d.toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function Pane({ title, lines }: { title: string; lines: AgentLogRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  // Autoscroll to the newest line (bottom) whenever the list changes.
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-zinc-200 bg-zinc-950 dark:border-zinc-800">
      <header className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <h3 className="font-mono text-[11px] uppercase tracking-wider text-zinc-400">{title}</h3>
        <span className="font-mono text-[10px] tabular-nums text-zinc-600">{lines.length} lines</span>
      </header>
      <div ref={ref} className="h-56 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
        {lines.length === 0 ? (
          <p className="text-zinc-600">no activity yet</p>
        ) : (
          lines.map((l) => (
            <div key={l.id} className={`flex gap-2 whitespace-pre-wrap break-words ${LEVEL_CLS[l.level] ?? LEVEL_CLS.info}`}>
              <span className="shrink-0 tabular-nums text-zinc-600">{clock(l.ts)}</span>
              <span className="min-w-0">{l.level === "tx" ? linkHashes(l.line) : l.line}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/**
 * Three terminal panes fed by `agent_logs`: the autonomous buyer / seller agents (apps/agents) and the
 * server's verifier. Initial select + Realtime INSERT subscription; polls every 3 s if the channel fails.
 */
export function AgentConsole() {
  const [lines, setLines] = useState<Lines>(EMPTY);
  const [live, setLive] = useState<"connecting" | "realtime" | "polling">("connecting");

  useEffect(() => {
    let cancelled = false;
    const refresh = () => loadAll().then((l) => { if (!cancelled) setLines(l); }).catch(() => {});
    refresh();
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(refresh, POLL_MS);
      setLive("polling");
    };
    const channel = supabase
      .channel("agent-console")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_logs" }, (payload) => {
        const row = payload.new as AgentLogRow;
        const agent = row.agent;
        if (!isAgent(agent)) return;
        setLines((cur) => {
          const list = cur[agent];
          if (list.some((l) => l.id === row.id)) return cur;
          return { ...cur, [agent]: [...list, row].slice(-AGENT_LOG_LIMIT) };
        });
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (poll) clearInterval(poll);
          poll = null;
          setLive("realtime");
          refresh(); // catch anything inserted between the initial select and the subscription
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          startPolling();
        }
      });
    return () => {
      cancelled = true;
      if (poll) clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Agent console</h2>
        <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
          <span className={`h-1.5 w-1.5 rounded-full ${live === "realtime" ? "bg-emerald-500" : live === "polling" ? "bg-amber-500" : "bg-zinc-400"}`} />
          {live}
        </span>
      </div>
      <div className="flex flex-col gap-3 md:flex-row">
        {PANES.map((p) => (
          <Pane key={p.agent} title={p.title} lines={lines[p.agent]} />
        ))}
      </div>
    </div>
  );
}
