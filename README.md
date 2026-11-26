# Overhang-Exhaustion Flush Bot — Pump.fun Replay Sprint

[![Entry](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/abdulkemal76-tech/makefun-pump-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/abdulkemal76-tech/makefun-pump-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve activity. No real money moves.

## The idea

Buy a coin only **after** its early holders have finished dumping it:

1. **Flush entry** — price 70% under its 1h high, sellers quiet (under 0.5 SOL sold in 200 slots), fresh buyers returning (0.5 SOL from 3+ wallets in the same window). A -50% dip alone does not bounce; the bounce only shows up when sells have dried up *and* buyers are coming back.
2. **Opening-tape entry** — a coin whose first 10 trades are all buys, with non-negative net flow and a non-negative rise off its first price, is a clean launch with no early seller in the tape.
3. **Scale-in** — up to 1.5 SOL per coin, one order per batch, each capped at 1% of the coin's real SOL reserves. A coin whose reserves grow gets filled on the way up; one that never grows never gets size.
4. **Ladder exits** — bank a third of the position at +5%, +10% and +20% above the entry anchor, keep the rest on a trailing stop (-30% off the peak, armed at +50%), cut the whole position at -15%, and never hold longer than ~20 minutes.

## Dev result (kit window, 2026-11-02 → 2026-11-03)

`makefun grade-local --driver process` on this repo:

- **Net PnL +0.470 SOL** (return 4.7%), 90% interval -0.007 … +1.189 SOL
- **71 coins** with round trips ≥ 0.01 SOL (guardrail needs 20), 321 fills, 71 round trips
- Max drawdown **1.6%** (guardrail 50%)
- Positive even at twice the fees (+0.270 SOL) and without the top 3 coins (0.00 SOL)
- Deterministic: the two executions reproduce byte for byte

## Files

- `main.ts` — entrypoint: wires the strategy to the `agent-fun/replay/v2` harness.
- `strategy.ts` — the bot. No clock, no randomness, no environment, no network; every decision comes from the batch's events and the account state the harness hands over.
- `vendor/makefun-bot.ts` — the kit's SDK shim (copied as the SDK header allows; excluded from authorship counts).
- `.makefun/owner.json` — the wallet that signs this entry.

## Run

The grader runs `node /bot/main.ts` (Node 22+, erasable TypeScript, stdlib only). To grade locally against the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
