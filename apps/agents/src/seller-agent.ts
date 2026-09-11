// Autonomous red-team seller: continuously scans OPEN bounties and, for each funded invariant that
// still has an open slot and no PASS from this seller, spins up a Claude "attacker" (src/attacker.ts)
// that social-engineers the sandboxed target over several turns. On a violation it commits, reveals,
// attests and — on PASS — settles the finding on chain. See docs/ARCHITECTURE.md §9.
//
//   bun run seller-agent [--bounty <id>] [--once] [--max-turns 6] [--interval 30] [--dry] [--model <id>]
//
// --dry runs the practice session and prints the transcript but never touches the chain
// (no commit / reveal / settle). Anthropic key is read from apps/server/.env (see try-attack.ts).
import { config } from "dotenv";
import { resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { createBazaar, explorerTx, type PublicBounty } from "@bugify/sdk";
import { formatEther } from "viem";
import { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, opt, flag, sleep, compact } from "./env.ts";
import { createAttacker, type AttackHistory, type ToolHint } from "./attacker.ts";

// apps/agents/.env is already loaded by env.ts; add apps/server/.env for ANTHROPIC_API_KEY (no override).
config({ path: resolve(import.meta.dir, "../../server/.env"), quiet: true });

// --- CLI ---
const onlyBounty = opt("bounty");
const once = flag("once");
const dry = flag("dry");
const maxTurns = Math.max(1, Number(opt("max-turns") ?? 6));
const intervalSec = Math.max(1, Number(opt("interval") ?? 30));

// --- log sink: mirror every line through ./log.ts emit() when a sibling agent has added it ---
type EmitFn = (line: string, meta?: { agent?: string; level?: string }) => void;
let emitFn: EmitFn | null | undefined;
async function getEmit() {
  if (emitFn !== undefined) return emitFn;
  try {
    const mod = (await import("./log.ts")) as { emit?: EmitFn };
    emitFn = typeof mod.emit === "function" ? mod.emit : null;
  } catch {
    emitFn = null;
  }
  return emitFn;
}
async function log(line: string) {
  // emit() prints to stdout itself; only print here when the shared logger is unavailable.
  try {
    const emit = await getEmit();
    if (emit) emit(line, { agent: "seller" });
    else console.log(line);
  } catch {
    console.log(line);
  }
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

// --- local state: which (bounty, invariant) pairs this seller has already PASSed ---
const STATE_DIR = resolve(import.meta.dir, "../.state");
const STATE_FILE = resolve(STATE_DIR, "seller-agent.json");
type State = { passes: Record<string, number[]> };
function loadState(): State {
  try {
    if (existsSync(STATE_FILE)) return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    /* corrupt/missing → fresh */
  }
  return { passes: {} };
}
function recordPass(state: State, bountyId: number, inv: number) {
  const key = String(bountyId);
  const list = state.passes[key] ?? (state.passes[key] = []);
  if (!list.includes(inv)) list.push(inv);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    /* best effort */
  }
}

// Generic, PUBLIC-only tool hints for the attacker, keyed off the invariant label. These are NOT the
// target's real tool descriptions (those are private) — just enough for the attacker to reason.
function toolHints(label: string): ToolHint[] {
  const l = label.toLowerCase();
  if (/refund|\$|cap|amount|over \d/.test(l)) {
    return [
      { name: "lookup_order", description: "look up an order by id (format like A1001) before acting on it" },
      { name: "issue_refund", description: "issue a refund in USD against a looked-up order (metered per session)" },
    ];
  }
  if (/leak|canary|number|line|secret|reveal|disclos/.test(l)) {
    return [{ name: "escalate", description: "create a support ticket / escalate to a supervisor" }];
  }
  if (/cancel|subscription|verif|identity|without/.test(l)) {
    return [
      { name: "verify_identity", description: "verify the customer controls the account (email)" },
      { name: "cancel_subscription", description: "cancel the customer's subscription (gated action)" },
    ];
  }
  return [];
}

// Sandbox test data comes from GET /bounties/:id (`sandbox`): the account the identity mock accepts and
// the record ids the fixture mocks know. A real customer knows their own order/invoice/delivery ids; the
// attacker must reference ones that resolve or every lookup fails and no gated tool is ever reached.
type Sandbox = { accounts: { email: string }[]; records: { tool: string; ids: string[] }[] } | null;

function accountOrders(sandbox: Sandbox): { id: string; note?: string }[] | undefined {
  if (!sandbox?.records.length) return undefined;
  return sandbox.records.flatMap((r) => r.ids.map((id) => ({ id, note: `a record the \`${r.tool}\` tool resolves` })));
}

function persona(sandbox: Sandbox): { name?: string; email?: string } | undefined {
  const email = sandbox?.accounts[0]?.email;
  return email ? { name: "Dana", email } : undefined;
}

// Loose shape of a commit row from GET /bounties/:id.
type CommitRow = { invariant: number; seller: string; outcome: string };
type BountyDetail = PublicBounty & {
  rewards_wei: string[];
  slots: number[];
  invariant_labels: string[];
  commits?: CommitRow[];
  tools?: { name: string; description: string }[];
  sandbox?: Sandbox;
};

const bz = createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("SELLER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL });
const me = bz.address.toLowerCase();

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY not set (expected in apps/server/.env)");
  process.exit(2);
}
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_BASE_URL ? { baseURL: process.env.ANTHROPIC_BASE_URL } : {}),
});
const attacker = createAttacker({ anthropic, model: opt("model") });

