# Architecture

This document is the in-repo summary of how the suite is organised. The full
plan with rationale lives in `~/.cursor/plans/solana-mm-suite_*.plan.md`.

## Package boundary

```
apps/cli           apps/web
   │                  │
   └──────────┬───────┘
              ▼
     packages/orchestrator      (Orchestrator + AppContext)
              │
              ▼
     packages/strategies        (volume, clmm-mm, ob-mm, lp-manager, backtest)
              │
              ▼
     packages/venues            (PumpSwap, Raydium, Orca, Meteora, Phoenix, Jupiter)
              │
              ▼
     packages/core              (vault, RPC mgr, executor, store, sweep, funding, oracle, http)
              │
              ▼
     packages/shared            (logger, types, math, RNG, constants)
```

Strategies depend on venues; venues depend on core; core depends on shared.
The orchestrator wires it together; the apps invoke the orchestrator.

## Strategies

| Strategy | What it does |
| --- | --- |
| `volume` | Markov state machine + log-normal trade sizes + Poisson intervals. Routes through Jupiter v6 by default. Anti-fingerprint: no fixed cadence, no fixed size, no round-robin wallet selection. |
| `clmm-mm` | Generic CLMM rebalancer working on Meteora DLMM, Raydium CLMM, Orca Whirlpools. Hysteresis-gated rebalance, inventory targeting, fee compounding. |
| `ob-mm` | Avellaneda-Stoikov order-book MM on Phoenix. Rolling EWMA realised volatility, layered orders, inventory-skewed reservation price, hard min-spread floor. |
| `lp-manager` | Manual one-shot deposit / withdraw / list across venues with simulation preview. |

## OPSEC

- **Vault**: AES-256-GCM with scrypt KDF (N=16384, r=8, p=1). Atomic write via tmp+rename. File mode 0600.
- **RPC**: multi-endpoint pool, weighted pick by health + rate budget. Writes fan out to all healthy endpoints.
- **Tor**: optional `TOR_PROXY=socks5h://127.0.0.1:9050` env routes all RPC + outbound HTTP through Tor.
- **Funding**: 3-7 random intermediate hops between funder and trading wallet. Intermediate keypairs live in memory only.
- **Web**: bound to `127.0.0.1` only. No auth (the bind is the boundary).
- **Logs**: redact obvious secret-shaped fields. No remote log shipping.
- **No fee skim**: every lamport of P&L stays with the operator wallet.

## Backtester

`packages/strategies/src/backtest/` ships a synthetic-tape (geometric brownian
motion) generator and replay engines for both the `volume` and `ob-mm`
strategies. Use it via `pnpm cli backtest volume` / `pnpm cli backtest ob-mm`.

For replaying real historical pool state, the next step is to add a
DAS / Helius-backed tape ingester - the backtester takes any `PriceTape`,
synthetic or real.
