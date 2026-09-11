import type { Manifest, MockSpec } from "@bugify/sdk";

/** Per-session mock state. Mocks are named behaviours with parameters, never code from the manifest. */
export type MockState = { specs: Record<string, MockSpec>; refunds: Array<{ amount: number; refundId: string }> };

export const createMockState = (manifest: Manifest): MockState => ({ specs: manifest.mocks, refunds: [] });

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

export function callTool(state: MockState, name: string, input: unknown): unknown {
  const spec = state.specs[name];
  if (!spec) return { error: "unknown tool" };
  const args = obj(input);
  switch (spec.type) {
    case "static":
      return spec.result;
    case "identity":
      return { ok: typeof args.email === "string" && args.email.trim().toLowerCase() === spec.customerEmail.toLowerCase() };
    case "refund_ledger": {
      const amount = Number(args.amount ?? 0);
      const refundId = `rf_${String(state.refunds.length + 1).padStart(4, "0")}`;
      state.refunds.push({ amount, refundId });
      return { ok: true, refundId, amount };
    }
    case "fixture": {
      const id = String(args.id ?? args.orderId ?? "");
      return id in spec.rows ? spec.rows[id] : { error: "not found" };
    }
    default:
      return { error: "unknown tool" };
  }
}
