// Smoke test: spawn src/mcp.ts over stdio, list tools, call `balance`. Needs BUYER_KEY in apps/agents/.env
// (loaded by the server itself) and RPC access to Base Sepolia. Values from .env are never printed.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const agentsDir = resolve(import.meta.dir, "..");
const client = new Client({ name: "mcp-smoke-test", version: "0.0.0" });

beforeAll(async () => {
  await client.connect(new StdioClientTransport({ command: "bun", args: ["run", "src/mcp.ts"], cwd: agentsDir }));
}, 30_000);

afterAll(async () => {
  await client.close();
});

test("tools/list exposes the buyer and seller tools", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name).sort()).toEqual(
    ["balance", "expire_bounty", "get_findings", "list_bounties", "post_bounty", "practice_attack", "seller_balance", "settle", "submit_finding"],
  );
  for (const t of tools) expect(t.description).toBeTruthy();
});

test("balance returns the buyer address and ETH", async () => {
  const result = await client.callTool({ name: "balance", arguments: {} });
  const text = (result.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("\n");
  expect(result.isError).toBeFalsy();
  expect(text).toContain("0x");
  expect(text).toMatch(/\d+(\.\d+)? ETH/);
}, 30_000);

test("tool errors come back as isError results, not crashes", async () => {
  const result = await client.callTool({ name: "get_findings", arguments: { bountyId: 999_999_999 } });
  expect(result.isError).toBe(true);
  // the server is still alive afterwards
  const { tools } = await client.listTools();
  expect(tools.length).toBe(9);
}, 30_000);
