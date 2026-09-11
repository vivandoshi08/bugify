import { explorerTx } from "@bugify/sdk";
import { eth, shortHash } from "@/lib/format";
import type { BountyRow, CommitRow } from "@/lib/queries";
import { Bar } from "@/components/OutcomeChip";
import { CommitLog } from "@/components/CommitLog";
import { slotsUsed } from "@/components/BountyRow";

const th = "px-3 py-1.5 text-left text-[11px] font-medium uppercase tracking-wider text-zinc-500";
const td = "px-3 py-1.5 align-middle";

export function BountyPanel({ bounty: b, commits }: { bounty: BountyRow; commits: CommitRow[] }) {
  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <section>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-zinc-500">Invariants</h3>
        <div className="overflow-x-auto rounded border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-100/70 dark:bg-zinc-900">
              <tr>
                <th className={th}>#</th>
                <th className={th}>Label</th>
                <th className={`${th} text-right`}>Reward</th>
                <th className={th}>Slots</th>
              </tr>
            </thead>
            <tbody>
              {b.invariant_labels.slice(0, b.rewards_wei.length).map((label, i) => (
                <tr key={i} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className={`${td} font-mono text-xs text-zinc-500`}>{i}</td>
                  <td className={td}>{label}</td>
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
        <CommitLog commits={commits} k={b.k} />
      </section>

      <footer className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11px] text-zinc-500">
        <span title={b.manifest_hash}>manifest {shortHash(b.manifest_hash)}</span>
        <span title={b.control_hash ?? undefined}>{b.control_hash ? `control ${shortHash(b.control_hash)}` : "no control"}</span>
        <span>min bond {eth(b.min_bond_wei)} ETH</span>
        <span>k={b.k}</span>
        <span>control tier {b.control_tier_bps} bps</span>
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
