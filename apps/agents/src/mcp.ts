// MCP wrapper over the buyer-side SDK client (docs/ARCHITECTURE.md §8 "MCP wrapper").
// Register with Claude Code:  claude mcp add bazaar -- bun run /abs/path/to/apps/agents/src/mcp.ts
//
// stdout IS the MCP transport. Every log in this file goes to stderr; anything that reaches stdout
// corrupts the JSON-RPC stream and Claude Code drops the server.
import { config as loadDotenv } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther } from "viem";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Bazaar, Finding, Manifest } from "@bugify/sdk";

const log = (...args: unknown[]) => console.error("[bazaar-mcp]", ...args);

// --- prelude: must run before env.ts (dotenv/config) and @bugify/sdk (DEMO reads BUGIFY_DEMO_SCALE) ---
// dotenv 17 prints an "injected env" banner with console.log; silence it. Route any stray console.log to stderr.
process.env.DOTENV_CONFIG_QUIET ??= "true";
console.log = (...args: unknown[]) => console.error(...args);
// Claude Code launches us from an arbitrary cwd: load apps/agents/.env explicitly. dotenv never overrides
// variables already set, so real environment variables still win; env.ts then also loads ./.env from cwd.
loadDotenv({ path: resolve(import.meta.dir, "../.env"), quiet: true });

// Static imports are hoisted, so the load order above is only guaranteed with dynamic imports here.
const { RPC_URL, SERVER_URL, BAZAAR_ADDRESS, requireKey, compact } = await import("./env.ts");
const { createBazaar, explorerAddress, explorerTx, DEMO, totalValueWei } = await import("@bugify/sdk");

const agentsDir = resolve(import.meta.dir, "..");
const DEFAULT_MANIFEST = "manifests/northwind.json";

// Built lazily so tools/list works (and a clear error surfaces per call) even when a key is missing.
// Buyer tools use BUYER_KEY; seller tools use SELLER_KEY. A single-wallet joiner can set just one and it
// falls back to the other, so one key can play both sides.
let bz: Bazaar | undefined;
let sz: Bazaar | undefined;
const key = (primary: "BUYER_KEY" | "SELLER_KEY", fallback: "BUYER_KEY" | "SELLER_KEY") =>
  process.env[primary] ? requireKey(primary) : requireKey(fallback);
