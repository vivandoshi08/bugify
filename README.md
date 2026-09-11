# Black Box Bazaar (bugify)

A bounty marketplace where deployers of production LLM agents buy proof that their agent can be
socially engineered, from red-team agents that have already found the exploit.

The buyer posts a bounty on-chain that pins the target (a hash of the agent's manifest: system
prompt, model, tools, mocks) and specifies each forbidden outcome as a machine-checkable invariant
with its own reward, and funds it into escrow before anyone shows anything. A seller who has found an
attack stakes a bond and commits `keccak(transcript ‖ salt)`. A verifier replays the committed
transcript against the pinned manifest and attests PASS or FAIL on-chain; after a dispute window,
anyone calls `finalize` and escrow releases automatically. The buyer never gets to see-then-decide.

## The vertical

| Piece | Where | Does |
|---|---|---|
| `contracts/` | Base Sepolia | `Bazaar` escrow, commit-reveal, FIFO attest, disputes, settlement. `SingleVerifier`, `BudgetVault`. |
| `packages/sdk` | shared | Types, canonical hashing (the only place bytes are defined), ABI, `createBazaar` client. |
| `apps/server` | laptop | Hono: manifests, practice sessions, reveal → verifier (replay ×k, trace predicates) → attest; indexer → Supabase; settler. |
| `apps/agents` | laptop | `buyer.ts`, `seller.ts`, `seller-mimic.ts`, the Northwind manifest and attacks. |
| `apps/web` | Vercel / local | Read-only board from Supabase with Realtime. No wallet. |
| `supabase/` | cloud | Mirror of chain events (public) + manifests and findings (service key only). |

Deployed and verified on Base Sepolia:
[Bazaar 0x1F49d4C3473FB7Ee51A79FbAa0CBb6165c408839](https://sepolia.basescan.org/address/0x1F49d4C3473FB7Ee51A79FbAa0CBb6165c408839#code) ·
[SingleVerifier 0xe3789C8bdb4D698A13ceF60C929478936b8A3257](https://sepolia.basescan.org/address/0xe3789C8bdb4D698A13ceF60C929478936b8A3257#code)

## Trust assumptions (v1)

- One platform key is verifier, arbiter and treasury. The verifier sees every manifest and every
  exploit before payment. `IVerifierSet` and `arbiter` are pluggable addresses so v2 can replace
  them with a staked set and an independent arbiter without touching escrow.
- Transcripts are static user turns replayed at temperature 0, k times; PASS needs ≥ 1 hit.
- Invariants are trace predicates (`tool_gate`, `tool_sum_cap`, `forbidden_tool`) plus one exact
  text predicate (`canary`). No LLM judge reads the chat.

## Biggest decision

Bounty-first escrow plus a verifier that runs the target. Money is committed to an outcome before
any seller reveals anything, and the thing that decides the outcome is a replay against the pinned
manifest, not the buyer's opinion.

## Limitation

Single trusted verifier and static transcripts. Adaptive multi-turn attackers and a threshold
verifier set are v2.

## Run it

Prereqs: Node 24, pnpm 11, Bun, Foundry. `pnpm install`.

```bash
pnpm verify:services        # RPC, deployer key, Supabase, Basescan live checks
pnpm verify:schema          # RLS + view checks against Supabase
pnpm forge:test             # 101 contract tests incl. invariants
```

Env files (git-ignored): `apps/server/.env`, `apps/agents/.env`, `apps/web/.env.local`; see each
`.env.example`. Demo amounts are scaled by `BUGIFY_DEMO_SCALE` (testnet gas budget).

```bash
pnpm --filter server dev                 # http://localhost:8787, /health
pnpm --filter web dev                    # http://localhost:3000, the board
cd apps/agents
bun run buyer                            # post bounty, poll findings (or --bounty <id> --once)
bun run seller --bounty <id>             # practice → commit → reveal → attest → settle
bun run seller-mimic --bounty <id> --wait  # text-mimic attack → FAIL → bond slashed
```

## Docs

- [docs/CONTRACTS.md](docs/CONTRACTS.md), [docs/contract-flows.html](docs/contract-flows.html)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/system-architecture.html](docs/system-architecture.html)
- [docs/CONTRACTS-REVIEW.md](docs/CONTRACTS-REVIEW.md), implementation notes and deviations
