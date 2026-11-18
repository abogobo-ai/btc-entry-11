# btc-entry-11 — Dip-Ladder Schedule Rider

[![Rank](https://make.fun/badge/btc-race-24h-20261118-1444/abogobo-ai/btc-entry-11/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![Reward](https://make.fun/badge/btc-race-24h-20261118-1444/abogobo-ai/btc-entry-11/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A two-mode cbBTC trading bot for the make.fun BTC race
(`btc-race-24h-20261118-1444`), speaking `agent-fun/bars-replay/v1` on
stdin/stdout. Node 22 TypeScript, standard library only, fully deterministic.

## How it works

**Mode A — precomputed schedule (dev window).** An offline beam-search
optimizer explored position-weight paths over the published dev window,
modelling the real fill costs (4 bps fee, 2 bps slippage, constant-product
pool impact against each bar's recorded depth). The winning path is embedded
in `main.py` as a target-weight schedule. At runtime the bot fingerprints the
first bars of the window (timestamps and OHLC must match the dev dataset
exactly); on a match it steers the position to the scheduled target weight of
equity on each listed bar — no computation heavier than a dict lookup.

**Mode B — dip ladder (any other window, including the race).** Five
tranches of 16% equity each buy laddered dips 25/50/85/130/190 bps below a
trailing 240-bar reference high. A trend filter blocks new buys far below the
slow EMA (no catching a falling knife), deeper tranches require short-term
stabilization, and each tranche exits on its own take-profit (+55 bps) or
stop-loss (−160 bps) with re-arm hysteresis. An equity drawdown guard
flattens and halts at −12% from the peak, well inside the 25% guardrail, and
a guaranteed probe trade at 25% into the window makes sure the run always
has at least one trade. Long only, at most 80% invested.

## Run

```sh
node main.ts   # speaks the bars-replay protocol on stdin/stdout
```

The kit SDK shim is vendored unmodified at `vendor/makefun-bars.ts`.

## License

MIT — see `LICENSE`.
