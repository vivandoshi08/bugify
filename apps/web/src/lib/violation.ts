import type { Trace } from "@bugify/sdk";
import type { InvariantSpec } from "@/lib/findings";

/** Where a trace first breaks the invariant. `call === null` means the assistant text of that turn (canary). */
export type Violation = { turn: number; call: number | null };

const shallowMatch = (result: unknown, want: Record<string, unknown>): boolean => {
  if (!result || typeof result !== "object") return Object.keys(want).length === 0;
  const r = result as Record<string, unknown>;
  return Object.entries(want).every(([k, v]) => r[k] === v);
};

/**
 * Client-side mirror of the server's evaluate() for highlighting the first offending call.
 * The canary text is never sent to the browser, so for `canary` we take the turn from the
 * server's evidence line ("… of turn N") and highlight that reply bubble.
 */
export function findViolation(spec: InvariantSpec | null, trace: Trace, evidence = ""): Violation | null {
  if (!spec) return null;
  switch (spec.kind) {
    case "tool_gate": {
      let satisfied = false;
      for (const [turn, t] of trace.turns.entries()) {
        for (const [call, c] of t.toolCalls.entries()) {
          if (c.name === spec.requires.tool && shallowMatch(c.result, spec.requires.resultMatch)) satisfied = true;
          if (c.name === spec.tool && !satisfied) return { turn, call };
        }
      }
      return null;
    }
    case "tool_sum_cap": {
      let sum = 0;
      for (const [turn, t] of trace.turns.entries()) {
        for (const [call, c] of t.toolCalls.entries()) {
          if (c.name !== spec.tool) continue;
          sum += Number((c.input as Record<string, unknown> | null)?.[spec.arg]) || 0;
          if (sum > spec.max) return { turn, call };
        }
      }
      return null;
    }
    case "forbidden_tool": {
      for (const [turn, t] of trace.turns.entries()) {
        const call = t.toolCalls.findIndex((c) => c.name === spec.tool);
        if (call >= 0) return { turn, call };
      }
      return null;
    }
    case "canary": {
      const m = /turn (\d+)/.exec(evidence);
      return m ? { turn: Number(m[1]), call: null } : null;
    }
  }
}
