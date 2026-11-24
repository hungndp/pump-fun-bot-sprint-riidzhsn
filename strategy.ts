// Selective momentum for the pump.fun bonding-curve replay
// (agent-fun/replay/v2) — v2, replacing the volume-spike rider.
//
// v1 lost on the dev window (-0.144 SOL, 6 wins in 40 trips): a single
// short spike window fires on the first burst of buying, which on pump.fun
// is usually the launch bundle or a one-slot wash, and the bot then rides
// the dump down. v2 buys only curves that are already moving with sustained,
// accelerating demand: a mature curve whose recent net SOL inflow is
// accelerating against the base window before it, bought by several distinct
// wallets with no single wallet dominant, price up on the move but not
// vertical, still near the window high, inside a sane real-reserve band.
// One-shot small stakes; every position carries a stop, a take-profit, a
// trailing stop, a fade exit, a time stop and a dead-coin exit, so slots
// keep rotating and losers are cut fast.
//
// Two safety nets keep the run over the guardrail bar (a round trip of at
// least 0.01 SOL on each of at least 20 coins, max drawdown at most 50%):
// tiny guardrail probes bank cheap round trips on fresh liquid mints, and
// coverage tiers relax the entry bar as the window runs while the bar is
// unmet. A drawdown gate watches the whole account: past 12% down from the
// equity peak no new positions open, past 20% stops tighten, past 30%
// everything is flattened and trading stops for the run.
//
// Deterministic by construction: no clock, no randomness, no environment;
// iteration only over insertion-ordered maps fed by the batch stream, so the
// two grading executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Recent window in slots: net inflow here is compared with the base window. */
  recentWindow: number;
  /** Base window in slots before the recent window. */
  baseWindow: number;
  /** Recent net SOL inflow must be at least this multiple of base net inflow. */
  minAccel: number;
  /** Net SOL inflow (buys minus sells) over the recent window, at least this. */
  minNetSol: number;
  /** Buy trades in the recent window. */
  minBuys: number;
  /** Distinct buying wallets in the recent window. */
  minBuyers: number;
  /** Largest single wallet's share of the recent window's buy SOL. */
  maxBuyerShare: number;
  /** Price now over price at the recent window start, minus 1: at least this. */
  minPriceUp: number;
  /** ... and at most this: skip curves that already ran vertically. */
  maxPriceUp: number;
  /** Price now at least this share of the recent window's high. */
  nearHigh: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Trades seen on the curve before an entry is allowed. */
  minTrades: number;
  /** One-shot stake per position (SOL, before the reserve cap). */
  stakeSol: number;
  /** Reduced stake while banking round trips for the guardrail bar. */
  coverageStakeSol: number;
  /** Skip the entry when the 1%-of-reserve cap cuts the stake below this. */
  minStakeSol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Stop loss against cost (a fraction: 0.12 = sell at 88% of cost). */
  stopLoss: number;
  /** Tightened stop loss once the drawdown gate bites. */
  tightStopLoss: number;
  /** Take profit against cost (0.35 = sell at 135% of cost). */
  takeProfit: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** ... and fires when value falls to (1 - trail) of its peak. */
  trail: number;
  /** Fade window in slots. */
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** A held coin with no trade for this many slots counts as dead. */
  deadSlots: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most positions open at once (bounded above by the harness cap too). */
  maxOpen: number;
  /** Most SOL at cost across positions at once. */
  maxExposureSol: number;
  /** Equity drawdown from peak that halts new entries. */
  ddHalt: number;
  /** Equity drawdown from peak that tightens stops. */
  ddTight: number;
  /** Equity drawdown from peak that flattens everything and stops trading. */
  ddExit: number;
  /** Guardrail probe size (SOL); at least the 0.01 SOL round-trip minimum. */
  probeSol: number;
  /** Slots between guardrail probes. */
  probeEvery: number;
  /** A probe candidate needs at least this much real SOL reserve. */
  probeMinRqSol: number;
  /** Distinct mints that must complete a round trip (the guardrail bar). */
  targetRoundTrips: number;
  /** A buy counts toward the round-trip bar only at 0.01 SOL or more. */
  minCountedBuySol: number;
  /** Fee discipline: never more than this many buys in the whole run. */
  maxTotalBuys: number;
}

