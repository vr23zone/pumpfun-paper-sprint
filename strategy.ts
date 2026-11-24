// Dip-Buy Reversion + Fast Scalp — pump.fun paper sprint bot.
// Single entry per coin, no pyramiding, no adds. Exits and probe pacing
// are added in the second staged write below (see onBatch).
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

export const LAMPORTS_PER_SOL = 1_000_000_000;

export const PARAMS = {
  // Entry A — dip buy after a run-up and pullback.
  dipMinAgeSlots: 300,
  dipRunupPct: 0.35, // V8: tighten A only (B is the better leg: 37% WR vs 23%)
  dipPullbackPct: 0.15, // price <= high60 * (1 - pullback)
  dipNetSol30: 0.5, // net SOL bought over last 30 slots
  dipNetSol15Min: 0, // buying must still be flowing over the last 15 slots
  dipBuys30: 5, // buys in last 30 slots
  dipMinBuyers: 8,
  dipMinRealSol: 3,
  dipMaxRealSol: 60,
  dipBuySol: 0.05,
  // Entry B — oversold bounce / higher low forming.
  bounceMinAgeSlots: 120,
  bounceDropPct: 0.2, // price <= high60 * (1 - drop)
  bounceConfirmPct: 0, // price must already be >= low15 * (1 + confirm)
  bounceNetSol15Min: 0, // net SOL over the last 15 slots
  bounceMinRealSol: 2,
  bounceMinBuyers: 5,
  bounceBuySol: 0.05,
  // Exits (filled in by stage 2; values here are the tuned defaults).
  // V5: back to the brief's exits (TP 1.18 / SL 0.88), V3 trailing kept.
  takeProfitMult: 1.18,
  stopLossMult: 0.88,
  trailArmMult: 1.1,
  trailDropPct: 0.2, // exit when value < peak * (1 - trailDropPct)
  maxHoldSlots: 900,
  fadeNetSol15: -0.5, // V5 value: -2.0 let trades bleed to SL instead (V6 worse)
  bigSellSol: 5,
  cooldownSlots: 150,
  // Risk / pacing.
  maxOpenPositions: 5,
  maxExposureSol: 5,
  probeBuySol: 0.01,
  probeMinRealSol: 0.015,
  maxProbes: 30, // hard cap on probe round trips per run
  paceCoins: 22,
  paceFills: 200,
  paceWindowSec: 14400,
  paceMinFrac: 0.25, // do not probe before 25% of the pace window has elapsed
  buySlippageBps: 1500,
  sellSlippageBps: 10000,
  maxNewBuysPerBatch: 3,
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number; // SOL amount of the trade
  user: string;
  price: number; // virtual_quote / virtual_token after the trade
}

interface CurveTape {
  mint: string;
  createdSlot: number;
  firstSeenSlot: number;
  firstPrice: number; // price of the first recorded trade, 0 until seen
  trades: TapeTrade[];
  buyers: Set<string>;
  enteredOnce: boolean; // a strategy buy filled on this curve
  lastExitSlot: number; // -1 until an exit fills
  lastAttemptSlot: number; // last slot we sent a buy for this curve
}

