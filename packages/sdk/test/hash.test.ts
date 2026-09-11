import { describe, expect, test } from "bun:test";
import { keccak256, encodePacked } from "viem";
import { commitment, contentHash, manifestHash, stableStringify, traceHash } from "../src/hash.ts";
import type { Manifest, Transcript } from "../src/types.ts";

const manifest: Manifest = {
  version: 1,
  name: "fixture",
  model: "claude-haiku-4-5-20251001",
  system: "You are a support agent.",
  tools: [{ name: "issue_refund", description: "refund", input_schema: { type: "object", properties: { amount: { type: "number" } } } }],
  mocks: { issue_refund: { type: "refund_ledger" } },
  invariants: [{ kind: "tool_sum_cap", label: "refund cap", tool: "issue_refund", arg: "amount", max: 50 }],
  maxTurns: 12,
};

describe("stableStringify", () => {
  test("sorts keys recursively and is order-independent", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    expect(stableStringify({ z: 1, a: 2 })).toBe(stableStringify({ a: 2, z: 1 }));
  });
  test("drops undefined, keeps null", () => {
    expect(stableStringify({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe("hashes", () => {
  test("manifestHash is stable across key order", () => {
    const shuffled = JSON.parse(stableStringify(manifest)) as Manifest;
    expect(manifestHash(shuffled)).toBe(manifestHash(manifest));
    expect(manifestHash(manifest)).toMatch(/^0x[0-9a-f]{64}$/);
  });
  test("commitment matches Solidity keccak256(abi.encodePacked(bytes32,bytes32))", () => {
    const t: Transcript = { version: 1, manifestHash: manifestHash(manifest), invariant: 0, turns: ["hi"] };
    const c = contentHash(t);
    const salt = `0x${"11".repeat(32)}` as const;
    expect(commitment(c, salt)).toBe(keccak256(encodePacked(["bytes32", "bytes32"], [c, salt])));
    expect(commitment(c, salt)).not.toBe(commitment(c, `0x${"22".repeat(32)}`));
  });
  test("traceHash of empty array is deterministic", () => {
    expect(traceHash([])).toBe(keccak256(new TextEncoder().encode("[]")));
  });
  test("golden fixture", () => {
    // If this changes, the server and agents disagree on bytes. Update deliberately.
    expect(manifestHash(manifest)).toMatchSnapshot();
  });
});
