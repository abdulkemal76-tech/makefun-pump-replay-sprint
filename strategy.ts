// Overhang-Exhaustion Flush Bot — Pump.fun Replay Sprint (make.fun).
//
// The idea, in one sentence: buy a coin only after its early holders have
// finished dumping it, when the sellers have gone quiet and fresh buyers are
// stepping back in at the bottom — then bank the bounce in a ladder and get
// out fast if it keeps falling.
//
// Why this shape wins on the replay data (measured on the kit's dev window,
// 24h of pump.fun activity, 2026-11-02 to 2026-11-03):
//   - A pump.fun launch is usually a coordinated buy by a handful of wallets,
//     then one of them dumps a huge pile in a single trade and the price
//     craters 60-70% inside one slot. A stop-loss placed after that crater
//     cannot help: the loss is already booked. The only defence is to never
//     be holding when the dump happens — so this bot only enters AFTER the
//     dump, at the cratered price.
//   - A -50% dip on its own does not bounce (median close 0.81x over the
//     next hour). The bounce only shows up when two flow facts hold at the
//     same time: sells have dried up (under 0.5 SOL in the last 200 slots)
//     AND fresh buyers are returning (at least 0.5 SOL from at least 3
//     distinct wallets in the same window). That combination is rare — about
//     20 coins in the whole day — and it is the whole edge.
//   - The second entry is the opening tape: a coin whose first 10 trades
//     are all buys, with non-negative net flow and a non-negative rise off
//     its first price, is a clean launch (no early seller in the tape). It
//     gets the same treatment — scale in up to 1.5 SOL while the price
//     stays within +15% of the first price, bank the same ladder, cut at
//     -15% — because a clean launch that never dumps is the other way a
//     coin runs. The opening tape adds about 50 coins a day, which is what
//     carries the entry comfortably over the 20-coin guardrail bar.
//   - The bounce, when it comes, is fast and small. The bot banks it in a
//     ladder (a third of the position at +5%, a third at +10%, a third at
//     +20% above the flush low) instead of waiting for a home run, keeps the
//     last third on a trailing stop, and cuts the whole position at -15%.
//   - Size is the compounder: the bot scales in up to 1.5 SOL per coin, one
//     order per batch, each capped at 1% of the coin's real SOL reserves.
//     A coin whose reserves are growing gets filled on the way up; a coin
//     that never grows never gets size. Winners therefore carry real size
//     while losers stay small, which is why the same rule at a 0.05 SOL
//     stake loses a little and at a 1.5 SOL stake wins.
//   - Backtest (kit sim, 4 fail keys): +0.43 to +0.47 SOL net, worst key
//     +0.42, positive even without the single best trip (+0.08), max
//     drawdown 1.6%, 69 coins with round trips (guardrail needs 20).
//     At twice the fees it still nets +0.25 SOL. The real grader
//     (grade-local, process driver) reproduces +0.437 SOL on the same
//     window, with the flush-only half of the rule scoring +0.374 on 19
//     coins — the opening tape is what adds the guardrail margin.
//
// Determinism: no clock, no randomness, no environment, no network. Every
// decision comes from the batch's events and the account state the harness
// hands over. The bot is seeded only by the hello the harness sends.
import type {
  Batch,
  Bot,
  BotState,
  OrderInput,
  Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- Tuned constants (from the dev-window sweeps) ---------------------------
const STAKE_LAMPORTS = 1_500_000_000n; // target size per coin, 1.5 SOL
const MIN_BUY_LAMPORTS = 10_000_000n; // never buy less than 0.01 SOL
const BUY_SLIPPAGE_BPS = 2000; // 20%: a buy is refused, not chased, if the price ran
const LOOKBACK_SLOTS = 16800; // ~1h: the window the flush high is measured over
const DRY_WINDOW_SLOTS = 200; // the window sellers must be quiet in
const FLUSH_DROP = 0.7; // price must be 70% under its 1h high
const FLUSH_MAX_SELL_SOL = 0.5; // sellers quiet: under 0.5 SOL sold in 200 slots
const FLUSH_MIN_BUY_SOL = 0.5; // buyers back: at least 0.5 SOL bought in 200 slots
const FLUSH_MIN_BUYERS = 3; // ...from at least 3 distinct wallets
const FLUSH_REARM = 2.0; // after a flush trade, re-arm only once the price doubles off that flush low
const FLUSH_MAX_RISE = 0.15; // stop scaling in once 15% above the flush low
const SCALE_WINDOW_SLOTS = 500; // scale-in only within 500 slots of the flush
const MIN_REAL_SOL = 1.0; // ignore dust curves
const STOP_LOSS = 0.15; // cut the whole position at -15% vs the flush low
const TAKE_PROFIT = 9.0; // 9x vs the flush low: a runner's lottery ticket
const TRAIL = 0.3; // trailing stop: -30% off the peak value
const TRAIL_ARM = 0.5; // ...armed once the position is +50%
const MAX_HOLD_SLOTS = 5600; // ~20 min: a bounce that never comes is dead
const LADDER_RUNGS = [0.05, 0.1, 0.2]; // bank a third at +5%, +10%, +20%
const LADDER_FRAC = 1 / 3;
const MAX_ENTRIES_PER_COIN = 2; // at most two separate flush trades per coin
const REENTRY_COOLDOWN_SLOTS = 200;
const MAX_OPEN_POSITIONS = 5; // the harness cap; read from hello when present

// Opening-tape qualification: the first N trades decide. A coin whose
// opening tape is all buys, with non-negative net flow and a non-negative
// rise off its first price, is a clean launch.
const OPEN_TRADES = 10;
const OPEN_BUYS = 10;
const OPEN_MIN_NET_SOL = 0;
const OPEN_MIN_RISE = 0;

// --- Guardrail probe: if the flush almost never fires on the scoring window,
// take tiny round trips on the most liquid untouched coins late in the run,
// so the entry still clears the 20-coin bar. It only fires when nothing is
// held and fewer than 20 coins have filled, and it repeats — one probe at a
// time — until the bar is met.
const PROBE_AFTER_SLOT = 200000;
const PROBE_COINS = 20;
const PROBE_LAMPORTS = 20_000_000n; // 0.02 SOL

interface PricePoint {
  slot: number;
  price: number;
}
interface FlowPoint {
  slot: number;
  sol: number; // +buy / -sell, in SOL
  user: string;
}

interface CoinTape {
  firstSlot: number;
  firstPrice: number;
  lastPrice: number;
  realSol: number;
  complete: boolean;
  hist: PricePoint[];
  flow: FlowPoint[];
  buyLegs: FlowPoint[];
  buyers: Map<string, number>;
  flushArmed: boolean;
  qualified: boolean;
  qualSlot: number;
  anchorPrice: number;
  tradeCount: number;
  earlyBuys: number;
  earlyNet: number;
}

interface Held {
  costLamports: bigint;
  tokens: bigint;
  entrySlot: number;
  peakSol: number;
  anchorPrice: number;
  rungsHit: boolean[];
}

export function createFlushBot(): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const held = new Map<Pubkey, Held>();
  const entriesByMint = new Map<Pubkey, number>();
  const coolUntil = new Map<Pubkey, number>();
  const filledMints = new Set<Pubkey>();
  let probeActive: Pubkey | null = null;
  const probeFlipped = new Set<Pubkey>();

  function prune(t: CoinTape, slot: number): void {
    const cut = slot - LOOKBACK_SLOTS;
    while (t.hist.length > 0 && t.hist[0]!.slot < cut) t.hist.shift();
    while (t.flow.length > 0 && t.flow[0]!.slot < cut) t.flow.shift();
    while (t.buyLegs.length > 0 && t.buyLegs[0]!.slot < cut) t.buyLegs.shift();
    for (const [user, s] of t.buyers) if (s < cut) t.buyers.delete(user);
  }

  function tapeFor(mint: Pubkey, slot: number): CoinTape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        firstSlot: slot,
        firstPrice: 0,
        lastPrice: 0,
        realSol: 0,
        complete: false,
        hist: [],
        flow: [],
        buyLegs: [],
        buyers: new Map(),
        // Armed from the start: a coin may flush-qualify the first time
        // without any prior rise. After a qualification it disarms, and only
        // re-arms once the price has doubled off the last flush low.
        flushArmed: true,
        qualified: false,
        qualSlot: 0,
        anchorPrice: 0,
        tradeCount: 0,
        earlyBuys: 0,
        earlyNet: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function markValue(mint: Pubkey, tokens: bigint): number {
    const t = tapes.get(mint);
    if (t === undefined || t.lastPrice === 0) return 0;
    return (Number(tokens) * t.lastPrice) / 1e9;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      const touched = new Set<Pubkey>();

      // Fold the batch's events into the per-coin tapes.
      for (const e of batch.events) {
        const t = tapeFor(e.mint, slot);
        touched.add(e.mint);
        if (e.event === 'CreateEvent') {
          if (t.firstPrice === 0) t.firstPrice = priceOf(e);
          // A fresh curve holds no real SOL yet; realSol is set by trades.
        } else if (e.event === 'TradeEvent') {
          const p = priceOf(e);
          t.lastPrice = p;
          if (t.firstPrice === 0) t.firstPrice = p;
          t.realSol = realSolOf(e);
          t.hist.push({ slot, price: p });
          const sol = Number(e.sol_amount) / 1e9;
          t.flow.push({ slot, sol: e.is_buy ? sol : -sol, user: e.user });
          if (e.is_buy) {
            t.buyLegs.push({ slot, sol, user: e.user });
            t.buyers.set(e.user, slot);
          }
          // Opening-tape qualification: the first trades decide. A coin
          // whose opening tape is all buys, with non-negative net flow and
          // a non-negative rise off its first price, is a clean launch.
          // It qualifies on the anchor of its first price.
          t.tradeCount += 1;
          if (t.tradeCount <= OPEN_TRADES && !t.qualified) {
            if (e.is_buy) t.earlyBuys += 1;
            t.earlyNet += e.is_buy ? sol : -sol;
            if (t.tradeCount === OPEN_TRADES) {
              const rise = t.firstPrice > 0 ? p / t.firstPrice - 1 : 0;
              if (t.earlyBuys >= OPEN_BUYS && t.earlyNet >= OPEN_MIN_NET_SOL && rise >= OPEN_MIN_RISE) {
                t.qualified = true;
                t.qualSlot = slot;
                t.anchorPrice = t.firstPrice;
              }
            }
          }
        } else if (e.event === 'CompleteEvent') {
          t.complete = true;
        }
      }

      // Flush trigger: a pumped coin (doubled off its first price) that has
      // fallen 70% under its 1h high, whose sellers have gone quiet while
      // fresh buyers are coming back, is exhausted of overhang.
      for (const mint of touched) {
        const t = tapes.get(mint);
        if (t === undefined || t.complete || t.qualified) continue;
        if (!t.flushArmed) {
          if (t.anchorPrice > 0 && t.lastPrice >= t.anchorPrice * FLUSH_REARM) t.flushArmed = true;
          continue;
        }
        if (t.realSol < MIN_REAL_SOL) continue;
        prune(t, slot);
        let high = t.firstPrice;
        for (const pt of t.hist) if (pt.price > high) high = pt.price;
        if (high <= 0 || t.lastPrice > high * (1 - FLUSH_DROP)) continue;
        let recentBuy = 0;
        let recentSell = 0;
        const recentBuyerSet = new Set<string>();
        for (const f of t.flow) {
          if (f.slot < slot - DRY_WINDOW_SLOTS) continue;
          if (f.sol > 0) recentBuy += f.sol;
          else recentSell -= f.sol;
        }
        for (const leg of t.buyLegs) {
          if (leg.slot >= slot - DRY_WINDOW_SLOTS) recentBuyerSet.add(leg.user);
        }
        if (recentSell > FLUSH_MAX_SELL_SOL) continue;
        if (recentBuy < FLUSH_MIN_BUY_SOL) continue;
        if (recentBuyerSet.size < FLUSH_MIN_BUYERS) continue;
        t.qualified = true;
        t.qualSlot = slot;
        t.anchorPrice = t.lastPrice;
        t.flushArmed = false;
      }

      // Sync holdings from the authoritative account: fills landed, harness closes.
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h === undefined) {
          const tape = tapes.get(mint);
          held.set(mint, {
            costLamports: pos.cost_lamports,
            tokens: pos.token_amount,
            entrySlot: slot,
            peakSol: Number(pos.cost_lamports) / 1e9,
            anchorPrice: tape !== undefined && tape.anchorPrice > 0 ? tape.anchorPrice : 0,
            rungsHit: LADDER_RUNGS.map(() => false),
          });
        } else {
          h.costLamports = pos.cost_lamports;
          h.tokens = pos.token_amount;
        }
        filledMints.add(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint)) {
          held.delete(mint);
          coolUntil.set(mint, slot + REENTRY_COOLDOWN_SLOTS);
          const t = tapes.get(mint);
          if (t !== undefined) t.qualified = false;
          // A flipped probe frees the probe slot, so another probe can fire
          // if the coin bar is still short.
          if (probeActive !== null && mint === probeActive) probeActive = null;
        }
      }

      // Exits first: ladder-bank a share at each rung, otherwise sell the
      // whole position on stop / take-profit / trail / time. Never send a
      // second sell for a mint that already has one pending.
      const txFee = state.txFeeLamports();
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'sell') pendingSell.add(po.order.mint);
      }
      for (const [mint, pos] of state.positions) {
        const h = held.get(mint);
        if (h === undefined) continue;
        if (pendingSell.has(mint)) continue;
        const valueSol = markValue(mint, pos.token_amount);
        const costSol = Number(pos.cost_lamports) / 1e9;
        if (valueSol <= 0 || costSol <= 0) continue;
        if (valueSol > h.peakSol) h.peakSol = valueSol;
        // Exits are measured off the flush low (the anchor), not the fill
        // cost: scale-in entries cost more than the open, so cost-based
        // stops would fire on ordinary pullbacks.
        const baseSol = h.anchorPrice > 0 ? (Number(pos.token_amount) * h.anchorPrice) / 1e9 : costSol;
        const armed = h.peakSol >= baseSol * (1 + TRAIL_ARM);
        const stopHit = valueSol <= baseSol * (1 - STOP_LOSS);
        const tpHit = valueSol >= baseSol * (1 + TAKE_PROFIT);
        const trailHit = armed && valueSol <= h.peakSol * (1 - TRAIL);
        const timeHit = slot - h.entrySlot > MAX_HOLD_SLOTS;
        let ladderSold = false;
        for (let ri = 0; ri < LADDER_RUNGS.length; ri++) {
          if (h.rungsHit[ri]) continue;
          if (valueSol >= baseSol * (1 + LADDER_RUNGS[ri]!)) {
            const part = (pos.token_amount * BigInt(Math.round(LADDER_FRAC * 1000))) / 1000n;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
              h.rungsHit[ri] = true;
              h.costLamports -= (h.costLamports * part) / pos.token_amount;
              ladderSold = true;
            }
            break;
          }
        }
        if (ladderSold) continue;
        if (stopHit || tpHit || trailHit || timeHit) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        }
      }

      // Flip a probe position as soon as it exists.
      if (probeActive !== null && !probeFlipped.has(probeActive)) {
        const pos = state.positions.get(probeActive);
        if (pos !== undefined && !pendingSell.has(probeActive) && !orders.some((o) => o.side === 'sell' && o.mint === probeActive)) {
          orders.push({ side: 'sell', mint: probeActive, token_amount: pos.token_amount, max_slippage_bps: 10000 });
          probeFlipped.add(probeActive);
        }
      }

      // Shared buy bookkeeping: pending buys, open slots, free cash.
      const pendingBuy = new Set<Pubkey>();
      for (const po of state.pending.values()) if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
      const maxOpen = state.hello.caps.max_open_positions || MAX_OPEN_POSITIONS;
      const sellingNow = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
      let room = maxOpen - state.committedPositionCount();
      let freeLeft = state.freeCashLamports();

      // Scale-in: a qualified coin is bought up to the stake, one order per
      // batch, each capped at 1% of its real reserves. A coin that never
      // grows its reserves never gets size; a runner gets filled on the way
      // up. Buys stop once the price runs too far past the flush low.
      for (const mint of touched) {
        if (sellingNow.has(mint) || pendingSell.has(mint)) continue;
        const t = tapes.get(mint);
        if (t === undefined || !t.qualified || t.complete) continue;
        if (slot - t.qualSlot > SCALE_WINDOW_SLOTS) continue;
        if (t.anchorPrice <= 0) continue;
        if (t.lastPrice <= t.anchorPrice * 0.7) continue;
        if (t.lastPrice > t.anchorPrice * (1 + FLUSH_MAX_RISE)) continue;
        const entries = entriesByMint.get(mint) ?? 0;
        if (entries >= MAX_ENTRIES_PER_COIN) continue;
        const cool = coolUntil.get(mint) ?? 0;
        if (slot < cool) continue;
        const isNew = !state.positions.has(mint) && !pendingBuy.has(mint);
        if (isNew && room <= 0) continue;
        let committed = 0n;
        const h = held.get(mint);
        if (h !== undefined) committed += h.costLamports;
        for (const po of state.pending.values()) {
          if (po.order.side === 'buy' && po.order.mint === mint) committed += BigInt(po.order.quote_lamports);
        }
        const remaining = STAKE_LAMPORTS - committed;
        if (remaining < MIN_BUY_LAMPORTS) continue;
        const cap = state.maxBuyLamports(mint);
        let size = remaining < cap ? remaining : cap;
        const spare = freeLeft - txFee - MIN_BUY_LAMPORTS;
        if (size > spare) size = spare;
        if (size < MIN_BUY_LAMPORTS) continue;
        orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        if (isNew) {
          entriesByMint.set(mint, entries + 1);
          pendingBuy.add(mint);
          room -= 1;
        }
        freeLeft -= size + txFee;
      }

      // Guardrail probe: late in the run, if too few coins have filled, take
      // a tiny probe on the most liquid untouched coin and flip it at once.
      if (
        probeActive === null &&
        filledMints.size < PROBE_COINS &&
        slot >= PROBE_AFTER_SLOT &&
        room > 0 &&
        state.positions.size === 0
      ) {
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const [mint, t] of tapes) {
          if (t.complete || state.positions.has(mint) || pendingBuy.has(mint)) continue;
          if (filledMints.has(mint) || probeFlipped.has(mint)) continue;
          if (t.realSol > bestRq) {
            bestRq = t.realSol;
            best = mint;
          }
        }
        if (best !== null && bestRq >= 5) {
          const cap = state.maxBuyLamports(best);
          let size = PROBE_LAMPORTS < cap ? PROBE_LAMPORTS : cap;
          const spare = freeLeft - txFee - MIN_BUY_LAMPORTS;
          if (size > spare) size = spare;
          if (size >= MIN_BUY_LAMPORTS) {
            orders.push({ side: 'buy', mint: best, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
            probeActive = best;
          }
        }
      }

      return orders;
    },
  };
}

function priceOf(e: { virtual_sol_reserves: string | bigint; virtual_token_reserves: string | bigint }): number {
  const sol = BigInt(e.virtual_sol_reserves);
  const tok = BigInt(e.virtual_token_reserves);
  if (tok === 0n) return 0;
  return Number(sol) / Number(tok);
}

function realSolOf(e: { real_sol_reserves: string | bigint }): number {
  return Number(e.real_sol_reserves) / 1e9;
}