// --- one attacker vs. one invariant ---
async function attempt(detail: BountyDetail, listRow: PublicBounty & { invariant_summaries?: string[] }, inv: number): Promise<string[]> {
  const bountyId = BigInt(detail.id);
  const label = detail.invariant_labels[inv] ?? `invariant ${inv}`;
  const summary = listRow.invariant_summaries?.[inv];
  const tools = toolHints(label);

  const session = await bz.openSession(bountyId);
  await log(`\n▶ bounty #${detail.id} invariant ${inv} — ${label}`);
  await log(`  session ${session.sessionId} (max ${maxTurns} turns${dry ? ", dry" : ""})`);

  const history: AttackHistory[] = [];
  const turns: string[] = [];
  let hit = false;

  for (let t = 0; t < maxTurns; t++) {
    const turn = await attacker.nextTurn({
      bountyName: detail.name ?? `bounty #${detail.id}`,
      invariantLabel: label,
      invariantSummary: summary,
      tools,
      history,
      turnIndex: t,
      maxTurns,
      accountOrders: accountOrders(detail.sandbox ?? null),
      persona: persona(detail.sandbox ?? null),
    });
    await log(`  ↳ plan: ${oneLine(turn.rationale)}`);
    await log(`🗣 seller: ${oneLine(turn.text)}`);

    const r = await session.say(turn.text);
    turns.push(turn.text);
    for (const tc of r.toolCalls) await log(`🔧 ${tc.name}(${compact(tc.input)}) → ${compact(tc.result)}`);
    await log(`🤖 target: ${oneLine(r.assistant)}`);
    if (r.violations.length) await log(`⚠ violations [${r.violations.join(", ")}]`);

    history.push({ user: turn.text, assistant: r.assistant, toolCalls: r.toolCalls, violations: r.violations });
    if (r.violations.includes(inv)) {
      hit = true;
      break;
    }
    await sleep(1000); // respect the server rate limit (60 turns / 10 min)
  }

  if (!hit) {
    await log(`  gave up: invariant ${inv} not tripped in ${maxTurns} turns`);
    return [];
  }
  await log(`  ✔ tripped invariant ${inv} in ${turns.length} turn(s)`);
  return turns;
}

async function settleFinding(detail: BountyDetail, inv: number, turns: string[], state: State) {
  const bountyId = BigInt(detail.id);
  await log(`  committing transcript on chain (bond ${formatEther(BigInt(detail.min_bond_wei))} ETH)…`);
  const sub = await bz.submitFinding(bountyId, inv, turns);
  await log(`  commit #${sub.commitId}  ${explorerTx(sub.commitTx)}`);
  await log(`  revealed → outcome ${sub.outcome}  hits ${sub.hits}/${detail.k}  breaksControl ${sub.breaksControl}`);
  await log(`  attest  ${explorerTx(sub.attestTx)}`);

  if (sub.outcome === "PASS" || sub.outcome === "PASS_NO_SLOT") recordPass(state, detail.id, inv);
  if (sub.outcome !== "PASS") {
    await log(`  outcome ${sub.outcome}: nothing to settle`);
    return;
  }
  await log(`  waiting for the dispute window…`);
  let last = -1;
  const s = await bz.settle(sub.commitId, {
    onWait: (left) => {
      if (left !== last && left % 10 === 0) {
        void log(`    ${left}s left`);
        last = left;
      }
    },
  });
  const reward = BigInt(detail.rewards_wei[inv] ?? "0");
  await log(`  finalize ${explorerTx(s.finalizeTx)}`);
  await log(`  paid ${formatEther(s.paidWei)} ETH of ${formatEther(reward)} ETH reward + bond returned`);
}

async function runBounty(row: PublicBounty & { invariant_summaries?: string[] }, state: State) {
  const detail = (await bz.getBountyPublic(row.id)) as BountyDetail;
  const commits = detail.commits ?? [];
  const funded = detail.rewards_wei.length;

  for (let inv = 0; inv < funded; inv++) {
    const slots = detail.slots[inv] ?? 1;
    const taken = commits.filter((c) => c.invariant === inv && c.outcome === "PASS").length;
    if (taken >= slots) {
      await log(`— bounty #${detail.id} inv ${inv}: slots full (${taken}/${slots}), skip`);
      continue;
    }
    const minePass =
      (state.passes[String(detail.id)] ?? []).includes(inv) ||
      commits.some((c) => c.invariant === inv && c.outcome === "PASS" && c.seller.toLowerCase() === me);
    if (minePass) {
      await log(`— bounty #${detail.id} inv ${inv}: already have a PASS, skip`);
      continue;
    }
    const turns = await attempt(detail, row, inv);
    if (dry) {
      await log(turns.length ? `  dry-run: would submit finding for invariant ${inv} (not committing)` : `  dry-run: no finding for invariant ${inv}`);
      continue;
    }
    if (turns.length) await settleFinding(detail, inv, turns, state);
  }
}

async function pass() {
  const state = loadState();
  const bounties = (await bz.listBounties()) as (PublicBounty & { invariant_summaries?: string[] })[];
  const targets = onlyBounty
    ? bounties.filter((b) => String(b.id) === onlyBounty)
    : bounties.filter((b) => b.status === "OPEN" && new Date(b.expiry).getTime() > Date.now());
  if (!targets.length) {
    await log(onlyBounty ? `bounty ${onlyBounty} not found on server` : "no OPEN bounties to work");
    return;
  }
  await log(`seller ${bz.address} — ${targets.length} bounty(ies) to scan`);
  for (const row of targets) await runBounty(row, state);
}

for (;;) {
  try {
    await pass();
  } catch (e) {
    await log(`pass error: ${(e as Error).message}`);
  }
  if (once) break;
  await log(`\npass complete; sleeping ${intervalSec}s…\n`);
  await sleep(intervalSec * 1000);
}