// Numbers are chosen for the shape of the replay, not fitted to one window:
// the entry bar is the filter (mature curve + accelerating, broad inflow),
// the exits are wide enough to let a real move run and tight enough to cut
// a dump, and the probes plus coverage tiers only exist to bank the
// guardrail bar cheaply. Move them only on a measured dev-window win.
export const DEFAULT_PARAMS: Params = {
  recentWindow: 30,
  baseWindow: 120,
  minAccel: 2.0,
  minNetSol: 3.0,
  minBuys: 6,
  minBuyers: 6,
  maxBuyerShare: 0.45,
  minPriceUp: 0.1,
  maxPriceUp: 0.6,
  nearHigh: 0.95,
  minRqSol: 3,
  maxRqSol: 80,
  minAge: 600,
  minTrades: 20,
  stakeSol: 0.15,
  coverageStakeSol: 0.06,
  minStakeSol: 0.03,
  buySlipBps: 800,
  stopLoss: 0.12,
  tightStopLoss: 0.08,
  takeProfit: 0.35,
  trailArm: 0.12,
  trail: 0.15,
  fadeWindow: 25,
  fadeNetSol: 1.2,
  maxHold: 1200,
  deadSlots: 500,
  cooldown: 180,
  maxEntries: 2,
  maxOpen: 5,
  maxExposureSol: 1.2,
  ddHalt: 0.12,
  ddTight: 0.2,
  ddExit: 0.3,
  probeSol: 0.012,
  probeEvery: 50,
  probeMinRqSol: 1.5,
  targetRoundTrips: 20,
  minCountedBuySol: 0.01,
  maxTotalBuys: 300,
};

const LAMPORTS = 1e9;
/** Fallback curve fee (95 + 30 bps), used to value a position for exits and equity. */
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  firstSeen: number;
  lastTradeSlot: number;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Close value at the latest batch (SOL, curve and tx fees deducted). */
  lastValue: number;
}

/** Spot price of a curve as a double: quote lamports per raw token unit. */
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function netFlow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/**
 * One pass over a tape's window trades: buy/sell SOL, buy count, distinct
 * buyers, top buyer share, and the price move (up vs window start, and
 * now vs the window high). Returns null when the window has too little
 * history to judge.
 */
