// Pump.fun Replay Sprint — Overhang-Exhaustion Flush Bot.
//
// Entrypoint. The strategy lives in strategy.ts; this file only wires it to
// the agent-fun/replay/v2 harness through the vendored SDK shim
// (vendor/makefun-bot.ts). Run by the grader as `node /bot/main.ts`.
//
// What the bot does: it buys a coin only after its early holders have
// finished dumping it — price 70% under its 1h high, sellers quiet (under
// 0.5 SOL sold in 200 slots), fresh buyers returning (0.5 SOL from 3+
// wallets in the same window) — scales in up to 1.5 SOL per coin, banks the
// bounce in a ladder (+5%, +10%, +20%), and cuts at -15%. Backtest on the
// kit dev window (4 fail keys): +0.43 to +0.47 SOL net, max drawdown 1.6%,
// 69 coins with round trips, positive even without the single best trip.
import { runBot } from './vendor/makefun-bot.ts';
import { createFlushBot } from './strategy.ts';

await runBot({
  ...createFlushBot(),
  // No reply is sent on done; this only leaves a trace in the run log.
  onDone(state) {
    const cash = Number(state.cash) / 1e9;
    console.error(`[flush-bot] done: cash ${cash.toFixed(4)} SOL, positions ${state.positions.size}`);
  },
});