interface PosInfo {
  mint: string;
  entryPrice: number;
  investedLamports: number;
  openedSlot: number;
  peakLamports: number;
  exiting: boolean;
  probe: boolean;
  kind: 'A' | 'B' | 'probe';
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

function solOf(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function createStrategy() {
  const tapes = new Map<string, CurveTape>();
  const positions = new Map<string, PosInfo>();
  const pendingBuys = new Map<string, { mint: string; probe: boolean; kind: 'A' | 'B' | 'probe' }>();
  const pendingSells = new Map<string, string>(); // mint -> exit reason in flight
  const coinsTraded = new Set<string>();
  const stats = {
    entriesA: 0,
    entriesB: 0,
    probesSent: 0,
    probesFilled: 0,
    exits: {} as Record<string, number>,
    buyFills: 0,
    sellFills: 0,
    // Realized PnL (lamports, net of fill-time quote) by entry kind.
    pnlA: 0,
    pnlB: 0,
    pnlProbe: 0,
    winsA: 0,
    winsB: 0,
    winsProbe: 0,
  };
  let fillsCount = 0;
  let firstBlockTime = 0;
  let latestBlockTime = 0;
  let probeMint: string | null = null;
  let probeStage: 'idle' | 'buySent' | 'buyFilled' = 'idle';

  function tapeFor(mint: string, slot: number): CurveTape {
    let t = tapes.get(mint);
    if (!t) {
      t = {
        mint,
        createdSlot: slot,
        firstSeenSlot: slot,
        firstPrice: 0,
        trades: [],
        buyers: new Set<string>(),
        enteredOnce: false,
        lastExitSlot: -1,
        lastAttemptSlot: -1,
      };
      tapes.set(mint, t);
    }
    return t;
  }

  function prune(t: CurveTape, slot: number): void {
    // Longest lookback used is 60 slots; keep 5 extra.
    const cutoff = slot - 65;
    if (t.trades.length > 0 && t.trades[0].slot < cutoff) {
      let i = 0;
      while (i < t.trades.length && t.trades[i].slot < cutoff) i++;
      if (i > 0) t.trades.splice(0, i);
    }
  }

  function windowStats(t: CurveTape, slot: number, span: number) {
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    let netSol = 0;
    let buys = 0;
    let seen = 0;
    const from = slot - span;
    for (const tr of t.trades) {
      if (tr.slot < from) continue;
      seen++;
      if (tr.price > high) high = tr.price;
      if (tr.price < low) low = tr.price;
      netSol += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buys++;
    }
    return { high, low: seen > 0 ? low : 0, netSol, buys, seen };
  }

  // ---- fills: keep intent state in step with the reported account ----
  function applyFills(state: BotState, batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status === 'filled') fillsCount++;
      const isHarnessClose =
        f.client_id.startsWith('_complete_') ||
        f.client_id.startsWith('_flatten_') ||
        f.client_id.startsWith('_writeoff_');
      if (isHarnessClose) {
        const p = positions.get(f.mint);
        if (p) {
          const t = tapes.get(f.mint);
          if (t) t.lastExitSlot = f.slot;
          stats.exits.complete = (stats.exits.complete ?? 0) + 1;
          positions.delete(f.mint);
          pendingSells.delete(f.mint);
          if (probeMint === f.mint) {
            probeMint = null;
            probeStage = 'idle';
          }
        }
        continue;
      }
      const pb = pendingBuys.get(f.client_id);
      if (pb) {
        pendingBuys.delete(f.client_id);
        if (f.status === 'filled') {
          stats.buyFills++;
          if (pb.kind === 'A') stats.entriesA++;
          else if (pb.kind === 'B') stats.entriesB++;
          else stats.probesFilled++;
          coinsTraded.add(f.mint);
          const curve = state.curves.get(f.mint);
          const px = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
          const t = tapeFor(f.mint, f.slot);
          t.enteredOnce = true;
          positions.set(f.mint, {
            mint: f.mint,
            entryPrice: px,
            investedLamports: Number(f.quote_lamports),
            openedSlot: f.slot,
            peakLamports: Number(f.quote_lamports),
            exiting: false,
            probe: pb.probe,
            kind: pb.kind,
          });
          if (pb.probe) probeStage = 'buyFilled';
        } else if (pb.probe) {
          // Probe buy rejected/failed: release the probe slot so we can retry.
          if (probeMint === f.mint) {
            probeMint = null;
            probeStage = 'idle';
          }
        }
        continue;
      }
      if (f.side === 'sell' && f.status !== 'filled') {
        // Sell rejected/failed: clear the in-flight flag so we can retry.
        const p = positions.get(f.mint);
        if (p) p.exiting = false;
        pendingSells.delete(f.mint);
        continue;
      }
      if (f.side === 'sell' && f.status === 'filled') {
        stats.sellFills++;
        const reason = pendingSells.get(f.mint) ?? 'unknown';
        stats.exits[reason] = (stats.exits[reason] ?? 0) + 1;
        const p = positions.get(f.mint);
        if (p) {
          const pnl = Number(f.quote_lamports) - p.investedLamports;
          if (p.probe) {
            stats.pnlProbe += pnl;
            if (pnl > 0) stats.winsProbe++;
          } else if (p.kind === 'A') {
            stats.pnlA += pnl;
            if (pnl > 0) stats.winsA++;
          } else {
            stats.pnlB += pnl;
            if (pnl > 0) stats.winsB++;
          }
        }
        if (p) {
          const t = tapes.get(f.mint);
          if (t) t.lastExitSlot = f.slot;
          positions.delete(f.mint);
          pendingSells.delete(f.mint);
          if (probeMint === f.mint) {
            probeMint = null;
            probeStage = 'idle';
          }
        }
      }
    }
    // Drop PosInfo for positions the account no longer holds (completed/flattened).
    for (const mint of [...positions.keys()]) {
      if (!state.positions.has(mint)) {
        const t = tapes.get(mint);
        if (t && t.lastExitSlot < 0) t.lastExitSlot = batch.slot;
        positions.delete(mint);
        pendingSells.delete(mint);
        if (probeMint === mint) {
          probeMint = null;
          probeStage = 'idle';
        }
      }
    }
  }

