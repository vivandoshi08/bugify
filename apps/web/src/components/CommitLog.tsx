import { explorerAddress, explorerTx } from "@bugify/sdk";
import { shortAddr } from "@/lib/format";
import type { CommitRow } from "@/lib/queries";
import { Bar, OutcomeChip } from "@/components/OutcomeChip";

const th = "px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const td = "px-3 py-1.5 align-middle";

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
              <a href={explorerTx(s.tx as string)} target="_blank" rel="noreferrer" title={`${s.label}: ${s.tx}`}>
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

export function CommitLog({ commits, k }: { commits: CommitRow[]; k: number }) {
  if (commits.length === 0) {
    return <p className="rounded border border-dashed border-zinc-300 px-3 py-3 text-xs text-zinc-500 dark:border-zinc-700">No commits yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-100/70 dark:bg-zinc-900">
          <tr>
            <th className={th}>Seq</th>
            <th className={th}>Seller</th>
            <th className={th}>Inv</th>
            <th className={th}>Outcome</th>
            <th className={th}>Hits / k</th>
            <th className={th} title="commit → attest → dispute → settle">Progress</th>
          </tr>
        </thead>
        <tbody>
          {commits.map((c) => (
            <tr key={c.id} className="border-t border-zinc-200 dark:border-zinc-800">
              <td className={`${td} font-mono text-xs tabular-nums text-zinc-500`}>{c.seq}</td>
              <td className={td}>
                <a className="font-mono text-xs hover:underline" href={explorerAddress(c.seller)} target="_blank" rel="noreferrer">
                  {shortAddr(c.seller)}
                </a>
              </td>
              <td className={`${td} font-mono text-xs tabular-nums`}>{c.invariant}</td>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
