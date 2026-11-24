// Volume-spike rider for the pump.fun bonding-curve replay
// (agent-fun/replay/v2).
//
// Most pump.fun curves are bundled launches that get dumped, and most replay
// entrants bleed out by overtrading them: every order pays ~1.25% curve fees
// plus a fixed tx fee, so churn is a guaranteed loss. This bot waits for a
// sudden buy-volume spike and rides only that: a coin becomes a buy when the
// buy SOL in the last few slots is a multiple of the buy SOL in the base
// window before it, the price is up on the spike but not vertically so, the
// buy side is broad (several distinct wallets, none dominant), and the curve
// sits in a sane real-reserve band. Entries are one-shot small stakes; every
// position carries a tight stop, a take-profit, a trailing stop, a fade exit
// and a time stop, so slots keep rotating and losers are cut fast.
//
// The guardrail bar is a round trip of at least 0.01 SOL on each of at least
// 20 coins with max drawdown at most 50%: until 20 round trips are banked the
// entry thresholds relax in tiers as the window progresses, at reduced size,
// so the bar is met without betting the account on weak coins late. A
// drawdown gate watches the whole account: past 15% down from the equity
// peak no new positions open, past 25% stops tighten, past 35% everything is
// flattened and trading stops for the run.
//
// Deterministic by construction: no clock, no randomness, no environment;
// iteration only over insertion-ordered maps fed by the batch stream, so the
// two grading executions agree byte for byte.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Spike window in slots: buy SOL here is compared with the base window. */
  spikeWindow: number;
  /** Base window in slots before the spike window. */
  baseWindow: number;
  /** Buy SOL in the spike window must be at least this multiple of the base. */
  minSpikeRatio: number;
  /** Distinct buying wallets in the spike window. */
  minBuyers: number;
  /** Largest single wallet's share of the spike window's buy SOL. */
  maxBuyerShare: number;
  /** Buy share of quote flow over the spike window, 0..1. */
  minBuyPressure: number;
  /** Price now over price at the spike window start, minus 1: at least this. */
  minPriceUp: number;
  /** ... and at most this: skip curves that already ran vertically. */
  maxPriceUp: number;
  /** Price now at least this share of the spike window's high. */
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
  /** Stop loss against cost (a fraction: 0.08 = sell at 92% of cost). */
  stopLoss: number;
  /** Tightened stop loss once the drawdown gate bites. */
  tightStopLoss: number;
  /** Take profit against cost (0.22 = sell at 122% of cost). */
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
  /** Distinct mints that must complete a round trip (the guardrail bar). */
  targetRoundTrips: number;
  /** A buy counts toward the round-trip bar only at 0.01 SOL or more. */
  minCountedBuySol: number;
  /** Fee discipline: never more than this many buys in the whole run. */
  maxTotalBuys: number;
}

// Tuned for the shape of the replay, not fitted to one window: the spike
// filter is the entry bar, the exits are tight by design, and the coverage
// tiers only relax the bar while the round-trip count is short. The numbers
// below are the starting point for the parent's grade-local run on the dev
// window; move them only on a measured dev-window win, never on a hunch.
export const DEFAULT_PARAMS: Params = {
  spikeWindow: 25,
  baseWindow: 150,
  minSpikeRatio: 2.5,
  minBuyers: 5,
  maxBuyerShare: 0.5,
  minBuyPressure: 0.6,
  minPriceUp: 0.03,
  maxPriceUp: 0.35,
  nearHigh: 0.9,
  minRqSol: 1.5,
  maxRqSol: 60,
  minAge: 60,
  minTrades: 15,
  stakeSol: 0.08,
  coverageStakeSol: 0.04,
  minStakeSol: 0.02,
  buySlipBps: 400,
  stopLoss: 0.08,
  tightStopLoss: 0.05,
  takeProfit: 0.22,
  trailArm: 0.1,
  trail: 0.08,
  fadeWindow: 20,
  fadeNetSol: 1.0,
  maxHold: 800,
  deadSlots: 600,
  cooldown: 150,
  maxEntries: 2,
  maxOpen: 5,
  maxExposureSol: 0.8,
  ddHalt: 0.15,
  ddTight: 0.25,
  ddExit: 0.35,
  targetRoundTrips: 20,
  minCountedBuySol: 0.01,
  maxTotalBuys: 400,
};

