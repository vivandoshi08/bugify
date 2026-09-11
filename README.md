# bugify

Bounty marketplace for social-engineering exploits against production LLM agents. Deployers post
on-chain bounties pinned to a target (endpoint + system-prompt hash + model version) with a
machine-checkable forbidden outcome, funded into escrow. Red-team sellers stake a bond, commit
`hash(transcript + salt)`, a verifier replays against the pinned target and reports pass/fail, and
on pass the reveal is hash-checked and escrow releases automatically.

## Stack

- Chain: Base Sepolia (84532) — Foundry (`contracts/`), viem, wagmi, Privy auth
- Database: Supabase project `bugify` (ref `ixqylpaihyxxhxuuyqga`)
- Web: Next.js 16 / React 19 (`apps/web`)

## Setup

```bash
# Node 24+, pnpm 11+, Foundry
pnpm install
cp .env.example .env               # scripts
cp .env.example apps/web/.env.local
cp .env.example contracts/.env
pnpm verify:services               # live check of RPC, deployer key, Supabase, Basescan, Privy
```

## Commands

```bash
pnpm dev            # next dev (apps/web)
pnpm typecheck
pnpm forge:build
pnpm forge:test
pnpm verify:services
```

## Env layout

| File                  | Purpose                              | Contains PRIVATE_KEY? |
| --------------------- | ------------------------------------ | --------------------- |
| `.env`                | root, read by `scripts/*`            | yes                   |
| `contracts/.env`      | forge deploy + verify                | yes                   |
| `apps/web/.env.local` | Next.js (public + server-only keys)  | no                    |

Only `.env.example` is committed.
