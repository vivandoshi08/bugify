/**
 * Smoke test for supabase/migrations/*_bazaar_schema.sql: RLS and the public_bounties view.
 * Run: pnpm verify:schema   (reads root .env)
 */
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type Check = { name: string; ok: boolean; detail: string };
const results: Check[] = [];
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const check = (name: string, ok: boolean, detail: string) => results.push({ name, ok, detail });

const url = need("SUPABASE_URL");
const secret = createClient(url, need("SUPABASE_SECRET_KEY"), { auth: { persistSession: false } });
const pub = createClient(url, need("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"), { auth: { persistSession: false } });

const HASH = "0x" + "a".repeat(64);
const BOUNTY_ID = 999999;

async function cleanup() {
  await secret.from("bounties").delete().eq("id", BOUNTY_ID);
  await secret.from("manifests").delete().eq("hash", HASH);
}

try {
  await cleanup(); // leftovers from an aborted run

  // --- seed with the secret key -------------------------------------------
  const m = await secret.from("manifests").insert({
    hash: HASH,
    name: "smoke",
    model: "x",
    body: { system: "SECRET" },
    invariant_labels: ["a"],
  });
  check("secret insert manifest", !m.error, m.error?.message ?? "ok");

  const b = await secret.from("bounties").insert({
    id: BOUNTY_ID,
    buyer: "0x" + "b".repeat(40),
    manifest_hash: HASH,
    rewards_wei: ["1"],
    slots: [1],
    expiry: new Date(Date.now() + 3600_000).toISOString(),
    min_bond_wei: "1",
    k: 1,
    control_tier_bps: 0,
  });
  check("secret insert bounty", !b.error, b.error?.message ?? "ok");

  // --- publishable key: what the browser can see ---------------------------
  const view = await pub.from("public_bounties").select("*").eq("id", BOUNTY_ID).maybeSingle();
  const row = (view.data ?? null) as Record<string, unknown> | null;
  check(
    "anon reads public_bounties row with name",
    !view.error && row?.name === "smoke" && row?.model === "x",
    view.error?.message ?? (row ? `name=${String(row.name)}` : "no row"),
  );
  const leaked = row ? Object.keys(row).filter((k) => k === "body" || k === "system") : [];
  const serialized = row ? JSON.stringify(row) : "";
  check(
    "public_bounties exposes no body/system",
    !!row && leaked.length === 0 && !serialized.includes("SECRET"),
    row ? (leaked.length ? `leaked columns: ${leaked.join(",")}` : `columns: ${Object.keys(row).join(",")}`) : "no row",
  );

  const man = await pub.from("manifests").select("*").eq("hash", HASH);
  check(
    "anon select manifests returns zero rows (RLS)",
    !man.error && Array.isArray(man.data) && man.data.length === 0,
    man.error?.message ?? `${man.data?.length ?? "?"} rows`,
  );

  const fin = await pub.from("findings").select("*");
  check(
    "anon select findings returns zero rows (RLS)",
    !fin.error && Array.isArray(fin.data) && fin.data.length === 0,
    fin.error?.message ?? `${fin.data?.length ?? "?"} rows`,
  );

  const ins = await pub.from("commits").insert({
    id: 999999,
    bounty_id: BOUNTY_ID,
    invariant: 0,
    seq: 0,
    seller: "0x" + "c".repeat(40),
    commitment: "0x" + "d".repeat(64),
    bond_wei: "1",
  });
  check("anon insert commits rejected", !!ins.error, ins.error?.message ?? "INSERT SUCCEEDED (RLS misconfigured)");
  if (!ins.error) await secret.from("commits").delete().eq("id", 999999);
} catch (e) {
  check("unexpected error", false, (e as Error).message);
} finally {
  await cleanup();
  const gone = await secret.from("manifests").select("hash").eq("hash", HASH);
  check("secret cleanup", !gone.error && gone.data?.length === 0, gone.error?.message ?? "smoke rows deleted");
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