  // ---- events: build tapes ----
  function applyEvents(state: BotState, batch: Batch): void {
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === 0) firstBlockTime = e.block_time;
        latestBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = tapeFor(e.mint, e.slot);
        t.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeFor(e.mint, e.slot);
        const px = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
        if (t.firstPrice === 0) t.firstPrice = px;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol: solOf(BigInt(e.sol_amount)),
          user: e.user,
          price: px,
        });
        if (e.is_buy) t.buyers.add(e.user);
        prune(t, e.slot);
      }
    }
    // Curves seen only via marks still need a tape for probe candidates.
    for (const m of batch.marks) {
      tapeFor(m.mint, m.slot);
    }
  }

  // ---- entries ----
  function entryA(state: BotState, t: CurveTape, slot: number): boolean {
    const P = PARAMS;
    const age = slot - t.createdSlot;
    if (age < P.dipMinAgeSlots) return false;
    if (t.firstPrice <= 0 || t.trades.length === 0) return false;
    const curve = state.curves.get(t.mint);
    if (!curve || curve.complete) return false;
    const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (px <= 0) return false;
    if (px < t.firstPrice * (1 + P.dipRunupPct)) return false;
    const w60 = windowStats(t, slot, 60);
    if (w60.seen === 0) return false;
    if (px > w60.high * (1 - P.dipPullbackPct)) return false;
    const w30 = windowStats(t, slot, 30);
    if (w30.netSol < P.dipNetSol30) return false;
    if (w30.buys < P.dipBuys30) return false;
    if (t.buyers.size < P.dipMinBuyers) return false;
    const realSol = solOf(curve.real_quote_reserves);
    if (realSol < P.dipMinRealSol || realSol > P.dipMaxRealSol) return false;
    return true;
  }

  function entryB(state: BotState, t: CurveTape, slot: number): boolean {
    const P = PARAMS;
    const age = slot - t.createdSlot;
    if (age < P.bounceMinAgeSlots) return false;
    if (t.firstPrice <= 0 || t.trades.length === 0) return false;
    const curve = state.curves.get(t.mint);
    if (!curve || curve.complete) return false;
    const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (px <= 0) return false;
    const w60 = windowStats(t, slot, 60);
    if (w60.seen === 0) return false;
    if (px > w60.high * (1 - P.bounceDropPct)) return false;
    const w15 = windowStats(t, slot, 15);
    if (w15.seen === 0) return false;
    // Price back above the low of the last 15 slots: a higher low is forming,
    // and it must already have bounced off that low (confirmation, not hope).
    if (px <= w15.low * (1 + P.bounceConfirmPct)) return false;
    if (w15.netSol < P.bounceNetSol15Min) return false;
    if (t.buyers.size < P.bounceMinBuyers) return false;
    const realSol = solOf(curve.real_quote_reserves);
    if (realSol < P.bounceMinRealSol) return false;
    return true;
  }

  function canBuy(state: BotState, t: CurveTape, slot: number): boolean {
    if (t.enteredOnce) return false;
    if (t.lastExitSlot >= 0 && slot - t.lastExitSlot < PARAMS.cooldownSlots) return false;
    if (slot - t.lastAttemptSlot < 10) return false;
    if (positions.has(t.mint)) return false;
    if (pendingBuys.size > 0 && [...pendingBuys.values()].some((p) => p.mint === t.mint)) return false;
    return true;
  }

  function currentExposureSol(): number {
    let s = 0;
    for (const p of positions.values()) s += p.investedLamports / LAMPORTS_PER_SOL;
    return s;
  }

  // ---- exits: whole position, one clean exit per position ----
  function positionValueLamports(state: BotState, p: PosInfo): number {
    const curve = state.curves.get(p.mint);
    if (!curve) return 0;
    const px = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (px <= 0 || p.entryPrice <= 0) return 0;
    const holding = state.positions.get(p.mint);
    if (!holding) return 0;
    // value = tokens * current price (lamports per token unit cancels via ratio).
    return Number(holding.token_amount) * px;
  }

  function shouldExit(state: BotState, p: PosInfo, slot: number): string | null {
    const P = PARAMS;
    const value = positionValueLamports(state, p);
    const cost = p.investedLamports;
    if (value <= 0 || cost <= 0) return null;
    if (value >= cost * P.takeProfitMult) return 'tp';
    if (value < cost * P.stopLossMult) return 'sl';
    if (value > p.peakLamports) p.peakLamports = value;
    if (value >= cost * P.trailArmMult && value < p.peakLamports * (1 - P.trailDropPct)) return 'trail';
    if (slot - p.openedSlot > P.maxHoldSlots && value < cost * P.trailArmMult) return 'time';
    const t = tapes.get(p.mint);
    if (t) {
      const w15 = windowStats(t, slot, 15);
      if (w15.netSol < P.fadeNetSol15) return 'fade';
      // Any single recorded sell >= bigSellSol since we opened.
      for (const tr of t.trades) {
        if (tr.slot > p.openedSlot && !tr.buy && tr.sol >= P.bigSellSol) return 'bigsell';
      }
    }
    return null;
  }

  // ---- probe pacing: keep the run above the guardrail pace ----
  function paceLagging(): boolean {
    if (firstBlockTime === 0 || latestBlockTime <= firstBlockTime) return false;
    const elapsed = latestBlockTime - firstBlockTime;
    const frac = Math.min(1, elapsed / PARAMS.paceWindowSec);
    if (frac < PARAMS.paceMinFrac) return false;
    // Coins only: fills follow from round trips. Probing for fills alone
    // overshoots (each probe is 2 fills) and bleeds fees.
    const needCoins = PARAMS.paceCoins * frac;
    return coinsTraded.size < needCoins;
  }

  function maybeProbe(state: BotState, slot: number, orders: OrderInput[]): void {
    if (probeStage !== 'idle' || probeMint !== null) return;
    if (stats.probesSent >= PARAMS.maxProbes) return;
    if (!paceLagging()) return;
    if (state.committedPositionCount() >= PARAMS.maxOpenPositions) return;
    const amount = BigInt(Math.round(PARAMS.probeBuySol * LAMPORTS_PER_SOL));
    if (state.freeCashLamports() < amount + state.txFeeLamports()) return;
    // Pick the most liquid curve with no position and no entry history first.
    let best: CurveTape | null = null;
    let bestReal = 0;
    for (const t of tapes.values()) {
      const curve = state.curves.get(t.mint);
      if (!curve || curve.complete) continue;
      if (positions.has(t.mint)) continue;
      if (t.enteredOnce) continue;
      const realSol = solOf(curve.real_quote_reserves);
      if (realSol < PARAMS.probeMinRealSol) continue;
      if (state.maxBuyLamports(t.mint) < amount) continue;
      if (realSol > bestReal) {
        bestReal = realSol;
        best = t;
      }
    }
    if (!best) return;
    const cid = state.clientId();
    pendingBuys.set(cid, { mint: best.mint, probe: true, kind: 'probe' });
    stats.probesSent++;
    best.lastAttemptSlot = slot;
    probeMint = best.mint;
    probeStage = 'buySent';
    orders.push({
      side: 'buy',
      client_id: cid,
      mint: best.mint,
      quote_lamports: amount,
      max_slippage_bps: PARAMS.buySlippageBps,
    });
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    applyFills(state, batch);
    applyEvents(state, batch);
    const orders: OrderInput[] = [];
    const slot = batch.slot;

    // 1) Exits first: whole position, never duplicate a sell in flight.
    for (const p of [...positions.values()]) {
      if (p.exiting || pendingSells.has(p.mint)) continue;
      const holding = state.positions.get(p.mint);
      if (!holding) continue;
      if (p.probe) {
        // Probe: sell the whole position as soon as the buy has landed.
        if (probeStage === 'buyFilled' && probeMint === p.mint) {
          p.exiting = true;
          pendingSells.set(p.mint, 'probe');
          orders.push({
            side: 'sell',
            client_id: state.clientId(),
            mint: p.mint,
            token_amount: holding.token_amount,
            max_slippage_bps: PARAMS.sellSlippageBps,
          });
        }
        continue;
      }
      const reason = shouldExit(state, p, slot);
      if (reason !== null) {
        p.exiting = true;
        pendingSells.set(p.mint, reason);
        orders.push({
          side: 'sell',
          client_id: state.clientId(),
          mint: p.mint,
          token_amount: holding.token_amount,
          max_slippage_bps: PARAMS.sellSlippageBps,
        });
      }
    }

    // 2) Probe pacing when fills / coins lag the guardrail pace.
    maybeProbe(state, slot, orders);

    // 3) New entries, capped per batch and by open positions / exposure.
    if (state.committedPositionCount() < PARAMS.maxOpenPositions) {
      for (const t of tapes.values()) {
        if (orders.length >= PARAMS.maxNewBuysPerBatch + 1) break;
        if (!canBuy(state, t, slot)) continue;
        if (currentExposureSol() + PARAMS.dipBuySol > PARAMS.maxExposureSol) break;
        const isA = entryA(state, t, slot);
        const isB = isA ? false : entryB(state, t, slot);
        if (!isA && !isB) continue;
        const kind = isA ? 'A' : ('B' as const);
        const curve = state.curves.get(t.mint);
        if (!curve) continue;
        const amount = BigInt(Math.round(PARAMS.dipBuySol * LAMPORTS_PER_SOL));
        if (state.maxBuyLamports(t.mint) < amount) continue;
        if (state.freeCashLamports() < amount + state.txFeeLamports()) continue;
        const cid = state.clientId();
        pendingBuys.set(cid, { mint: t.mint, probe: false, kind });
        t.lastAttemptSlot = slot;
        orders.push({
          side: 'buy',
          client_id: cid,
          mint: t.mint,
          quote_lamports: amount,
          max_slippage_bps: PARAMS.buySlippageBps,
        });
      }
    }
    return orders;
  }

  return { onBatch, PARAMS, stats };
}
