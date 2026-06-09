# Operating notes

## First run

```bash
pnpm install
cp .env.example .env
# fill in at least RPC_PUBLIC (or any other RPC_* var)

pnpm -r build              # build every workspace
pnpm cli vault init        # creates ~/.amm/vault.enc
```

## Generate trading wallets

```bash
pnpm cli wallet generate --count 10 --prefix vol --tag volume
pnpm cli wallet list --balances
```

## Fund them with multi-hop indirection

```bash
# Move 0.1 SOL to each volume wallet, with 3-7 intermediate hops each.
pnpm cli volume fund --from <funder-label> --wallet-tag volume --per-wallet 0.1
```

## Run the volume strategy

```bash
# Routes through Jupiter v6, requires explicit base/quote mints:
pnpm cli volume start \
  --pool <ANY_POOL_ID> \
  --venue jupiter \
  --base <BASE_MINT> \
  --quote So11111111111111111111111111111111111111112 \
  --wallet-tag volume \
  --slippage-bps 100 \
  --mean-size 0.05 \
  --dry-run
```

Drop `--dry-run` for real sends.

## Sweep funds back when done

```bash
pnpm cli sweep --to <YOUR_MAIN_PUBKEY> --wallet-tag volume
```

## Web dashboard

```bash
pnpm web
# visit http://127.0.0.1:4317
```

The dashboard never binds to anything other than 127.0.0.1. There is no auth -
the bind is the security boundary.

## CLMM rebalancer

```bash
pnpm cli clmm start \
  --venue meteora-dlmm \
  --pool <DLMM_POOL_ID> \
  --wallet <LP_WALLET_LABEL> \
  --width 0.04 \
  --hysteresis 0.01 \
  --slippage-bps 80
```

## Phoenix OB MM

```bash
pnpm cli ob start \
  --market <PHOENIX_MARKET_ID> \
  --wallet <MM_WALLET_LABEL> \
  --gamma 0.1 \
  --layers 3 \
  --layer-size 0.5
```

## Backtest before going live

```bash
pnpm cli backtest volume --vol 0.6 --mean-size 0.05
pnpm cli backtest ob-mm --gamma 0.1 --vol 0.6
```
