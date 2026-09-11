"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fetchBounties, fetchCommits, type BountyRow, type CommitRow } from "@/lib/queries";
import { useNow } from "@/components/Countdown";
import { FamilyCard } from "@/components/northwind/FamilyCard";
import { groupFamilies } from "@/components/northwind/families";

const POLL_MS = 5000;
type Data = { bounties: BountyRow[]; commits: CommitRow[] };

/** The deployer's view: Northwind's agents grouped by manifest family, with what the Bazaar found in each build. */
export function NorthwindView() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  const refresh = useCallback(() => {
    Promise.all([fetchBounties(), fetchCommits()])
      .then(([bounties, commits]) => {
        setData({ bounties, commits });
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    refresh();
    let poll: ReturnType<typeof setInterval> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 150);
    };
    const channel = supabase
      .channel("northwind")
      .on("postgres_changes", { event: "*", schema: "public", table: "commits" }, onChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "bounties" }, onChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          if (poll) clearInterval(poll);
          poll = null;
        } else if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") && !poll) {
          poll = setInterval(refresh, POLL_MS);
        }
      });
    return () => {
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [refresh]);

  const families = useMemo(() => (data ? groupFamilies(data.bounties, data.commits) : []), [data]);

  return (
    <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-6 px-4 py-6 sm:px-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">Northwind</h1>
          <Link href="/" className="text-xs text-zinc-500 hover:text-zinc-900 hover:underline dark:hover:text-zinc-100">
            ← Back to the board
          </Link>
        </div>
        <p className="text-sm text-zinc-500">
          This is the deployer&apos;s side: the agents Northwind runs in production, and what the Bazaar has found in them.
        </p>
      </header>

      {error && (
        <p className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-300">
          Failed to load: {error}
        </p>
      )}

      {data === null ? (
        <p className="py-10 text-center text-sm text-zinc-500">Loading…</p>
      ) : families.length === 0 ? (
        <div className="mx-auto max-w-md rounded-lg border border-dashed border-zinc-300 bg-white px-6 py-10 text-center dark:border-zinc-700 dark:bg-zinc-900">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">No agents posted yet</h2>
          <p className="mt-2 text-sm text-zinc-500">
            When Northwind&apos;s buyer agent posts a bounty for one of its builds, that agent appears here with every version the
            Bazaar has tested.
          </p>
        </div>
      ) : (
        <div className="grid gap-4">
          {families.map((f) => (
            <FamilyCard key={f.name} family={f} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}
