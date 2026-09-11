# bugify contracts

Foundry project for the Bazaar escrow/settlement contracts. Spec: [docs/CONTRACTS.md](../docs/CONTRACTS.md).
Review and implementation notes: [docs/CONTRACTS-REVIEW.md](../docs/CONTRACTS-REVIEW.md).

| Contract | Role |
|---|---|
| `src/Bazaar.sol` | Escrow, commit-reveal, FIFO attestation, disputes, settlement. Native ETH only. |
| `src/SingleVerifier.sol` | v1 `IVerifierSet`: one rotatable verifier key. |
| `src/BudgetVault.sol` | Optional per-buyer spend cap; is the buyer from Bazaar's point of view. |
| `src/interfaces/IBazaar.sol` | Types, errors, events shared with SDK and indexer. |

## Commands

```bash
forge build
forge test                       # unit + fuzz + invariant (101 tests)
forge test --match-path 'test/invariant/*' -vv
forge snapshot                   # refresh .gas-snapshot
forge fmt
```

## Deploy (Base Sepolia)

`contracts/.env` needs `BASE_SEPOLIA_RPC_URL`, `PRIVATE_KEY`, `BASESCAN_API_KEY`, and `VERIFIER`, `ARBITER`,
`TREASURY` (v1: all the platform address). Writes `deployments/84532.json`.

```bash
set -a; . ./.env; set +a
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify --verifier etherscan
```

Local: `anvil` then `forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast`.

## Tests

- `test/unit/Bazaar.t.sol`: every row of the spec §7 matrix, one test per custom error, extra behaviour
  tests, two fuzz tests.
- `test/unit/BudgetVault.t.sol`, `test/unit/SingleVerifier.t.sol`.
- `test/invariant/`: random handler over all 12 actions; spec §6 invariants plus exact payout, escrow
  accounting and commitment enforcement.
