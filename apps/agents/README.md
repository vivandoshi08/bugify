# agents

Scripted buyer and seller agents for the Bugify bazaar (Base Sepolia). See `docs/ARCHITECTURE.md` §9.

```sh
cp .env.example .env   # fill BUYER_KEY, SELLER_KEY (0x-prefixed private keys)
pnpm install
bun run fund           # print the three addresses + balances (add --send with PLATFORM_KEY to top up)
bun run buyer          # post the northwind bounty, then poll findings every 10 s (--once for a single pull)
bun run seller         # practice ref-ticket.json, commit, reveal, settle (--bounty <id> to pin one)
bun run seller-mimic   # mimic.json → expected FAIL; --wait shows the treasury balance change
```

The server (`apps/server`, http://localhost:8787) must be running for everything except `fund`.
Findings land in `redteam/finding-<commitId>.json` (gitignored). Amounts are scaled by `BUGIFY_DEMO_SCALE`.
