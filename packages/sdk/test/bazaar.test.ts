import { describe, expect, test } from "bun:test";
import { parseEther } from "viem";
import { buildCommitment, buildTranscript, findingsMessage, totalValueWei } from "../src/bazaar.ts";
import { commitment, contentHash } from "../src/hash.ts";

const MH = `0x${"ab".repeat(32)}` as const;

describe("totalValueWei", () => {
  test("sums reward × slots", () => {
    expect(totalValueWei(["0.02", "0.02"], [1, 1])).toBe(parseEther("0.04"));
    expect(totalValueWei(["0.02", "0.005"], [3, 2])).toBe(parseEther("0.06") + parseEther("0.01"));
    expect(totalValueWei(["0.0002"], [1])).toBe(200_000_000_000_000n);
  });
  test("rejects length mismatch, empty and bad slots", () => {
    expect(() => totalValueWei(["0.02"], [1, 1])).toThrow();
    expect(() => totalValueWei([], [])).toThrow();
    expect(() => totalValueWei(["0.02"], [0])).toThrow();
    expect(() => totalValueWei(["0.02"], [1.5])).toThrow();
  });
});

describe("buildTranscript / buildCommitment", () => {
  test("transcript shape is v1 with copied turns", () => {
    const turns = ["hi", "cancel now"];
    const t = buildTranscript(MH, 0, turns);
    expect(t).toEqual({ version: 1, manifestHash: MH, invariant: 0, turns });
    expect(t.turns).not.toBe(turns);
  });
  test("commitment matches hash.ts primitives and is salt-sensitive", () => {
    const t = buildTranscript(MH, 1, ["x"]);
    const salt = `0x${"11".repeat(32)}` as const;
    const c = buildCommitment(t, salt);
    expect(c.content).toBe(contentHash(t));
    expect(c.commitment).toBe(commitment(contentHash(t), salt));
    expect(buildCommitment(t).salt).toMatch(/^0x[0-9a-f]{64}$/);
    expect(buildCommitment(t).commitment).not.toBe(c.commitment);
  });
});

describe("findingsMessage", () => {
  test("uses the minute bucket", () => {
    expect(findingsMessage(7, 123)).toBe("bazaar:findings:7:123");
    expect(findingsMessage(7n)).toBe(`bazaar:findings:7:${Math.floor(Date.now() / 60000)}`);
  });
});
