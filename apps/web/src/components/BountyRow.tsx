import { explorerAddress } from "@bugify/sdk";
import { eth, shortAddr } from "@/lib/format";
import type { BountyRow as Bounty, CommitRow } from "@/lib/queries";
import { Bar, StatusChip } from "@/components/OutcomeChip";
import { Countdown } from "@/components/Countdown";
import { BountyPanel } from "@/components/BountyPanel";

type Props = { bounty: Bounty; commits: CommitRow[]; now: number; expanded: boolean; onToggle: () => void };

/** Slots used per invariant = commits with outcome PASS on that bounty+invariant. */
export function slotsUsed(commits: CommitRow[], invariant: number): number {
  return commits.filter((c) => c.invariant === invariant && c.outcome === "PASS").length;
}

const cell = "px-3 py-2.5 align-middle";

export function BountyRow({ bounty: b, commits, now, expanded, onToggle }: Props) {
  const totalSlots = b.slots.reduce((a, n) => a + n, 0);
  const used = b.slots.reduce((a, _n, i) => a + Math.min(slotsUsed(commits, i), b.slots[i] ?? 0), 0);
  const closed = b.status === "CLOSED";
  const dim = closed ? "opacity-60" : "";
  const cols = 8;

  return (
    <>
      <tr
        id={`bounty-${b.id}`}
        onClick={onToggle}
        className={`scroll-mt-20 cursor-pointer border-t border-zinc-200 text-sm hover:bg-zinc-100/70 dark:border-zinc-800 dark:hover:bg-zinc-800/40 ${expanded ? "bg-zinc-100/50 dark:bg-zinc-800/30" : ""} ${dim}`}
      >
        <td className={cell}>
          <StatusChip status={b.status} />
        </td>
        <td className={cell}>
          <div className="flex flex-col">
            <span className="font-medium text-zinc-900 dark:text-zinc-50">
              <span className="mr-1.5 font-mono text-xs text-zinc-400">#{b.id}</span>
              {b.name}
            </span>
            <span className="font-mono text-xs text-zinc-500">{b.model}</span>
          </div>
        </td>
        <td className={`${cell} text-right`}>
          <span className="font-mono font-semibold tabular-nums text-zinc-900 dark:text-zinc-50">{eth(b.escrow_wei)}</span>
          <span className="ml-1 text-xs text-zinc-500">ETH</span>
        </td>
        <td className={cell}>
          <div className="flex items-baseline gap-2">
            <span className="tabular-nums">{b.rewards_wei.length}</span>
            <span className="flex flex-wrap gap-1">
              {b.rewards_wei.map((r, i) => (
                <span key={i} className="rounded bg-zinc-200/70 px-1 font-mono text-[11px] tabular-nums text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                  {eth(r)}
                </span>
              ))}
            </span>
          </div>
        </td>
        <td className={cell}>
          <Bar value={used} max={totalSlots} />
        </td>
        <td className={`${cell} text-right font-mono tabular-nums`}>{commits.length}</td>
        <td className={`${cell} text-right`}>
          <Countdown expiry={b.expiry} closed={closed} now={now} />
        </td>
        <td className={cell}>
          <a
            className="font-mono text-xs text-zinc-600 hover:underline dark:text-zinc-400"
            href={explorerAddress(b.buyer)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {shortAddr(b.buyer)}
          </a>
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/60">
          <td colSpan={cols} className="p-0">
            <BountyPanel bounty={b} commits={commits} />
          </td>
        </tr>
      )}
    </>
  );
}
