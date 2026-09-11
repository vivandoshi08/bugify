import type Anthropic from "@anthropic-ai/sdk";
import type { Manifest, ToolCall, Trace } from "@bugify/sdk";
import { callTool, createMockState, type MockState } from "./mocks.ts";
import { violations } from "./evaluate.ts";

/** The slice of the Anthropic client the harness needs; tests inject a fake. */
export type MessagesClient = { messages: { create: (p: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message> } };
export type Deps = { anthropic: MessagesClient; log?: (line: string) => void };

export const MAX_CALLS_PER_TURN = 6;

/** One user turn: loop the model until it stops calling tools (or the call cap hits). Mutates messages/mockState. */
export async function runTurn(
  manifest: Manifest, messages: Anthropic.MessageParam[], mockState: MockState, text: string, deps: Deps,
): Promise<Trace["turns"][number]> {
  messages.push({ role: "user", content: text });
  const toolCalls: ToolCall[] = [];
  const assistantText: string[] = [];
  for (let call = 0; call < MAX_CALLS_PER_TURN; call++) {
    const res = await deps.anthropic.messages.create({
      model: manifest.model,
      system: manifest.system,
      tools: manifest.tools as Anthropic.Tool[],
      messages,
      max_tokens: 1024,
      temperature: 0,
    });
    messages.push({ role: "assistant", content: res.content });
    for (const block of res.content) if (block.type === "text") assistantText.push(block.text);
    if (res.stop_reason !== "tool_use") break;
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const result = callTool(mockState, block.name, block.input);
      toolCalls.push({ name: block.name, input: block.input, result });
      deps.log?.(`tool ${block.name}(${JSON.stringify(block.input)}) → ${JSON.stringify(result)}`);
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
    }
    if (results.length === 0) break; // stop_reason said tool_use but no blocks: don't spin
    messages.push({ role: "user", content: results });
  }
  return { user: text, assistant: assistantText.join("\n"), toolCalls };
}

/** Replay a whole transcript against the target (§3). */
export async function runSession(manifest: Manifest, userTurns: string[], deps: Deps): Promise<Trace> {
  const messages: Anthropic.MessageParam[] = [];
  const mockState = createMockState(manifest);
  const trace: Trace = { model: manifest.model, turns: [] };
  for (const text of userTurns.slice(0, manifest.maxTurns)) {
    trace.turns.push(await runTurn(manifest, messages, mockState, text, deps));
  }
  return trace;
}

// ---- interactive practice sessions (in-memory, 30 min TTL) ----
export type Session = { manifest: Manifest; messages: Anthropic.MessageParam[]; mockState: MockState; trace: Trace; createdAt: number };
export const SESSION_TTL_MS = 30 * 60 * 1000;

export function createSessionRunner(deps: Deps, now: () => number = Date.now) {
  const sessions = new Map<string, Session>();
  const sweep = () => {
    for (const [id, s] of sessions) if (now() - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  };
  return {
    sessions,
    open(manifest: Manifest): string {
      sweep();
      const id = crypto.randomUUID();
      sessions.set(id, { manifest, messages: [], mockState: createMockState(manifest), trace: { model: manifest.model, turns: [] }, createdAt: now() });
      return id;
    },
    async turn(sessionId: string, text: string) {
      sweep();
      const s = sessions.get(sessionId);
      if (!s) throw new SessionError("session not found or expired", 404);
      if (s.trace.turns.length >= s.manifest.maxTurns) throw new SessionError("maxTurns reached for this session", 409);
      const turn = await runTurn(s.manifest, s.messages, s.mockState, text, deps);
      s.trace.turns.push(turn);
      return { assistant: turn.assistant, toolCalls: turn.toolCalls, violations: violations(s.manifest.invariants, s.trace) };
    },
  };
}

export class SessionError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
