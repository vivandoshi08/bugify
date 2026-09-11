"use client";

import { useEffect, useState } from "react";
import { countdown } from "@/lib/format";

/** Ticks once a second. Starts at 0 on the server so SSR markup is stable. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    queueMicrotask(tick);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const HOUR = 3_600_000;

export function Countdown({ expiry, closed, now }: { expiry: string; closed: boolean; now: number }) {
  if (!now) return <span className="font-mono text-zinc-400">—</span>;
  const { text, ms } = countdown(expiry, now);
  const expired = ms <= 0;
  let cls = "text-zinc-700 dark:text-zinc-300";
  if (closed || expired) cls = "text-zinc-400 dark:text-zinc-600";
  else if (ms < HOUR) cls = "text-red-600 dark:text-red-400 font-semibold";
  else if (ms < 24 * HOUR) cls = "text-amber-600 dark:text-amber-400";
  return (
    <span className={`font-mono tabular-nums ${cls}`} title={new Date(expiry).toLocaleString()}>
      {text}
    </span>
  );
}
