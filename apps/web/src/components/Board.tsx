"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BAZAAR_ADDRESS, explorerAddress } from "@bugify/sdk";
import { supabase } from "@/lib/supabase";
import { shortAddr } from "@/lib/format";
import { fetchBounties, fetchCommits, fetchEvents, EVENT_LIMIT, type BountyRow, type CommitRow, type EventRow } from "@/lib/queries";
import { GLOSSARY } from "@/lib/glossary";
import { StatsStrip } from "@/components/StatsStrip";
import { BountyRow as Row } from "@/components/BountyRow";
import { EventTicker } from "@/components/EventTicker";
import { AgentConsole } from "@/components/AgentConsole";
import { HowItWorks } from "@/components/HowItWorks";
import { Tip } from "@/components/Tip";
import { useNow } from "@/components/Countdown";

type Data = { bounties: BountyRow[]; commits: CommitRow[]; events: EventRow[] };

const STATUS_ORDER = { OPEN: 0, VOIDED: 1, CLOSED: 2 } as const;
const POLL_MS = 3000;

async function loadAll(): Promise<Data> {
  const [bounties, commits, events] = await Promise.all([fetchBounties(), fetchCommits(), fetchEvents()]);
  return { bounties, commits, events };
}

export function Board() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<"connecting" | "realtime" | "polling">("connecting");
  const [expanded, setExpanded] = useState<number | null>(null);
  const now = useNow();

  const refresh = useCallback(() => {
    loadAll()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  // Initial load + realtime subscription; fall back to polling on channel error.
  useEffect(() => {
    refresh();
    let poll: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (poll) return;
      poll = setInterval(refresh, POLL_MS);
      setLive("polling");
    };
    // Any change on a table → refetch everything. Cheap for a demo-sized ledger and avoids
    // reconciling partial realtime payloads (public_bounties is a view, so bounties rows lack manifest fields).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = (payload: { table?: string; eventType?: string; new?: unknown }) => {
      if (payload.table === "events" && payload.eventType === "INSERT") {
        const row = payload.new as EventRow;
        setData((d) => (d ? { ...d, events: [row, ...d.events.filter((e) => e.id !== row.id)].slice(0, EVENT_LIMIT) } : d));
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const channel = supabase
      .channel("board")
      .on("postgres_changes", { event: "*", schema: "public", table: "commits" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "events" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "bounties" }, onChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (poll) clearInterval(poll);
          poll = null;
          setLive("realtime");
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          startPolling();
        }
      });
    return () => {
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [refresh]);

  // Deep link: /#bounty-<id> (from the Northwind page) expands that row and scrolls to it once its data is loaded.
  const handledHash = useRef<string | null>(null);
  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash;
      const m = /^#bounty-(\d+)$/.exec(hash);
      if (!m || handledHash.current === hash) return;
      const id = Number(m[1]);
      if (!data?.bounties.some((b) => b.id === id)) return;
      handledHash.current = hash;
      setExpanded(id);
      requestAnimationFrame(() => document.getElementById(`bounty-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    };
    const onHashChange = () => {
      handledHash.current = null;
      apply();
    };
    apply();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [data]);

  const sorted = useMemo(() => {
    if (!data) return [];
    return [...data.bounties].sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.expiry.localeCompare(b.expiry) || a.id - b.id,
    );
  }, [data]);

  const commitsByBounty = useMemo(() => {
    const m = new Map<number, CommitRow[]>();
    for (const c of data?.commits ?? []) {
      const arr = m.get(c.bounty_id) ?? [];
      arr.push(c);
      m.set(c.bounty_id, arr);
    }
    return m;
  }, [data]);

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Black Box Bazaar</h1>
            <p className="text-sm text-zinc-500">
              Bounties for socially engineering production LLM agents. Escrow first, verified replay, automatic settlement.
            </p>
          </div>
          <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-zinc-500">
            <span className={`h-1.5 w-1.5 rounded-full ${live === "realtime" ? "bg-emerald-500" : live === "polling" ? "bg-amber-500" : "bg-zinc-400"}`} />
            {live}
          </span>
        </div>
        <StatsStrip bounties={data?.bounties ?? []} commits={data?.commits ?? []} events={data?.events ?? []} now={now} />
      </header>

      <HowItWorks />

      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Failed to load: {error}
        </p>
      )}

      {/* Narrow: table → agent console → events. Wide (≥1100px): table + events side by side, console as a full-width row under both. */}
      <div className="flex flex-col gap-6 min-[1100px]:flex-row min-[1100px]:flex-wrap min-[1100px]:items-start">
        <main className="order-1 min-w-0 flex-1">
          {data === null ? (
            <p className="py-10 text-center text-sm text-zinc-500">Loading…</p>
          ) : sorted.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
              <table className="w-full min-w-[860px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wider text-zinc-500">
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Bounty</th>
                    <th className="px-3 py-2 text-right font-medium">
                      <Tip text={GLOSSARY.escrow}>Escrow</Tip>
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      <Tip text={GLOSSARY.invariants}>Invariants</Tip> · rewards
                    </th>
                    <th className="px-3 py-2 text-left font-medium">
                      <Tip text={GLOSSARY.slots}>Slots</Tip>
                    </th>
                    <th className="px-3 py-2 text-right font-medium">
                      <Tip text={GLOSSARY.commits}>Commits</Tip>
                    </th>
                    <th className="px-3 py-2 text-right font-medium">Expires</th>
                    <th className="px-3 py-2 text-left font-medium">Buyer</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((b) => (
                    <Row
                      key={b.id}
                      bounty={b}
                      commits={commitsByBounty.get(b.id) ?? []}
                      now={now}
                      expanded={expanded === b.id}
                      onToggle={() => setExpanded((cur) => (cur === b.id ? null : b.id))}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </main>
        <section className="order-2 w-full min-[1100px]:order-3 min-[1100px]:basis-full">
          <AgentConsole />
        </section>
        <aside className="order-3 w-full shrink-0 min-[1100px]:order-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900 min-[1100px]:sticky min-[1100px]:top-4 min-[1100px]:max-h-[calc(100vh-2rem)] min-[1100px]:w-80 min-[1100px]:overflow-y-auto">
          <EventTicker events={data?.events ?? []} now={now} />
        </aside>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto max-w-md rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">No bounties yet</h2>
      <p className="mt-2 text-sm text-zinc-500">
        When a buyer posts a bounty, it appears here with its escrow, invariants and expiry. Seller commits, verifier
        attestations and settlements stream in live underneath each row.
      </p>
      <a
        className="mt-4 inline-block font-mono text-xs text-zinc-700 hover:underline dark:text-zinc-300"
        href={explorerAddress(BAZAAR_ADDRESS)}
        target="_blank"
        rel="noreferrer"
      >
        Bazaar {shortAddr(BAZAAR_ADDRESS)} on Basescan ↗
      </a>
    </div>
  );
}
