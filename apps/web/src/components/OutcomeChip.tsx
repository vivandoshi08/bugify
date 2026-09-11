import type { BountyStatus, Outcome } from "@bugify/sdk";

const OUTCOME_CLS: Record<Outcome, string> = {
  NONE: "border border-zinc-400 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400",
  PASS: "bg-emerald-600 text-white border border-emerald-600",
  PASS_NO_SLOT: "border border-emerald-600 text-emerald-700 dark:text-emerald-400",
  FAIL: "bg-red-600 text-white border border-red-600",
  VOID: "border border-dashed border-amber-500 text-amber-700 dark:text-amber-400",
  RECLAIMED: "border border-sky-500 text-sky-700 dark:text-sky-400",
};

export function OutcomeChip({ outcome }: { outcome: Outcome }) {
  const cls = OUTCOME_CLS[outcome] ?? OUTCOME_CLS.NONE;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-[11px] leading-none tracking-wide ${cls}`}>
      {outcome}
    </span>
  );
}

const STATUS_DOT: Record<BountyStatus, string> = {
  OPEN: "bg-emerald-500",
  VOIDED: "bg-amber-500",
  CLOSED: "bg-zinc-400 dark:bg-zinc-600",
};

export function StatusChip({ status }: { status: BountyStatus }) {
  const dot = STATUS_DOT[status] ?? STATUS_DOT.CLOSED;
  const text = status === "CLOSED" ? "text-zinc-400 dark:text-zinc-500" : "text-zinc-700 dark:text-zinc-300";
  return (
    <span className={`inline-flex items-center gap-1.5 font-mono text-[11px] tracking-wide ${text}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {status}
    </span>
  );
}

/** Small horizontal progress bar (used for slots and hits/k). */
export function Bar({ value, max, tone = "emerald" }: { value: number; max: number; tone?: "emerald" | "zinc" }) {
  const w = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const fill = tone === "emerald" ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-500";
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-16 overflow-hidden rounded bg-zinc-200 dark:bg-zinc-800">
        <span className={`block h-full ${fill}`} style={{ width: `${w}%` }} />
      </span>
      <span className="font-mono text-xs tabular-nums text-zinc-600 dark:text-zinc-400">
        {value}/{max}
      </span>
    </span>
  );
}
