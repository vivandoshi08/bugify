import { explorerTx } from "@bugify/sdk";
import { eth, shortHash } from "@/lib/format";
import { GLOSSARY } from "@/lib/glossary";
import type { BountyRow, CommitRow } from "@/lib/queries";
import { Bar } from "@/components/OutcomeChip";
import { CommitLog } from "@/components/CommitLog";
import { Tip } from "@/components/Tip";
import { slotsUsed } from "@/components/BountyRow";

const th = "px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const td = "px-3 py-1.5 align-middle";

/** Summaries mark tool names with backticks; render those as code. */
function Summary({ text }: { text: string }) {
  const parts = text.split("`");
  return (
    <span className="text-xs text-zinc-500">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rounded bg-zinc-200/70 px-1 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
            {p}
          </code>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </span>
  );
}

export function BountyPanel({ bounty: b, commits }: { bounty: BountyRow; commits: CommitRow[] }) {
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          <Tip text={GLOSSARY.invariants}>Invariants</Tip>
        </h3>
        <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-100/70 dark:bg-zinc-900">
              <tr>
                <th className={th}>#</th>
                <th className={th}>Label</th>
                <th className={`${th} text-right`}>Reward</th>
                <th className={th}>
                  <Tip text={GLOSSARY.slots}>Slots</Tip>
                </th>
              </tr>
            </thead>
            <tbody>
              {b.invariant_labels.slice(0, b.rewards_wei.length).map((label, i) => (
                <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className={`${td} font-mono text-xs text-zinc-500`}>{i}</td>
                  <td className={td}>
                    <div className="flex flex-col gap-0.5">
                      <span>{label}</span>
                      {b.invariant_summaries?.[i] && <Summary text={b.invariant_summaries[i]} />}
                    </div>
                  </td>
                  <td className={`${td} text-right font-mono tabular-nums`}>{eth(b.rewards_wei[i])} ETH</td>
                  <td className={td}>
                    <Bar value={Math.min(slotsUsed(commits, i), b.slots[i] ?? 0)} max={b.slots[i] ?? 0} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Commit log</h3>
        <CommitLog commits={commits} k={b.k} labels={b.invariant_labels} />
      </section>

      <footer className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-zinc-500">
        <span title={b.manifest_hash}>manifest {shortHash(b.manifest_hash)}</span>
        <span title={b.control_hash ?? undefined}>{b.control_hash ? `control ${shortHash(b.control_hash)}` : "no control"}</span>
        <Tip text={GLOSSARY.minBond}>min bond {eth(b.min_bond_wei)} ETH</Tip>
        <Tip text={GLOSSARY.k}>k={b.k}</Tip>
        <Tip text={GLOSSARY.controlTier}>control tier {b.control_tier_bps} bps</Tip>
        {b.tx_hash && (
          <a className="hover:underline" href={explorerTx(b.tx_hash)} target="_blank" rel="noreferrer">
            tx {shortHash(b.tx_hash)} ↗
          </a>
        )}
        {b.block != null && <span>block {b.block}</span>}
        {b.pending && <span className="text-amber-600 dark:text-amber-400">pending</span>}
      </footer>
    </div>
  );
}
