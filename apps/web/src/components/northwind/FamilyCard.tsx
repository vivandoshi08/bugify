import { eth, timeAgo } from "@/lib/format";
import { Bar, StatusChip } from "@/components/OutcomeChip";
import { blurbFor, type Family, type Version } from "@/components/northwind/families";

const th = "px-2 py-1 text-left text-[10px] font-medium uppercase tracking-wider text-zinc-500";
const td = "px-2 py-1 align-middle";

function Regression({ n }: { n: number }) {
  const ok = n === 0;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[11px] ${ok ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-400" : "border-red-500/50 text-red-700 dark:text-red-400"}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-red-500"}`} />
      {ok ? "no open findings" : `${n} open finding${n === 1 ? "" : "s"}`}
    </span>
  );
}

function VersionBlock({ v, now, latest }: { v: Version; now: number; latest: boolean }) {
  const b = v.bounty;
  const closed = b.status === "CLOSED";
  return (
    <div className={`rounded border border-zinc-200 dark:border-zinc-800 ${closed ? "opacity-50" : latest ? "" : "opacity-80"}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-950/60">
        <span className="font-semibold text-zinc-900 dark:text-zinc-50">{v.pr != null ? `PR #${v.pr}` : b.name}</span>
        {latest && <span className="rounded bg-zinc-200/80 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">latest</span>}
        {closed && (
          <span className="rounded border border-zinc-300 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-zinc-500 dark:border-zinc-700" title="This bounty is closed; no new commits are accepted">
            closed
          </span>
        )}
        {v.patched && (
          <span className="rounded border border-sky-500/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-sky-700 dark:text-sky-400" title="Newer than a build the Bazaar already broke">
            patched
          </span>
        )}
        <a className="font-mono text-zinc-500 hover:underline" href={`/#bounty-${b.id}`}>
          bounty #{b.id} ↗
        </a>
        <StatusChip status={b.status} />
        <span className="font-mono tabular-nums text-zinc-600 dark:text-zinc-400">
          escrow {eth(b.escrow_wei)} ETH
        </span>
        <span className="text-zinc-500">posted {now ? timeAgo(b.created_at, now) : "—"}</span>
        <span className="ml-auto font-mono text-zinc-600 dark:text-zinc-400">
          {v.findings} finding{v.findings === 1 ? "" : "s"}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className={th}>#</th>
              <th className={th}>Invariant</th>
              <th className={`${th} text-right`}>Reward</th>
              <th className={th}>Slots</th>
              <th className={`${th} text-right`}>PASS</th>
            </tr>
          </thead>
          <tbody>
            {v.invariants.map((inv) => (
              <tr key={inv.index} className="border-t border-zinc-200 dark:border-zinc-800">
                <td className={`${td} font-mono text-zinc-500`}>{inv.index}</td>
                <td className={td}>
                  <span className="text-zinc-800 dark:text-zinc-200">{inv.label}</span>
                </td>
                <td className={`${td} text-right font-mono tabular-nums`}>{eth(inv.reward)}</td>
                <td className={td}>
                  <Bar value={inv.slotsUsed} max={inv.slots} tone={inv.slotsUsed > 0 ? "emerald" : "zinc"} />
                </td>
                <td className={`${td} text-right font-mono tabular-nums ${inv.passes > 0 ? "text-red-600 dark:text-red-400" : "text-zinc-500"}`}>{inv.passes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FamilyCard({ family, now }: { family: Family; now: number }) {
  return (
    <article className="flex flex-col gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">{family.name}</h2>
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {family.versions.length} version{family.versions.length === 1 ? "" : "s"}
          </span>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{blurbFor(family.name)}</p>
        {family.tools.length > 0 && (
          <p className="flex flex-wrap items-center gap-1 text-xs text-zinc-500">
            <span className="mr-1">tools:</span>
            {family.tools.map((t) => (
              <code key={t} className="rounded bg-zinc-200/70 px-1 font-mono text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                {t}
              </code>
            ))}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>Regression status:</span>
          <Regression n={family.openFindings} />
        </div>
      </header>
      <div className="flex flex-col gap-2">
        {family.versions.map((v) => (
          <VersionBlock key={v.bounty.id} v={v} now={now} latest={v === family.latest} />
        ))}
      </div>
    </article>
  );
}
