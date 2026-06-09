# AMM Suite

A private, anonymous Solana market-making suite covering PumpSwap, Raydium (AMM v4 / CPMM / CLMM), Orca Whirlpools, Meteora DLMM, and Phoenix - with three first-class strategies: organic-flow volume, CLMM LP rebalancing, and Avellaneda-Stoikov order-book quoting.

> **OPSEC notice.** This repo runs entirely locally. There is no telemetry, no remote DB, no fee skim, no shared state. Wallets live in an encrypted vault on your disk. The dashboard binds to `127.0.0.1` only.

## Layout

```
amm/
├── packages/
│   ├── shared/          types, constants, logger
│   ├── core/            wallet vault, multi-RPC manager, tx executor, sweep, sqlite store
│   ├── venues/          one adapter per DEX, common Venue interface
│   ├── strategies/      volume, clmm-mm, ob-mm, lp-manager
│   └── orchestrator/    strategy runner + risk/inventory gates
├── apps/
│   ├── cli/             commander-based CLI
│   └── web/             Next.js 15 dashboard (localhost only)
├── legacy/              the old code, kept for reference, not built
└── docs/
```

## Quick start

> **New here? Start with [`docs/onboarding.md`](docs/onboarding.md)** — a 45-minute end-to-end devnet walkthrough that covers install, wallet, faucet, minting test tokens, creating a Meteora DLMM pool, and running the auto-LP strategy.

```bash
pnpm install
cp .env.example .env
# fill in at least one RPC_* endpoint

# create a vault and import / generate wallets
pnpm cli vault init
pnpm cli wallet generate --count 10

# run the volume strategy on a pumpswap pool
pnpm cli volume start --pool <POOL_ID> --venue pumpswap

# or open the dashboard
pnpm web
# then visit http://127.0.0.1:4317
```

### Devnet test harness

```bash
# Load devnet env (PowerShell)
$env:SOLANA_CLUSTER='devnet'
$env:RPC_PUBLIC='https://api.devnet.solana.com'
$env:VAULT_PATH='./.amm-devnet/vault.enc'
$env:VAULT_PASSPHRASE='devnet-test-pass'

# Bootstrap a fresh test pool with two SPL tokens, then run the strategy
amm vault init --from-env
amm wallet generate --count 1 --prefix devnet
# fund via https://faucet.solana.com/
amm devnet mint-test-tokens --wallet devnet-1 --base-supply 1000000 --wrap-sol 1
amm devnet create-pool --wallet devnet-1 --bin-step 25 --initial-price 0.001
amm meteora-lp start --pool <POOL> --wallet devnet-1 --mode quote-only --dry-run
```

Full step-by-step in [`docs/onboarding.md`](docs/onboarding.md).

## Strategies

| Strategy | Module | Purpose |
| --- | --- | --- |
| `volume` | `@amm/strategies` | Organic-flow buy/sell using a Markov state machine + log-normal sizes + Poisson intervals. Routes through Jupiter v6 for best price. |
| `clmm-mm` | `@amm/strategies` | Range LP positions with auto-rebalance + fee compounding on Meteora DLMM, Raydium CLMM, Orca Whirlpools. |
| `ob-mm` | `@amm/strategies` | Avellaneda-Stoikov two-sided quoting on Phoenix. |
| `lp-manager` | `@amm/strategies` | Manual LP deposit/withdraw with simulation preview. |

## Security model

- Keys are encrypted at rest with AES-256-GCM, scrypt KDF from a passphrase.
- The web dashboard listens on `127.0.0.1` only and has no authentication (the localhost binding is the entire security boundary).
- Optional Tor SOCKS5 routing for all RPC calls (`TOR_PROXY` env var).
- Multi-hop sub-wallet funding to break trace from operator wallet to traders.
- Multi-RPC rotation to avoid single-provider fingerprinting.

## License

MIT
