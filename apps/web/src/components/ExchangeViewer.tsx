"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { Trace } from "@bugify/sdk";
import { fetchFinding, type FindingResult } from "@/lib/findings";
import { findViolation, type Violation } from "@/lib/violation";

/** Compact JSON, cut to `n` chars. */
function compact(v: unknown, n: number): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Demo-mode chat view of the agent-to-agent exchange behind a PASS commit.
 * Seller turns left, target replies right, tool calls between them; the first call that
 * breaks the invariant is marked in red (canary: the reply bubble instead).
 */
export function ExchangeViewer({ commitId }: { commitId: number }) {
  const [result, setResult] = useState<FindingResult | null>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchFinding(commitId).then((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
    };
  }, [commitId]);

  if (!result) return <p className="text-xs text-zinc-500">Loading exchange…</p>;
  if (result.status === "private") return <p className="text-xs text-zinc-500">Findings are private to the buyer.</p>;
  if (result.status === "error") return <p className="text-xs text-red-700 dark:text-red-400">Could not load the finding: {result.message}</p>;

  const f = result.finding;
  const idx = Math.min(tab, f.traces.length - 1);
  const trace = f.traces[idx];
  const violation = trace ? findViolation(f.spec, trace, f.evaluations[idx]?.evidence) : null;

  return (
    <div className="flex flex-col gap-2">
      <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-800 dark:text-amber-300">
        Visible because DEMO_PUBLIC_FINDINGS is on. In production only the bounty&apos;s buyer can fetch this, with a signed request.
      </p>
      {f.traces.length > 1 && (
        <div role="tablist" aria-label="replays" className="flex flex-wrap gap-1">
          {f.traces.map((_, i) => {
            const hit = f.evaluations[i]?.violated;
            const active = i === idx;
            return (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(i)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                  active
                    ? "border-zinc-800 bg-zinc-800 text-white dark:border-zinc-200 dark:bg-zinc-200 dark:text-zinc-900"
                    : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
                }`}
              >
                replay {i + 1}
                <span className={active ? "opacity-80" : hit ? "text-emerald-600 dark:text-emerald-400" : "text-zinc-400"}> · {hit ? "hit" : "miss"}</span>
              </button>
            );
          })}
        </div>
      )}
      {trace ? (
        <Chat trace={trace} violation={violation} invariant={f.invariant} label={f.label ?? ""} />
      ) : (
        <p className="text-xs text-zinc-500">No traces stored for this finding.</p>
      )}
      <p className="font-mono text-[10px] text-zinc-400">
        {trace?.model} · {f.hits}/{f.k} hits · {f.class}
        {f.transcript.turns.length !== trace?.turns.length ? ` · transcript ${f.transcript.turns.length} turns` : ""}
      </p>
    </div>
  );
}

function Chat({ trace, violation, invariant, label }: { trace: Trace; violation: Violation | null; invariant: number; label: string }) {
  const breaks = (
    <span className="text-[11px] font-medium text-red-700 dark:text-red-400">
      ← breaks invariant {invariant}: {label}
    </span>
  );
  return (
    <ol className="flex flex-col gap-3 rounded border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-900">
      {trace.turns.map((t, ti) => (
        <li key={ti} className="flex flex-col gap-1.5">
          <div className="flex justify-start">
            <Bubble side="left" who="seller (user)">
              {t.user}
            </Bubble>
          </div>
          {t.toolCalls.length > 0 && (
            <div className="flex flex-col items-center gap-1">
              {t.toolCalls.map((c, ci) => {
                const bad = violation?.turn === ti && violation.call === ci;
                return (
                  <div key={ci} className="flex max-w-full flex-wrap items-center justify-center gap-1.5">
                    <code
                      className={`max-w-full break-all rounded border px-1.5 py-0.5 font-mono text-[11px] ${
                        bad
                          ? "border-red-500 bg-red-500/10 text-red-800 dark:text-red-300"
                          : "border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                      }`}
                    >
                      {c.name}({compact(c.input, 70)}) → {compact(c.result, 50)}
                    </code>
                    {bad && breaks}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-col items-end gap-0.5">
            <Bubble side="right" who="target agent" bad={violation?.turn === ti && violation.call === null}>
              {t.assistant || <span className="italic text-zinc-400">(no text)</span>}
            </Bubble>
            {violation?.turn === ti && violation.call === null && breaks}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Bubble({ side, who, bad = false, children }: { side: "left" | "right"; who: string; bad?: boolean; children: ReactNode }) {
  const tone = bad
    ? "border-red-500 bg-red-500/10 text-red-900 dark:text-red-200"
    : side === "left"
      ? "border-zinc-200 bg-zinc-100 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
      : "border-emerald-200 bg-emerald-50 text-zinc-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-zinc-200";
  return (
    <div className={`max-w-[78%] rounded-lg border px-3 py-2 ${tone}`}>
      <div className={`mb-0.5 text-[10px] uppercase tracking-wider ${bad ? "text-red-600 dark:text-red-400" : "text-zinc-400"}`}>{who}</div>
      <div className="whitespace-pre-wrap text-xs leading-snug">{children}</div>
    </div>
  );
}
