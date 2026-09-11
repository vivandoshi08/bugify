"use client";

import { useState } from "react";
import { explorerAddress, explorerTx } from "@bugify/sdk";
import { eth, shortAddr } from "@/lib/format";
import { GLOSSARY } from "@/lib/glossary";
import type { CommitRow } from "@/lib/queries";
import { Bar, OutcomeChip } from "@/components/OutcomeChip";
import { Tip } from "@/components/Tip";
import { Verification } from "@/components/Verification";
import { ExchangeViewer } from "@/components/ExchangeViewer";

const th = "px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const td = "px-3 py-1.5 align-middle";
const COLS = 8;

type Step = { label: string; tx: string | null; optional?: boolean };

function Rail({ steps }: { steps: Step[] }) {
  return (
    <span className="inline-flex items-center gap-1">
      {steps.map((s, i) => {
        const lit = Boolean(s.tx);
        const dot = lit
          ? "bg-emerald-500 border-emerald-500"
          : s.optional
            ? "border-dashed border-zinc-300 dark:border-zinc-700"
            : "border-zinc-300 dark:border-zinc-700";
        const el = <span className={`block h-2.5 w-2.5 rounded-full border ${dot}`} />;
        return (
          <span key={s.label} className="inline-flex items-center gap-1">
            {i > 0 && <span className="h-px w-2 bg-zinc-300 dark:bg-zinc-700" />}
            {lit ? (
              <a href={explorerTx(s.tx as string)} target="_blank" rel="noreferrer" title={`${s.label}: ${s.tx}`} onClick={(e) => e.stopPropagation()}>
                {el}
              </a>
            ) : (
              <span title={s.label}>{el}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export function CommitLog({ commits, k, labels = [] }: { commits: CommitRow[]; k: number; labels?: string[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (commits.length === 0) {
    return <p className="rounded border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-500 dark:border-zinc-700">No commits yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-100/70 dark:bg-zinc-900">
          <tr>
            <th className={th}>
              <Tip text={GLOSSARY.seq}>Seq</Tip>
            </th>
            <th className={th}>Seller</th>
            <th className={th}>Inv</th>
            <th className={`${th} text-right`}>
              <Tip text={GLOSSARY.bond}>Bond</Tip>
            </th>
            <th className={th}>Outcome</th>
            <th className={th}>
              <Tip text={GLOSSARY.hitsK}>Hits / k</Tip>
            </th>
            <th className={th}>
              <Tip text={GLOSSARY.progress}>Progress</Tip>
            </th>
            <th className={`${th} w-8`}>
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {commits.map((c) => {
            const isOpen = open === c.id;
            return [
              <tr
                key={c.id}
                onClick={() => setOpen((cur) => (cur === c.id ? null : c.id))}
                aria-expanded={isOpen}
                className={`cursor-pointer border-t border-zinc-200 hover:bg-zinc-100/70 dark:border-zinc-800 dark:hover:bg-zinc-800/40 ${isOpen ? "bg-zinc-100/50 dark:bg-zinc-800/30" : ""}`}
              >
                <td className={`${td} font-mono text-xs tabular-nums text-zinc-500`}>{c.seq}</td>
                <td className={td}>
                  <a
                    className="font-mono text-xs hover:underline"
                    href={explorerAddress(c.seller)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {shortAddr(c.seller)}
                  </a>
                </td>
                <td className={`${td} font-mono text-xs tabular-nums`} title={labels[c.invariant]}>
                  {c.invariant}
                </td>
                <td className={`${td} text-right font-mono text-xs tabular-nums`}>{eth(c.bond_wei)} ETH</td>
                <td className={td}>
                  <OutcomeChip outcome={c.outcome} />
                  {c.breaks_control && <span className="ml-1.5 text-[10px] uppercase text-zinc-400">base-model</span>}
                </td>
                <td className={td}>
                  <Bar value={c.hits ?? 0} max={k} tone={c.outcome === "FAIL" ? "zinc" : "emerald"} />
                </td>
                <td className={td}>
                  <Rail
                    steps={[
                      { label: "commit", tx: c.commit_tx },
                      { label: "attest", tx: c.attest_tx },
                      { label: "dispute", tx: c.dispute_tx, optional: true },
                      { label: "settle", tx: c.finalize_tx ?? c.reclaim_tx ?? c.resolve_tx },
                    ]}
                  />
                </td>
                <td className={`${td} text-center text-xs text-zinc-400`} aria-hidden>
                  {isOpen ? "▾" : "▸"}
                </td>
              </tr>,
              isOpen ? (
                <tr key={`${c.id}-details`} className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/60">
                  <td colSpan={COLS} className="p-0">
                    <CommitDetails commit={c} k={k} label={labels[c.invariant]} />
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function CommitDetails({ commit: c, k, label }: { commit: CommitRow; k: number; label?: string }) {
  const [showExchange, setShowExchange] = useState(false);
  const passed = c.outcome === "PASS" || c.outcome === "PASS_NO_SLOT";
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <details open>
        <summary className="cursor-pointer select-none text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Verification</summary>
        <div className="mt-2">
          <Verification record={c.verification} outcome={c.outcome} k={k} />
        </div>
      </details>
      {passed && (
        <div className="flex flex-col gap-2">
          {showExchange ? (
            <ExchangeViewer commitId={c.id} />
          ) : (
            <button
              type="button"
              onClick={() => setShowExchange(true)}
              className="self-start rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              Show exchange (demo)
            </button>
          )}
        </div>
      )}
      <div className="font-mono text-[11px] text-zinc-500">
        commit #{c.id} · invariant {c.invariant}
        {label ? ` · ${label}` : ""}
        {c.attested_at ? ` · attested ${new Date(c.attested_at).toLocaleString()}` : ""}
      </div>
    </div>
  );
}
