import { explorerTx } from "@bugify/sdk";
import { eth, shortHash, timeAgo } from "@/lib/format";
import type { EventRow } from "@/lib/queries";

function tone(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("fail") || n.includes("slash") || n.includes("void")) return "border-red-500/50 text-red-700 dark:text-red-400";
  if (n.includes("final") || n.includes("settle") || n.includes("paid") || n.includes("pass")) return "border-emerald-500/50 text-emerald-700 dark:text-emerald-400";
  if (n.includes("dispute")) return "border-amber-500/50 text-amber-700 dark:text-amber-400";
  if (n.includes("attest")) return "border-violet-500/50 text-violet-700 dark:text-violet-400";
  if (n.includes("bounty")) return "border-sky-500/50 text-sky-700 dark:text-sky-400";
  return "border-zinc-400/60 text-zinc-600 dark:text-zinc-400";
}

const ID_RE = /(^id$|id$)/i;
const AMT_RE = /(amount|reward|bond|escrow|paid|wei|value)/i;

/** Pull "#ids" and one amount out of the jsonb args. Keys are whatever the indexer emitted. */
function describe(args: Record<string, unknown> | null): { ids: string[]; amount: string | null } {
  const ids: string[] = [];
  let amount: string | null = null;
  if (!args) return { ids, amount };
  for (const [k, v] of Object.entries(args)) {
    if (ID_RE.test(k) && (typeof v === "number" || typeof v === "string")) {
      ids.push(`${k.replace(/_?id$/i, "") || "id"} #${v}`);
    } else if (!amount && AMT_RE.test(k) && (typeof v === "string" || typeof v === "number") && /^\d+$/.test(String(v))) {
      amount = `${eth(String(v))} ETH`;
    }
  }
  return { ids, amount };
}

export function EventTicker({ events, now }: { events: EventRow[]; now: number }) {
  return (
    <div className="flex flex-col">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Events</h2>
      {events.length === 0 ? (
        <p className="text-xs text-zinc-500">No events indexed yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-200 text-xs dark:divide-zinc-800">
          {events.map((e) => {
            const { ids, amount } = describe(e.args);
            return (
              <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5">
                <span className="w-16 shrink-0 font-mono tabular-nums text-zinc-400">{now ? timeAgo(e.created_at, now) : "—"}</span>
                <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none ${tone(e.name)}`}>{e.name}</span>
                {ids.map((id) => (
                  <span key={id} className="font-mono text-zinc-600 dark:text-zinc-400">{id}</span>
                ))}
                {amount && <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">{amount}</span>}
                {e.tx_hash && (
                  <a className="ml-auto font-mono text-zinc-400 hover:underline" href={explorerTx(e.tx_hash)} target="_blank" rel="noreferrer">
                    {shortHash(e.tx_hash)} ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
