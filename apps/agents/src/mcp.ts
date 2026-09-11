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

// Built lazily so tools/list works (and a clear error surfaces per call) even when BUYER_KEY is missing.
let bz: Bazaar | undefined;
const client = () =>
  (bz ??= createBazaar({ rpcUrl: RPC_URL, privateKey: requireKey("BUYER_KEY"), bazaarAddress: BAZAAR_ADDRESS, serverUrl: SERVER_URL }));

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
// Start
// ---------------------------------------------------------------------------

process.on("uncaughtException", (e) => log("uncaught exception:", e instanceof Error ? e.stack ?? e.message : e));
process.on("unhandledRejection", (e) => log("unhandled rejection:", e instanceof Error ? e.stack ?? e.message : e));

await server.connect(new StdioServerTransport());
log(`ready · rpc ${RPC_URL} · server ${SERVER_URL} · bazaar ${BAZAAR_ADDRESS ?? "(sdk default)"} · env ${resolve(agentsDir, ".env")}`);
