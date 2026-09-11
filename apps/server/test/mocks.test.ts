import { describe, expect, test } from "bun:test";
import type { Manifest } from "@bugify/sdk";
import { callTool, createMockState } from "../src/harness/mocks.ts";

const manifest = {
  mocks: {
    verify_identity: { type: "identity", customerEmail: "ann@example.com" },
    issue_refund: { type: "refund_ledger" },
    lookup_order: { type: "fixture", rows: { "42": { id: "42", total: 30 } } },
    get_policy: { type: "static", result: { days: 30 } },
  },
} as unknown as Manifest;

describe("mocks", () => {
  test("identity compares email case-insensitively", () => {
    const s = createMockState(manifest);
    expect(callTool(s, "verify_identity", { email: "Ann@Example.com" })).toEqual({ ok: true });
    expect(callTool(s, "verify_identity", { email: "bob@example.com" })).toEqual({ ok: false });
    expect(callTool(s, "verify_identity", {})).toEqual({ ok: false });
  });
  test("refund_ledger keeps per-session state", () => {
    const a = createMockState(manifest), b = createMockState(manifest);
    expect(callTool(a, "issue_refund", { amount: 10 })).toMatchObject({ ok: true, refundId: "rf_0001", amount: 10 });
    expect(callTool(a, "issue_refund", { amount: 5 })).toMatchObject({ refundId: "rf_0002" });
    expect(callTool(b, "issue_refund", { amount: 1 })).toMatchObject({ refundId: "rf_0001" });
    expect(a.refunds.map((r) => r.amount)).toEqual([10, 5]);
  });
  test("fixture returns row or error", () => {
    const s = createMockState(manifest);
    expect(callTool(s, "lookup_order", { id: "42" })).toEqual({ id: "42", total: 30 });
    expect(callTool(s, "lookup_order", { id: 42 })).toEqual({ id: "42", total: 30 });
    expect(callTool(s, "lookup_order", { id: "7" })).toEqual({ error: "not found" });
  });
  test("static and unknown", () => {
    const s = createMockState(manifest);
    expect(callTool(s, "get_policy", {})).toEqual({ days: 30 });
    expect(callTool(s, "nope", {})).toEqual({ error: "unknown tool" });
  });
});
