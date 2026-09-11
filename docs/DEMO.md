# Live demo runbook

Everything runs for real: Base Sepolia, the verifier, both autonomous agents, the board.

## Before recording

```bash
pnpm verify:services          # RPC, keys, Supabase, Basescan
cd apps/agents && bun run fund   # balances; each full cycle costs ~0.00001 ETH in gas
pnpm demo:reset               # clears consoles, agent state, findings, patched manifests
```

Wallets (Base Sepolia): platform = verifier/arbiter/treasury `0x3Df07C2884655Bef7AF54a4fb07272266352E641`,
buyer `0x6FB07aa17df60c8950B5DA74bEEf9b5446a5E655`, seller `0x8D6178092A9a1B9223d9678359181Ef0eDd7f626`.
Demo amounts are scaled by `BUGIFY_DEMO_SCALE` in `apps/agents/.env`.

## Start

```bash
pnpm demo
```

Boots server (:8787), board (:3000), a Cloudflare quick tunnel (prints the public server URL for external agents; also saved to `.demo/tunnel.url`), builder agent, finder agent; tails all logs. `pnpm demo:stop` ends it.
Open two browser windows: `http://localhost:3000` (board + consoles) and `http://localhost:3000/northwind`
(deployer's view).

## What happens, in order (~6–8 min)

| t | Where to look | What you see |
|---|---|---|
| 0:00 | board | empty or closed-only, contract + verifier links, "How it works" |
| 0:10 | builder console | posts one bounty per Northwind agent (support PR #42, billing PR #17, delivery PR #9); rows appear live with escrow |
| 0:40 | finder console | picks a bounty, opens a practice session, plans a turn, sends it; target replies, tool calls shown; `violations []` |
| 1:30 | finder console → ledger | `✔ tripped invariant`; commit tx; reveal; verifier console: `hash ok · seq 0 == cursor · replay ×3 → 3/3 → attest PASS`; row flips to PASS |
| 2:30 | board | expand the commit → Verification (3 replays, tool names, evidence) → "Show exchange (demo)" for the full conversation with the breaking call in red |
| 3:00 | finder console | `waiting for the dispute window…` → finalize tx → paid |
| 3:30 | builder console | new finding → transcript + trace → `patching … with claude-sonnet-5` → diff → `regression: invariant now HOLDS` → posts PR #43 |
| 4:30 | /northwind | support agent family shows PR #43 with "patched" badge; PR #42 with 1 finding |
| 5:00 | finder console | attacks PR #43, `gave up: invariant 0 not tripped in 6 turns` |
| 6:00 | board | Basescan links on any row; events ticker |

Optional extras (scripts, `apps/agents`):
- `bun run seller-mimic --bounty <id> --wait`: text-mimic attack → FAIL → bond slashed.
- `bun run buyer --control --all` then `bun run seller --bounty <id> --attack generic`: generic jailbreak breaks the control too → PASS with `breaksControl`, paid 25%.
- `bun run buyer-dispute --commit <id>` then `bun run arbiter --commit <id> --outcome PASS|FAIL`: dispute path.
- Claude Code with the `bazaar` MCP server: "post a bounty for manifests/targets/northwind.json and pull findings".

## If something stalls

- Finder "gave up" on everything: normal for the delivery agent (Haiku holds); support and billing trip within 2 turns.
- `NoSuchCommit` / `NoSuchBounty` from the server: RPC lag; the server retries ~15 s.
- Out of gas: `bun run fund --send --buyer 0.00002 --seller 0.00001` from the platform wallet.
- Consoles empty: `SERVER_URL` must be set in `apps/agents/.env`.