const client = () =>
  (bz ??= createBazaar({ rpcUrl: RPC_URL, privateKey: key("BUYER_KEY", "SELLER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL }));
const seller = () =>
  (sz ??= createBazaar({ rpcUrl: RPC_URL, privateKey: key("SELLER_KEY", "BUYER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL }));

function readManifest(path: string): Manifest {
  const file = resolve(agentsDir, path); // absolute paths pass through resolve unchanged
  const m = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  if (!Array.isArray(m.invariants) || m.invariants.length === 0) throw new Error(`${file}: manifest has no invariants`);
  return m;
}

// ---------------------------------------------------------------------------
// Tool plumbing: every handler returns text; every throw becomes an isError result, never a crash.
// ---------------------------------------------------------------------------

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function guarded<A>(name: string, fn: (args: A) => Promise<string>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return { content: [{ type: "text", text: await fn(args) }] };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`${name} failed:`, message);
      return { content: [{ type: "text", text: `${name} failed: ${message}` }], isError: true };
    }
  };
}

const bountyIdSchema = z.number().int().nonnegative().describe("On-chain bounty id (from post_bounty or list_bounties)");

const server = new McpServer({ name: "bazaar", version: "0.1.0" });

server.registerTool(
  "post_bounty",
  {
    title: "Post bounty",
    description:
      "Register a manifest with the verifier and post a bounty on Base Sepolia, escrowing Σ reward × slots from the buyer wallet. " +
      `Defaults: manifest ${DEFAULT_MANIFEST}, one demo reward (${DEMO.rewardEth} ETH) per invariant, 1 slot each, ` +
      `bond ${DEMO.minBondEth} ETH, k=${DEMO.k} replays, expiry ${DEMO.expiryHours} h. Returns bountyId, manifestHash and the tx link.`,
    inputSchema: {
      manifestPath: z.string().optional().describe(`Manifest JSON path, relative to apps/agents (default ${DEFAULT_MANIFEST})`),
      rewardsEth: z.array(z.string()).optional().describe('ETH reward per invariant, decimal strings, e.g. ["0.02","0.02"]; one per invariant'),
      slots: z.array(z.number().int().min(1).max(255)).optional().describe("Paid findings per invariant (default all 1)"),
      expiryHours: z.number().positive().optional().describe(`Hours until expiry (default ${DEMO.expiryHours})`),
      minBondEth: z.string().optional().describe(`Seller bond in ETH (default ${DEMO.minBondEth})`),
      k: z.number().int().min(1).optional().describe(`Verifier replays per finding (default ${DEMO.k})`),
      controlManifestPath: z.string().optional().describe("Optional control manifest path (base-model replay); relative to apps/agents"),
      controlTierBps: z.number().int().min(0).max(10_000).optional().describe("Payout bps for findings that also break the control"),
    },
  },
  guarded("post_bounty", async (a) => {
    const manifest = readManifest(a.manifestPath ?? DEFAULT_MANIFEST);
    const n = manifest.invariants.length;
    const rewardsEth = a.rewardsEth ?? manifest.invariants.map(() => DEMO.rewardEth);
    const slots = a.slots ?? rewardsEth.map(() => 1);
    if (rewardsEth.length !== n || slots.length !== n) {
      throw new Error(`manifest has ${n} invariants but got ${rewardsEth.length} rewards and ${slots.length} slots`);
    }
    const control = a.controlManifestPath ? readManifest(a.controlManifestPath) : undefined;
    const opts = {
      rewardsEth,
      slots,
      expiryHours: a.expiryHours ?? DEMO.expiryHours,
      minBondEth: a.minBondEth ?? DEMO.minBondEth,
      k: a.k ?? DEMO.k,
      control,
      controlTierBps: a.controlTierBps,
    };
    log(`posting "${manifest.name}" (${n} invariants, escrow ${formatEther(totalValueWei(rewardsEth, slots))} ETH)`);
    const posted = await client().postBounty(manifest, opts);
    const lines = [
      `Posted bounty #${posted.bountyId} for "${manifest.name}" (${n} invariants)`,
      `manifestHash ${posted.manifestHash}`,
      `escrow ${formatEther(totalValueWei(rewardsEth, slots))} ETH  (rewards [${rewardsEth.join(", ")}] × slots [${slots.join(", ")}])`,
      `bond ${opts.minBondEth} ETH · k=${opts.k} · expires in ${opts.expiryHours} h${control ? ` · control ${control.name} @ ${opts.controlTierBps ?? 0} bps` : ""}`,
      ...manifest.invariants.map((inv, i) => `  [${i}] ${inv.label}  reward ${rewardsEth[i]} ETH × ${slots[i]}`),
      `tx ${explorerTx(posted.txHash)}`,
    ];
    return lines.join("\n");
  }),
);

server.registerTool(
  "list_bounties",
  {
    title: "List bounties",
    description: "List all bounties on the board (via the verifier server): id, name, status, escrow ETH, invariants, expiry.",
    inputSchema: {},
  },
  guarded("list_bounties", async () => {
    const rows = await client().listBounties();
    if (rows.length === 0) return "no bounties yet";
    const table = rows.map((b) => ({
      id: `#${b.id}`,
      name: b.name.length > 34 ? `${b.name.slice(0, 33)}…` : b.name,
      status: b.status,
      escrow: b.escrow_wei ? `${formatEther(BigInt(b.escrow_wei))} ETH` : "-",
      invariants: `${b.invariant_labels.length}: ${b.invariant_labels.join("; ")}`,
      expiry: b.expiry.replace("T", " ").slice(0, 16) + "Z",
    }));
    const cols = ["id", "name", "status", "escrow", "invariants", "expiry"] as const;
    const width = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...table.map((r) => r[c].length))])) as Record<(typeof cols)[number], number>;
    const line = (r: Record<(typeof cols)[number], string>) => cols.map((c) => r[c].padEnd(width[c])).join("  ").trimEnd();
    const header = Object.fromEntries(cols.map((c) => [c, c])) as Record<(typeof cols)[number], string>;
    return [line(header), ...table.map(line)].join("\n");
  }),
);

server.registerTool(
  "get_findings",
  {
    title: "Get findings",
    description:
      "Fetch attested findings for one of the buyer's bounties (signed request; only the bounty's buyer can read them). " +
      "Prints commit id, invariant, hits/k, class, attest tx, the transcript turns and the tool calls from the first replay, " +
      "and saves each finding to apps/agents/redteam/finding-<commitId>.json as a regression fixture.",
    inputSchema: { bountyId: bountyIdSchema },
  },
  guarded("get_findings", async ({ bountyId }) => {
    const c = client();
    const [findings, labels] = await Promise.all([
      c.getFindings(bountyId),
      c.getBountyPublic(bountyId).then((b) => b.invariant_labels, () => [] as string[]),
    ]);
    if (findings.length === 0) return `bounty #${bountyId}: no findings yet`;
    const outDir = resolve(agentsDir, "redteam");
    mkdirSync(outDir, { recursive: true });
    const blocks = findings.map((f: Finding) => {
      const file = resolve(outDir, `finding-${f.commitId}.json`);
      writeFileSync(file, JSON.stringify(f, null, 2));
      const lines = [
        `★ finding commit #${f.commitId}  invariant ${f.invariant} (${labels[f.invariant] ?? "?"})  hits ${f.hits}/${f.k}  class ${f.class}${f.breaksControl ? "  breaksControl" : ""}`,
        `  attest ${explorerTx(f.attestTx)}`,
        `  saved  ${file}`,
        `  transcript:`,
        ...f.transcript.turns.map((t, i) => `    ${i + 1}. ${t}`),
      ];
      const trace = f.traces[0];
      if (trace) {
        lines.push(`  trace (replay 1/${f.traces.length}, ${trace.model}):`);
        trace.turns.forEach((t, i) => {
          for (const tc of t.toolCalls) lines.push(`    turn ${i + 1}  ${tc.name}(${compact(tc.input, 80)}) → ${compact(tc.result, 80)}`);
          lines.push(`    turn ${i + 1}  assistant: ${t.assistant.replace(/\s+/g, " ").slice(0, 140)}`);
        });
      }
      return lines.join("\n");
    });
    return [`bounty #${bountyId}: ${findings.length} finding(s)`, ...blocks].join("\n\n");
  }),
);

server.registerTool(
  "expire_bounty",
  {
    title: "Expire bounty",
    description: "Call expire(bountyId) on chain after the bounty's expiry: closes it and reclaims unspent escrow to the buyer. Returns the tx link.",
    inputSchema: { bountyId: bountyIdSchema },
  },
  guarded("expire_bounty", async ({ bountyId }) => {
    const { txHash } = await client().expire(bountyId);
    return `expired bounty #${bountyId}\ntx ${explorerTx(txHash)}`;
  }),
);

server.registerTool(
  "balance",
  {
    title: "Buyer balance",
    description: "The buyer wallet (BUYER_KEY) address and its ETH balance on Base Sepolia.",
    inputSchema: {},
  },
  guarded("balance", async () => {
    const c = client();
    return `buyer ${c.address}  ${await c.balance()} ETH\n${explorerAddress(c.address)}`;
  }),
);

// ---------------------------------------------------------------------------
// Seller tools: hunt bugs and get paid. Use SELLER_KEY (falls back to BUYER_KEY).
// ---------------------------------------------------------------------------

const turnsSchema = z.array(z.string().min(1)).min(1).describe("The attacker's user turns, in order, one string per turn");

server.registerTool(
  "practice_attack",
  {
    title: "Practice an attack (no chain, no bond)",
    description:
      "Replay a sequence of user turns against a bounty's target agent in the sandbox and see, per turn, the assistant reply, the tool calls it made, and which invariant indices were violated. Free and off-chain — use it to refine an attack before you stake a bond with submit_finding.",
    inputSchema: { bountyId: bountyIdSchema, turns: turnsSchema },
  },
  guarded("practice_attack", async ({ bountyId, turns }: { bountyId: number; turns: string[] }) => {
    const session = await seller().openSession(bountyId);
    const lines: string[] = [`session on bounty #${bountyId}`];
    let lastViolations: number[] = [];
    for (const [i, text] of turns.entries()) {
      const r = await session.say(text);
      lastViolations = r.violations;
      lines.push(`\n— turn ${i + 1}`);
      lines.push(`  you: ${text}`);
      for (const tc of r.toolCalls) lines.push(`  tool ${tc.name}(${compact(tc.input, 80)}) → ${compact(tc.result, 80)}`);
      lines.push(`  agent: ${r.assistant.replace(/\s+/g, " ").slice(0, 240)}`);
      lines.push(`  violations: [${r.violations.join(", ")}]`);
    }
    lines.push(lastViolations.length ? `\n✔ violated invariant(s) [${lastViolations.join(", ")}] — submit_finding on one of these to sell it` : "\nno invariant violated yet — refine the turns and try again");
    return lines.join("\n");
  }),
);

server.registerTool(
  "submit_finding",
  {
    title: "Submit a finding (stake bond, commit, reveal)",
    description:
      "Stake the bounty's bond, commit hash(transcript+salt) on chain, and reveal the transcript to the verifier, which replays it against the pinned agent and attests PASS/FAIL. On PASS the finding is escrowed for you; call settle after the dispute window to collect the reward. Costs the bond (returned on PASS/PASS_NO_SLOT, slashed on FAIL). Practice first.",
    inputSchema: {
      bountyId: bountyIdSchema,
      invariant: z.number().int().nonnegative().describe("Index of the invariant this attack breaks (0-based)"),
      turns: turnsSchema,
    },
  },
  guarded("submit_finding", async ({ bountyId, invariant, turns }: { bountyId: number; invariant: number; turns: string[] }) => {
    const r = await seller().submitFinding(bountyId, invariant, turns);
    const tier = r.breaksControl ? " (breaksControl → lower tier)" : "";
    const next = r.outcome === "PASS" ? `\nnext: settle({ commitId: ${r.commitId} }) after the dispute window to collect` : r.outcome === "FAIL" ? "\nFAIL: the replay did not violate the invariant; bond will be slashed to the treasury at finalize" : "";
    return `commit #${r.commitId} bounty #${bountyId} inv ${invariant}\ncommit tx  ${explorerTx(r.commitTx)}\noutcome ${r.outcome}  hits ${r.hits}/3${tier}\nattest tx  ${explorerTx(r.attestTx)}${next}`;
  }),
);

server.registerTool(
  "settle",
  {
    title: "Settle a finding (collect the reward)",
    description:
      "After the dispute window has elapsed on a PASS commit, finalize it: the reward leaves escrow to the seller and the bond is returned. Anyone may call this; the seller normally does. Returns the finalize tx and the amount paid.",
    inputSchema: { commitId: z.number().int().nonnegative().describe("Commit id from submit_finding") },
  },
  guarded("settle", async ({ commitId }: { commitId: number }) => {
    const r = await seller().settle(commitId);
    return `commit #${commitId} finalized\nfinalize tx ${explorerTx(r.finalizeTx)}\npaid ${formatEther(r.paidWei)} ETH reward (+ bond returned)`;
  }),
);

server.registerTool(
  "seller_balance",
  {
    title: "Seller balance",
    description: "The seller wallet (SELLER_KEY) address and its ETH balance on Base Sepolia.",
    inputSchema: {},
  },
  guarded("seller_balance", async () => {
    const c = seller();
    return `seller ${c.address}  ${await c.balance()} ETH\n${explorerAddress(c.address)}`;
  }),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

process.on("uncaughtException", (e) => log("uncaught exception:", e instanceof Error ? e.stack ?? e.message : e));
process.on("unhandledRejection", (e) => log("unhandled rejection:", e instanceof Error ? e.stack ?? e.message : e));

await server.connect(new StdioServerTransport());
log(`ready · rpc ${RPC_URL} · server ${SERVER_URL} · bazaar ${BAZAAR_ADDRESS ?? "(sdk default)"} · env ${resolve(agentsDir, ".env")}`);