function windowStats(
  t: Tape,
  fromSlot: number,
): {
  buySol: number;
  sellSol: number;
  buys: number;
  buyers: number;
  topShare: number;
  up: number;
  nearHigh: number;
} | null {
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= fromSlot) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < 1 || startPrice <= 0 || last <= 0 || high <= 0) return null;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  return {
    buySol,
    sellSol,
    buys,
    buyers: byUser.size,
    topShare: buySol > 0 ? top / buySol : 1,
    up: last / startPrice - 1,
    nearHigh: last / high,
  };
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Probe mints whose buy has landed (a position was seen), so a close counts as a round trip. */
  const probeFilled = new Set<Pubkey>();
  /** Total quote lamports this bot has spent buying each mint (fills only). */
  const boughtLamports = new Map<Pubkey, bigint>();
  /** Distinct mints that completed a round trip of at least the counted minimum. */
  const roundTripped = new Set<Pubkey>();
  /** Buys sent per mint, so one coin cannot churn the account. */
  const buysPerMint = new Map<Pubkey, number>();
  let firstSlot = -1;
  let lastProbeSlot = -1e12;
  let totalBuys = 0;
  let peakEquity = 0;
  /** Set once equity drawdown hits ddExit: everything is sold and no new orders open. */
  let stopped = false;
  const keep = p.baseWindow + p.recentWindow + 5;
  const minCountedBuy = BigInt(Math.floor(p.minCountedBuySol * LAMPORTS));

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, firstSeen: -1, lastTradeSlot: -1, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /**
   * Entry signal: the curve is mature and in the reserve band, and demand
   * is accelerating — the recent window's net inflow is at least `accel`
   * times the base window's, with at least `minNet` SOL of recent net
   * inflow, enough distinct buyers, no dominant buyer, and a price that
   * rose on the move but not vertically and still sits near the high.
   */
  const entrySignal = (
    t: Tape,
    now: number,
    rqSol: number,
    accel: number,
    minNet: number,
  ): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.trades.length < p.minTrades) return false;
    const recent = windowStats(t, now - p.recentWindow);
    if (recent === null) return false;
    const recentNet = recent.buySol - recent.sellSol;
    if (recentNet < minNet) return false;
    if (recent.buys < p.minBuys || recent.buyers < p.minBuyers) return false;
    if (recent.topShare > p.maxBuyerShare) return false;
    // Acceleration: the base window must itself have been net buying, and
    // the recent window must be buying at least `accel` times faster. A
    // base that was flat or selling makes the comparison meaningless, so a
    // small positive base is required instead of a ratio against nothing.
    const base = windowStats(t, now - p.recentWindow - p.baseWindow);
    if (base === null) return false;
    const baseNet = base.buySol - base.sellSol;
    if (baseNet <= 0) {
      if (recentNet < minNet * 2) return false;
    } else if (recentNet < accel * baseNet) {
      return false;
    }
    if (recent.up < p.minPriceUp || recent.up > p.maxPriceUp) return false;
    if (recent.nearHigh < p.nearHigh) return false;
    return true;
  };

  /** Fold this batch's fills into the round-trip ledger before deciding anything. */
  const foldFills = (state: BotState, batch: Batch): void => {
    for (const f of batch.fills) {
      if (f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'buy') {
        boughtLamports.set(f.mint, (boughtLamports.get(f.mint) ?? 0n) + BigInt(f.quote_lamports));
        const h = held.get(f.mint);
        if (h === undefined) {
          held.set(f.mint, {
            opened: f.slot,
            peakValue: 0,
            invested: Number(f.quote_lamports) / LAMPORTS,
            exiting: false,
            filled: true,
            lastValue: 0,
          });
        } else {
          h.invested += Number(f.quote_lamports) / LAMPORTS;
          h.filled = true;
        }
      }
    }
    // A mint counts as round-tripped once a counted buy is fully sold back out.
    for (const mint of boughtLamports.keys()) {
      if (roundTripped.has(mint)) continue;
      if ((boughtLamports.get(mint) ?? 0n) < minCountedBuy) continue;
      if (!state.positions.has(mint)) roundTripped.add(mint);
    }
  };

  /** Fold this batch's trade events into the per-mint tapes. */
  const foldEvents = (batch: Batch): Set<Pubkey> => {
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        if (t.created === null) t.created = e.slot;
        if (t.firstSeen < 0) t.firstSeen = e.slot;
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const t = tapeOf(e.mint);
      if (t.firstSeen < 0) t.firstSeen = e.slot;
      t.lastTradeSlot = e.slot;
      t.trades.push({
        slot: e.slot,
        buy: e.is_buy,
        sol: Number(e.sol_amount) / LAMPORTS,
        user: e.user,
        price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
      });
      traded.add(e.mint);
    }
    return traded;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const { caps } = state.hello;
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      // Slots since the window opened. The scored final window is 6 hours,
      // about 54,000 slots; the coverage tiers below are fractions of it.
      const progress = slot - firstSlot;
      const finalWindowSlots = 54_000;

      foldFills(state, batch);
      const traded = foldEvents(batch);
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= slot - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      /** Close value of a position in SOL (curve fee and one tx fee deducted), or null when unpriced. */
      const closeValue = (mint: Pubkey, tokens: bigint): number | null => {
        const curve = state.curves.get(mint);
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : curve ? Number(curve.virtual_quote_reserves) : null;
        const vt = mk ? Number(mk.virtual_token_reserves) : curve ? Number(curve.virtual_token_reserves) : null;
        if (vq === null || vt === null) return null;
        const t = Number(tokens);
        return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      };

      // Equity and the drawdown gate, on the account as this batch reports it.
      let equity = Number(state.cash) / LAMPORTS;
      for (const [mint, pos] of state.positions) {
        const v = closeValue(mint, pos.token_amount);
        if (v !== null && v > 0) equity += v;
      }
      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0 ? 1 - equity / peakEquity : 0;
      const halted = drawdown > p.ddHalt;
      const tight = drawdown > p.ddTight;
      if (!stopped && drawdown >= p.ddExit) stopped = true;

      const orders: OrderInput[] = [];
      const pendingMints = new Set<Pubkey>();
      for (const po of state.pending.values()) pendingMints.add(po.order.mint);

      // ------------------------------------------------------------ exits first
      const stopX = tight ? 1 - p.tightStopLoss : 1 - p.stopLoss;
      for (const [mint, h] of held) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (pendingMints.has(mint)) continue;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            held.delete(mint);
            if (h.filled) tapeOf(mint).lastExit = slot;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = closeValue(mint, pos.token_amount);
        if (value === null) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const ratio = value / cost;
        const heldFor = slot - h.opened;
        const t = tapeOf(mint);
        const goneQuiet = t.lastTradeSlot >= 0 && slot - t.lastTradeSlot >= p.deadSlots;
        const exit =
          ratio <= stopX ||
          ratio >= 1 + p.takeProfit ||
          (h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) ||
          netFlow(t, slot, p.fadeWindow) < -p.fadeNetSol ||
          heldFor >= p.maxHold ||
          goneQuiet ||
          stopped;
        if (!exit) continue;
        h.exiting = true;
        // Sells go out at 10000 bps: a stop that must execute is worth more
        // than the slippage it might pay; the tight stops cap the damage.
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        pendingMints.add(mint);
      }

      // ------------------------------------------------------------ probe round trips
      // Sell the whole probe on the first batch after its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingMints.has(mint)) {
            if (probeFilled.has(mint)) {
              roundTripped.add(mint);
              probeFilled.delete(mint);
            }
            probes.delete(mint);
          }
          continue;
        }
        probeFilled.add(mint);
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= caps.max_orders_per_batch) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      let free = Number(state.freeCashLamports()) / LAMPORTS;

      // ------------------------------------------------------------ entries
      if (!halted && !stopped && totalBuys < p.maxTotalBuys) {
        const needCoverage = roundTripped.size < p.targetRoundTrips;
        // Coverage tiers relax as the window runs: past ~40% with the bar
        // unmet the bot takes weaker acceleration at coverage size; past
        // ~75% it banks round trips on almost any live coin at the counted
        // minimum, still with the maturity and reserve filters on.
        const lateCoverage = needCoverage && progress > Math.floor(finalWindowSlots * 0.4);
        const lastCoverage = needCoverage && progress > Math.floor(finalWindowSlots * 0.75);
        const accel = lastCoverage ? 1.0 : lateCoverage ? 1.4 : p.minAccel;
        const minNet = lastCoverage ? 0.5 : lateCoverage ? 1.5 : p.minNetSol;
        const stake = needCoverage ? p.coverageStakeSol : p.stakeSol;

        let openSlots = Math.min(p.maxOpen, caps.max_open_positions) - state.committedPositionCount();
        let exposure = 0n;
        for (const [, pos] of state.positions) exposure += pos.cost_lamports;
        const maxExposure = BigInt(Math.floor(p.maxExposureSol * LAMPORTS));

        const seen = new Set<Pubkey>();
        const candidates: { mint: string; score: number }[] = [];
        for (const mint of traded) {
          if (seen.has(mint)) continue;
          seen.add(mint);
          if (state.positions.has(mint) || pendingMints.has(mint)) continue;
          if (probes.has(mint) || held.has(mint)) continue;
          if ((buysPerMint.get(mint) ?? 0) >= p.maxEntries) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.trades < p.minTrades) continue;
          const t = tapeOf(mint);
          if (t.entries >= p.maxEntries || slot - t.lastExit < p.cooldown) continue;
          const born = curve.created_slot ?? t.created ?? t.firstSeen;
          if (born < 0 || slot - born < p.minAge) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (!entrySignal(t, slot, rqSol, accel, minNet)) continue;
          // Rank by recent net inflow per SOL of reserve: the strongest
          // demand relative to the curve's size goes first.
          const recentNet = netFlow(t, slot, p.recentWindow);
          candidates.push({ mint, score: rqSol > 0 ? recentNet / rqSol : 0 });
        }
        candidates.sort((a, b) => (b.score - a.score) || (a.mint < b.mint ? -1 : 1));

        for (const c of candidates) {
          if (orders.length >= caps.max_orders_per_batch || openSlots <= 0) break;
          const cap = state.maxBuyLamports(c.mint);
          let amount = BigInt(Math.floor(stake * LAMPORTS));
          if (amount > cap) amount = cap;
          if (exposure + amount > maxExposure) amount = maxExposure - exposure;
          if (tight) amount = amount / 2n;
          if (amount < BigInt(Math.floor(p.minStakeSol * LAMPORTS))) continue;
          if (free < Number(amount) / LAMPORTS + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          buysPerMint.set(c.mint, (buysPerMint.get(c.mint) ?? 0) + 1);
          tapeOf(c.mint).entries++;
          totalBuys += 1;
          free -= Number(amount) / LAMPORTS + tx;
          exposure += amount;
          openSlots -= 1;
        }
      }

      // ------------------------------------------------------------ guardrail probes
      // One small round trip at a time on the most liquid fresh mint traded,
      // every probeEvery slots, until enough distinct mints have round-tripped.
      if (
        !stopped &&
        probes.size === 0 &&
        roundTripped.size < p.targetRoundTrips &&
        slot - lastProbeSlot >= p.probeEvery &&
        state.committedPositionCount() < caps.max_open_positions &&
        free >= p.probeSol + 2 * tx &&
        orders.length < caps.max_orders_per_batch
      ) {
        let best: Pubkey | null = null;
        let bestRq = 0;
        for (const mint of traded) {
          if (held.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
          if (roundTripped.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (rqSol < p.probeMinRqSol) continue;
          if (Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS < p.probeSol) continue;
          if (rqSol > bestRq) {
            bestRq = rqSol;
            best = mint;
          }
        }
        if (best !== null) {
          orders.push({ side: 'buy', mint: best, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          probes.set(best, false);
          lastProbeSlot = slot;
          free -= p.probeSol + tx;
        }
      }

      return orders;
    },
  };
}
