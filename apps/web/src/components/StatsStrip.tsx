import { BAZAAR_ADDRESS, SINGLE_VERIFIER_ADDRESS, explorerAddress } from "@bugify/sdk";
import { eth, pct, shortAddr, sumWei, timeAgo } from "@/lib/format";
import { GLOSSARY } from "@/lib/glossary";
import type { BountyRow, CommitRow, EventRow } from "@/lib/queries";
import { Tip } from "@/components/Tip";

type Props = { bounties: BountyRow[]; commits: CommitRow[]; events: EventRow[]; now: number };

function Stat({ label, value, mono = true, tip }: { label: string; value: string; mono?: boolean; tip?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wider text-zinc-500">{tip ? <Tip text={tip}>{label}</Tip> : label}</span>
      <span className={`${mono ? "font-mono" : ""} text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-50`}>
        {value}
      </span>
    </div>
  );
}

export function StatsStrip({ bounties, commits, events, now }: Props) {
  const escrow = sumWei(bounties.filter((b) => b.status === "OPEN" || b.status === "VOIDED").map((b) => b.escrow_wei));
  const paid = sumWei(commits.filter((c) => c.finalized && c.outcome === "PASS").map((c) => c.paid_wei));
  const slashed = sumWei(commits.filter((c) => c.finalized && c.outcome === "FAIL").map((c) => c.bond_wei));
  const open = bounties.filter((b) => b.status === "OPEN").length;
  const attested = commits.filter((c) => c.outcome !== "NONE").length;
  const passed = commits.filter((c) => c.outcome === "PASS" || c.outcome === "PASS_NO_SLOT").length;

  const block = events.reduce((m, e) => Math.max(m, e.block ?? 0), 0);
  const newest = events.reduce<string | null>((m, e) => (!m || e.created_at > m ? e.created_at : m), null);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Escrow locked" value={`${eth(escrow)} ETH`} tip={GLOSSARY.escrow} />
        <Stat label="Paid to sellers" value={`${eth(paid)} ETH`} />
        <Stat label="Slashed" value={`${eth(slashed)} ETH`} tip={GLOSSARY.slashed} />
        <Stat label="Bounties open / total" value={`${open} / ${bounties.length}`} />
        <Stat label="Commits" value={String(commits.length)} tip={GLOSSARY.commits} />
        <Stat label="PASS rate" value={pct(passed, attested)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
        <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 font-medium text-sky-700 dark:text-sky-300">
          Base Sepolia
        </span>
        <span>
          Bazaar{" "}
          <a className="font-mono text-zinc-800 hover:underline dark:text-zinc-200" href={explorerAddress(BAZAAR_ADDRESS)} target="_blank" rel="noreferrer">
            {shortAddr(BAZAAR_ADDRESS)}
          </a>
        </span>
        <span aria-hidden>·</span>
        <span>
          Verifier{" "}
          <a className="font-mono text-zinc-800 hover:underline dark:text-zinc-200" href={explorerAddress(SINGLE_VERIFIER_ADDRESS)} target="_blank" rel="noreferrer">
            {shortAddr(SINGLE_VERIFIER_ADDRESS)}
          </a>
        </span>
        <span aria-hidden>·</span>
        <span className="font-mono tabular-nums">
          {newest && now ? `synced ${timeAgo(newest, now)}` : "not yet synced"}
          {block ? ` · block ${block}` : ""}
        </span>
      </div>
    </div>
  );
}
