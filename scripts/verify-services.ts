/**
 * Live connectivity check for every external service bugify depends on.
 * Run: pnpm verify:services   (reads root .env)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

async function chain() {
  const rpc = need("BASE_SEPOLIA_RPC_URL");
  const client = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
  const [id, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  const account = privateKeyToAccount(need("PRIVATE_KEY") as `0x${string}`);
  const expected = need("DEPLOYER_ADDRESS").toLowerCase();
  const balance = await client.getBalance({ address: account.address });
  const eth = Number(formatEther(balance));
  results.push({ name: "base-sepolia rpc", ok: id === 84532, detail: `chainId=${id} block=${block}` });
  results.push({
    name: "deployer key",
    ok: account.address.toLowerCase() === expected,
    detail: `${account.address} (env DEPLOYER_ADDRESS ${expected === account.address.toLowerCase() ? "matches" : "MISMATCH"})`,
  });
  results.push({ name: "deployer balance", ok: eth >= 0.0001, detail: `${eth} ETH (need >= 0.0001; a deploy costs ~0.000002 on Base Sepolia)` });
}

async function supabase() {
  const url = need("SUPABASE_URL");
  const secret = createClient(url, need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
  const pub = createClient(url, need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), { auth: { persistSession: false } });
  const note = `verify ${new Date().toISOString()}`;
  // Secret key: insert + delete (bypasses RLS). Table from supabase/migrations/*_init.sql.
  const ins = await secret.from("health_checks").insert({ note }).select("id").single();
  results.push({ name: "supabase secret write", ok: !ins.error, detail: ins.error?.message ?? `inserted ${ins.data?.id}` });
  // Publishable key: RLS allows select, denies insert.
  const rd = await pub.from("health_checks").select("id,note").eq("note", note).maybeSingle();
  results.push({ name: "supabase publishable read", ok: !rd.error && rd.data?.note === note, detail: rd.error?.message ?? "row visible" });
  const bad = await pub.from("health_checks").insert({ note: "should fail" });
  results.push({ name: "supabase rls blocks anon write", ok: !!bad.error, detail: bad.error?.message ?? "INSERT SUCCEEDED (RLS misconfigured)" });
  if (ins.data?.id) await secret.from("health_checks").delete().eq("id", ins.data.id);
}

async function basescan() {
  const key = need("BASESCAN_API_KEY");
  const r = await fetch(
    `https://api.etherscan.io/v2/api?chainid=84532&module=proxy&action=eth_blockNumber&apikey=${key}`,
  );
  const j = (await r.json()) as { result?: string; message?: string };
  const ok = typeof j.result === "string" && j.result.startsWith("0x");
  results.push({ name: "basescan api", ok, detail: ok ? `block ${parseInt(j.result!, 16)}` : JSON.stringify(j) });
}

async function privy() {
  // Privy is not yet a committed dependency; skip cleanly when unset.
  if (!process.env.NEXT_PUBLIC_PRIVY_APP_ID || !process.env.PRIVY_APP_SECRET) {
    results.push({ name: "privy app (optional)", ok: true, detail: "skipped (env unset)" });
    return;
  }
  const id = need("NEXT_PUBLIC_PRIVY_APP_ID");
  const secret = need("PRIVY_APP_SECRET");
  const r = await fetch(`https://auth.privy.io/api/v1/apps/${id}`, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "privy-app-id": id,
    },
    redirect: "follow",
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; name?: string };
  results.push({ name: "privy app (optional)", ok: r.ok && j.id === id, detail: r.ok ? `app "${j.name}"` : `HTTP ${r.status}` });
}

const tasks = [chain, supabase, basescan, privy];
for (const t of tasks) {
  try {
    await t();
  } catch (e) {
    results.push({ name: t.name, ok: false, detail: (e as Error).message });
  }
}
const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