const LAMPORTS = 1e9;

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
}

/** Spot price of a curve as a double: quote lamports per raw token unit. */
function priceOf(vQuote: bigint, vToken: bigint): number {
  if (vToken <= 0n) return 0;
  return Number(vQuote) / Number(vToken);
}

/** Current marked value of a token amount on a curve, in lamports (bigint-exact). */
function valueOf(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n) return 0n;
  return (tokens * vQuote) / vToken;
}

/** Buy SOL and distinct buyers inside a slot window, from a tape's trades. */
function windowBuy(t: Tape, fromSlot: number, toSlot: number): { buySol: number; buyers: Set<string> } {
  let buySol = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= fromSlot || tr.slot > toSlot) continue;
    if (!tr.buy) continue;
    buySol += tr.sol;
    buyers.add(tr.user);
  }
  return { buySol, buyers };
}

/** Buy share of quote flow over the spike window, 0..1 (0.5 when no flow). */
function buyPressure(t: Tape, now: number, window: number): number {
  let buy = 0;
  let sell = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - window) break;
    if (tr.buy) buy += tr.sol;
    else sell += tr.sol;
  }
  const total = buy + sell;
  if (total <= 0) return 0.5;
  return buy / total;
}

/** Price change over the spike window, or null when history is too short. */
function windowMomentum(t: Tape, now: number, window: number): { up: number; nearHigh: number } | null {
  let startPrice = -1;
  let high = 0;
  let last = 0;
  let seen = 0;
  for (const tr of t.trades) {
    if (tr.slot <= now - window) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    if (tr.price > high) high = tr.price;
    last = tr.price;
    seen++;
  }
  if (seen < 2 || startPrice <= 0 || last <= 0 || high <= 0) return null;
  return { up: last / startPrice - 1, nearHigh: last / high };
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Total quote lamports this bot has spent buying each mint (fills only). */
  const boughtLamports = new Map<Pubkey, bigint>();
  /** Distinct mints that completed a round trip of at least the counted minimum. */
  const roundTripped = new Set<Pubkey>();
  /** Buys sent per mint, so one coin cannot churn the account. */
  const buysPerMint = new Map<Pubkey, number>();
  let firstSlot = -1;
  let totalBuys = 0;
  let peakEquity = 0n;
  /** Set once equity drawdown hits ddExit: everything is sold and no new orders open. */
  let stopped = false;
  const keep = p.baseWindow + p.spikeWindow + 5;
  const minCountedBuy = BigInt(Math.floor(p.minCountedBuySol * LAMPORTS));

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, firstSeen: -1, lastTradeSlot: -1, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now`, with the tier's thresholds. */
  const entrySignal = (
    t: Tape,
    now: number,
    rqSol: number,
    spikeRatio: number,
    minUp: number,
    pressureMin: number,
  ): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    if (t.trades.length < p.minTrades) return false;
    // A spike is a burst of buy SOL now against the base window before it.
    const spike = windowBuy(t, now - p.spikeWindow, now);
    const base = windowBuy(t, now - p.spikeWindow - p.baseWindow, now - p.spikeWindow);
    if (spike.buySol <= 0) return false;
    if (base.buySol > 0 && spike.buySol < spikeRatio * base.buySol) return false;
    if (base.buySol <= 0 && spike.buySol < p.minCountedBuySol * 5) return false;
    if (spike.buyers.size < p.minBuyers) return false;
    let top = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= now - p.spikeWindow || !tr.buy) continue;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    }
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * spike.buySol) return false;
    if (buyPressure(t, now, p.spikeWindow) < pressureMin) return false;
    const mom = windowMomentum(t, now, p.spikeWindow);
    if (mom === null) return false;
    if (mom.up < minUp || mom.up > p.maxPriceUp) return false;
    if (mom.nearHigh < p.nearHigh) return false;
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
          held.set(f.mint, { opened: f.slot, peakValue: 0, invested: Number(f.quote_lamports) / LAMPORTS, exiting: false, filled: true });
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

  /** Marked equity: cash plus every position at its curve's latest reserves. */
  const equityOf = (state: BotState): bigint => {
    let equity = state.cash;
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined) {
        equity += holding.cost_lamports;
        continue;
      }
      equity += valueOf(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
    }
    return equity;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const { caps } = state.hello;
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      // Slots since the window opened. The scored final window is 6 hours,
      // about 54,000 slots; the coverage tiers below are fractions of it.
      // On a longer dev window they trigger earlier, which is fine: they
      // only relax the entry bar while the round-trip count is short.
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

      const equity = equityOf(state);
      if (equity > peakEquity) peakEquity = equity;
      const drawdown = peakEquity > 0n ? Number(peakEquity - equity) / Number(peakEquity) : 0;
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
        const value = valueOf(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (value > BigInt(Math.floor(h.peakValue * LAMPORTS))) {
          h.peakValue = Number(value) / LAMPORTS;
        }
        const cost = Number(pos.cost_lamports);
        if (cost <= 0) continue;
        const costSol = cost / LAMPORTS;
        const ratio = Number(value) / cost;
        const heldFor = slot - h.opened;
        const t = tapeOf(mint);
        const goneQuiet =
          t.lastTradeSlot >= 0 && slot - t.lastTradeSlot >= p.deadSlots;
        const exit =
          ratio <= stopX ||
          ratio >= 1 + p.takeProfit ||
          (h.peakValue >= costSol * (1 + p.trailArm) &&
            Number(value) / LAMPORTS <= h.peakValue * (1 - p.trail)) ||
          flow(t, slot, p.fadeWindow) < -p.fadeNetSol ||
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

      // ------------------------------------------------------------ entries
      if (!halted && !stopped && totalBuys < p.maxTotalBuys) {
        const needCoverage = roundTripped.size < p.targetRoundTrips;
        // Coverage tiers relax as the window runs: past ~40% with the bar
        // unmet the bot takes weaker spikes at coverage size; past ~75% it
        // banks round trips on almost any live coin at the counted minimum.
        const lateCoverage = needCoverage && progress > Math.floor(finalWindowSlots * 0.4);
        const lastCoverage = needCoverage && progress > Math.floor(finalWindowSlots * 0.75);
        const spikeRatio = lastCoverage ? 1.2 : lateCoverage ? 1.8 : p.minSpikeRatio;
        const minUp = lastCoverage ? -0.02 : lateCoverage ? 0.0 : p.minPriceUp;
        const pressureMin = lastCoverage ? 0.5 : lateCoverage ? 0.55 : p.minBuyPressure;
        const stake = needCoverage ? p.coverageStakeSol : p.stakeSol;

        let free = state.freeCashLamports();
        const tx = state.txFeeLamports();
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
          if ((buysPerMint.get(mint) ?? 0) >= p.maxEntries) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (curve.trades < p.minTrades) continue;
          const t = tapeOf(mint);
          if (t.entries >= p.maxEntries || slot - t.lastExit < p.cooldown) continue;
          const born = curve.created_slot ?? t.created ?? t.firstSeen;
          if (born < 0 || slot - born < p.minAge) continue;
          const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
          if (!entrySignal(t, slot, rqSol, spikeRatio, minUp, pressureMin)) continue;
          const mom = windowMomentum(t, slot, p.spikeWindow);
          const pressure = buyPressure(t, slot, p.spikeWindow);
          candidates.push({ mint, score: (mom?.up ?? 0) * 2 + pressure });
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
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          buysPerMint.set(c.mint, (buysPerMint.get(c.mint) ?? 0) + 1);
          tapeOf(c.mint).entries++;
          totalBuys += 1;
          free -= amount + tx;
          exposure += amount;
          openSlots -= 1;
        }
      }

      return orders;
    },
  };
}
