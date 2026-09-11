import type { Outcome, VerificationRecord } from "@bugify/sdk";
import { Tip } from "@/components/Tip";

const REASON_HELP: Record<string, string> = {
  "commitment mismatch":
    "The revealed transcript + salt did not hash to the on-chain commitment, so the verifier attested FAIL without running the agent at all.",
  "reveal timeout": "The seller never revealed within the reveal window; the verifier attested FAIL so the FIFO queue behind it could move on.",
};

const chip = "rounded border border-zinc-300 bg-zinc-100 px-1 font-mono text-[10px] leading-4 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

/** Public, secret-free view of what the verifier did for one commit (tool names + redacted evidence only). */
export function Verification({ record, outcome, k }: { record: VerificationRecord | null; outcome: Outcome; k: number }) {
  if (!record) {
    return (
      <p className="text-xs text-zinc-500">
        {outcome === "NONE" ? "Awaiting reveal — nothing has been replayed yet." : "No public verification record for this commit (attested before records were kept)."}
      </p>
    );
  }
  if ("reason" in record) {
    return (
      <div className="text-xs">
        <p>
          <span className="font-medium text-red-700 dark:text-red-400">FAIL without replay:</span> {record.reason}
        </p>
        {REASON_HELP[record.reason] && <p className="mt-1 text-zinc-500">{REASON_HELP[record.reason]}</p>}
      </div>
    );
  }
  const total = record.k || k;
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="inline-flex items-center gap-2" aria-label={`${record.hits} of ${total} replays hit`}>
          {record.replays.map((r, i) => (
            <span key={i} className="inline-flex items-center gap-1" title={`replay ${i + 1}: ${r.hit ? "hit" : "miss"}`}>
              <span className={`h-2.5 w-2.5 rounded-full ${r.hit ? "bg-emerald-500" : "bg-zinc-300 dark:bg-zinc-600"}`} />
              <span className={r.hit ? "text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}>{r.hit ? "hit" : "miss"}</span>
            </span>
          ))}
        </span>
        <span className="text-zinc-500">
          <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
            {record.hits}/{total}
          </span>{" "}
          replays reproduced the violation
        </span>
        {record.control && (
          <span className="text-zinc-500">
            control (base model):{" "}
            <span className="font-mono tabular-nums text-zinc-800 dark:text-zinc-200">
              {record.control.hits}/{total}
            </span>{" "}
            →{" "}
            {record.breaksControl ? (
              <Tip text="The bare model without the buyer's prompt also breaks this invariant, so it's a base-model bug: paid at the control tier, not the full reward.">
                base-model bug
              </Tip>
            ) : (
              <Tip text="The bare model holds this invariant; only the buyer's feature breaks it. Full reward.">holds — feature-specific</Tip>
            )}
          </span>
        )}
      </div>
      <ol className="flex flex-col gap-1.5">
        {record.replays.map((r, i) => (
          <li key={i} className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <span className="w-16 shrink-0 font-mono tabular-nums text-zinc-500">
              #{i + 1} · {r.turns} turn{r.turns === 1 ? "" : "s"}
            </span>
            <span className="flex flex-wrap gap-1">
              {r.toolCalls.length === 0 ? (
                <span className="text-zinc-400">no tool calls</span>
              ) : (
                r.toolCalls.map((name, j) => (
                  <span key={j} className={chip}>
                    {name}
                  </span>
                ))
              )}
            </span>
            <span className="basis-full text-zinc-500 sm:ml-auto sm:basis-auto sm:text-right">{r.evidence}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
