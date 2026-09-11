import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Manifest } from "@bugify/sdk";
import { MAX_CALLS_PER_TURN, createSessionRunner, runSession, type MessagesClient } from "../src/harness/runSession.ts";

const manifest: Manifest = {
  version: 1, name: "t", model: "fake-model", system: "sys", maxTurns: 3,
  tools: [{ name: "verify_identity", description: "", input_schema: { type: "object" } }, { name: "cancel_subscription", description: "", input_schema: { type: "object" } }],
  mocks: { verify_identity: { type: "identity", customerEmail: "ann@example.com" }, cancel_subscription: { type: "static", result: { done: true } } },
  invariants: [{ kind: "tool_gate", label: "g", tool: "cancel_subscription", requires: { tool: "verify_identity", resultMatch: { ok: true } } }],
};

const msg = (content: Anthropic.ContentBlock[], stop: Anthropic.Message["stop_reason"]): Anthropic.Message =>
  ({ id: "m", type: "message", role: "assistant", model: "fake-model", content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as Anthropic.Message;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as Anthropic.ContentBlock;
const text = (t: string) => ({ type: "text", text: t, citations: null }) as Anthropic.ContentBlock;

/** Fake client returning a scripted sequence and recording every request. */
function fake(script: Anthropic.Message[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = { messages: { create: async (p) => { requests.push(structuredClone(p)); return script[Math.min(requests.length - 1, script.length - 1)]!; } } };
  return { client, requests };
}

describe("runSession", () => {
  test("feeds tool results back and records the trace", async () => {
    const { client, requests } = fake([
      msg([text("checking"), toolUse("t1", "verify_identity", { email: "ann@example.com" })], "tool_use"),
      msg([text("verified, cancelling"), toolUse("t2", "cancel_subscription", { id: 1 })], "tool_use"),
      msg([text("done")], "end_turn"),
    ]);
    const trace = await runSession(manifest, ["cancel my plan"], { anthropic: client });
    expect(requests.length).toBe(3);
    expect(requests[0]!.model).toBe("fake-model");
    expect(requests[0]!.system).toBe("sys");
    expect(requests[0]!.temperature).toBe(0);
    // second request carries assistant tool_use + user tool_result with the mock's output
    const second = requests[1]!.messages;
    expect(second.length).toBe(3);
    expect(second[1]!.role).toBe("assistant");
    const results = second[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(results[0]).toMatchObject({ type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ ok: true }) });
    expect(trace).toEqual({
      model: "fake-model",
      turns: [{
        user: "cancel my plan",
        assistant: "checking\nverified, cancelling\ndone",
        toolCalls: [
          { name: "verify_identity", input: { email: "ann@example.com" }, result: { ok: true } },
          { name: "cancel_subscription", input: { id: 1 }, result: { done: true } },
        ],
      }],
    });
  });

  test("caps model calls per user turn at 6", async () => {
    const { client, requests } = fake([msg([toolUse("x", "cancel_subscription", {})], "tool_use")]);
    const trace = await runSession(manifest, ["loop"], { anthropic: client });
    expect(requests.length).toBe(MAX_CALLS_PER_TURN);
    expect(trace.turns[0]!.toolCalls.length).toBe(6);
  });

  test("respects maxTurns", async () => {
    const { client, requests } = fake([msg([text("hi")], "end_turn")]);
    const trace = await runSession(manifest, ["a", "b", "c", "d", "e"], { anthropic: client });
    expect(trace.turns.length).toBe(3);
    expect(requests.length).toBe(3);
    expect(requests[2]!.messages.length).toBe(5); // u,a,u,a,u
  });

  test("unknown tool gets an error result and the loop continues", async () => {
    const { client } = fake([msg([toolUse("z", "nope", {})], "tool_use"), msg([text("ok")], "end_turn")]);
    const trace = await runSession(manifest, ["x"], { anthropic: client });
    expect(trace.turns[0]!.toolCalls[0]!.result).toEqual({ error: "unknown tool" });
  });
});

describe("createSessionRunner", () => {
  test("open/turn returns violations on the running trace; expires after TTL", async () => {
    const { client } = fake([msg([toolUse("t2", "cancel_subscription", { id: 1 })], "tool_use"), msg([text("cancelled")], "end_turn")]);
    let now = 1_000_000;
    const runner = createSessionRunner({ anthropic: client }, () => now);
    const sid = runner.open(manifest);
    const r = await runner.turn(sid, "cancel now");
    expect(r.assistant).toBe("cancelled");
    expect(r.toolCalls.length).toBe(1);
    expect(r.violations).toEqual([0]);
    now += 31 * 60 * 1000;
    await expect(runner.turn(sid, "again")).rejects.toThrow(/expired/);
  });
});
