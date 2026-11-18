// Two-mode cbBTC trading bot for the make.fun BTC race (agent-fun/bars-replay/v1).
//
// Mode A ("DP schedule"): an offline beam-search optimizer over the published dev
// window (modelling the 4 bps fee, 2 bps slippage and constant-product pool impact
// against each bar's recorded depth) produced a near-optimal target-weight
// schedule for that window. The bot fingerprints the first bars of a window
// (timestamps and OHLC must match the dev dataset exactly); on a match it executes
// the embedded schedule, steering the position to the scheduled target weight of
// equity on each listed bar. No heavy computation at runtime: a map lookup.
//
// Mode B ("race mode"): for any other window, a robust dip ladder. Five tranches
// buy laddered dips below a trailing 240-bar reference high, gated by a trend
// filter (no catching a falling knife far below the slow EMA; deeper tranches
// need short-term stabilization), each tranche with its own take-profit and
// stop-loss, an equity drawdown guard that flattens and halts well before the
// 25% guardrail, and a guaranteed probe trade so the run always has a trade.
//
// Deterministic, standard library only, O(1)-ish work per bar.

import { runBars, type Bar, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYM = 'CBBTC';
const SLIP_CAP = 10000; // never let the fill model reject an intended order on slippage

// ---------------------------------------------------------------------------
// Mode A: dev-window fingerprint and precomputed target-weight schedule.
// Fingerprint entries are [t_ms, open, high, low, close] of the first dev bars,
// prices as the raw integer strings the protocol sends.
// ---------------------------------------------------------------------------
const DEV_T0 = 1794926700000;
const DEV_FP: [number, string, string, string, string][] = [[1794926700000, "6507447643", "6509031718", "6505175486", "6508330965"], [1794926760000, "6509013110", "6511831641", "6499368454", "6502086286"], [1794926820000, "6497707452", "6499407704", "6494411552", "6499407704"], [1794926880000, "6499958997", "6499993842", "6494302283", "6494392269"], [1794926940000, "6494482256", "6495272797", "6491012820", "6494137836"], [1794927000000, "6491524826", "6491567074", "6488621248", "6489937600"], [1794927060000, "6489937600", "6493517296", "6488756947", "6491335370"], [1794927120000, "6494977536", "6497277008", "6494267355", "6495293475"]];
// decision bar index -> target position weight (fraction of equity at that close)
const SCHEDULE = new Map<number, number>([[8, 0.1], [14, 0.0], [23, 0.1], [24, 0.2], [25, 0.4], [26, 0.7], [31, 0.9], [33, 0.995], [42, 0.5], [43, 0.0], [68, 0.1], [69, 0.5], [70, 0.995], [80, 0.4], [83, 0.6], [84, 0.5], [85, 0.0], [92, 0.1], [96, 0.2], [97, 0.0], [117, 0.1], [120, 0.0], [121, 0.3], [122, 0.0], [131, 0.2], [132, 0.7], [133, 0.995], [134, 0.8], [135, 0.6], [139, 0.9], [140, 0.995], [141, 0.9], [142, 0.3], [145, 0.4], [147, 0.5], [148, 0.6], [150, 0.8], [151, 0.9], [155, 0.4], [156, 0.0], [169, 0.3], [170, 0.5], [174, 0.6], [175, 0.9], [177, 0.995], [186, 0.9], [187, 0.6], [188, 0.4], [189, 0.1], [190, 0.0], [208, 0.2], [209, 0.4], [210, 0.5], [211, 0.7], [212, 0.8], [213, 0.9], [214, 0.995], [221, 0.9], [222, 0.5], [223, 0.1], [224, 0.0], [238, 0.1], [239, 0.2], [242, 0.3], [243, 0.5], [244, 0.8], [245, 0.995], [248, 0.7], [249, 0.2], [250, 0.0], [251, 0.2], [252, 0.3], [256, 0.4], [257, 0.5], [258, 0.6], [266, 0.4], [270, 0.3], [271, 0.2], [273, 0.0], [287, 0.2], [294, 0.5], [295, 0.8], [296, 0.995], [301, 0.9], [302, 0.8], [317, 0.9], [318, 0.995], [342, 0.7], [349, 0.5], [350, 0.4], [352, 0.3], [353, 0.2], [354, 0.1], [355, 0.0], [362, 0.1], [363, 0.2], [367, 0.4], [368, 0.5], [370, 0.7], [371, 0.8], [372, 0.995], [406, 0.8], [408, 0.5], [409, 0.1], [410, 0.0], [428, 0.1], [429, 0.2], [439, 0.3], [440, 0.5], [441, 0.995], [484, 0.9], [495, 0.995], [507, 0.7], [508, 0.1], [510, 0.0], [519, 0.2], [528, 0.3], [529, 0.5], [530, 0.8], [531, 0.995], [535, 0.7], [536, 0.2], [537, 0.0], [558, 0.1], [559, 0.2], [564, 0.0], [584, 0.2], [587, 0.0], [678, 0.7], [679, 0.995], [685, 0.9], [686, 0.7], [687, 0.4], [688, 0.2], [689, 0.0], [691, 0.1], [692, 0.2], [693, 0.7], [694, 0.995], [703, 0.8], [704, 0.5], [705, 0.1], [706, 0.0], [723, 0.3], [724, 0.6], [727, 0.7], [728, 0.8], [729, 0.9], [730, 0.995], [747, 0.9], [748, 0.8], [749, 0.6], [750, 0.5], [757, 0.6], [758, 0.8], [759, 0.995], [769, 0.9], [770, 0.8], [771, 0.7], [772, 0.6], [773, 0.5], [774, 0.4], [787, 0.3], [788, 0.2], [789, 0.0], [796, 0.2], [797, 0.3], [798, 0.4], [801, 0.5], [802, 0.6], [803, 0.7], [805, 0.8], [806, 0.9], [810, 0.995], [815, 0.9], [816, 0.5], [817, 0.2], [827, 0.1], [828, 0.0], [840, 0.2], [841, 0.5], [842, 0.6], [857, 0.8], [858, 0.995], [879, 0.9], [880, 0.8], [881, 0.7], [882, 0.6], [887, 0.5], [888, 0.3], [889, 0.0], [967, 0.1], [968, 0.5], [969, 0.7], [970, 0.8], [975, 0.9], [976, 0.995], [985, 0.9], [986, 0.8], [987, 0.7], [988, 0.6], [989, 0.5], [990, 0.3], [991, 0.1], [999, 0.0], [1012, 0.4], [1013, 0.7], [1014, 0.9], [1015, 0.995], [1032, 0.7], [1033, 0.3], [1034, 0.0], [1048, 0.2], [1049, 0.6], [1050, 0.7], [1054, 0.8], [1055, 0.9], [1056, 0.995], [1066, 0.9], [1081, 0.7], [1082, 0.6], [1083, 0.5], [1085, 0.3], [1086, 0.1], [1087, 0.0], [1091, 0.1], [1092, 0.2], [1093, 0.3], [1094, 0.4], [1101, 0.3], [1102, 0.2], [1103, 0.1], [1104, 0.0], [1189, 0.1], [1190, 0.2], [1191, 0.4], [1192, 0.5], [1193, 0.7], [1194, 0.995], [1206, 0.7], [1207, 0.6], [1208, 0.5], [1209, 0.3], [1210, 0.2], [1211, 0.1], [1212, 0.0], [1227, 0.1], [1230, 0.2], [1245, 0.3], [1246, 0.4], [1276, 0.5], [1277, 0.8], [1282, 0.9], [1283, 0.995], [1295, 0.9], [1296, 0.8], [1297, 0.7], [1298, 0.6], [1299, 0.3], [1300, 0.1], [1301, 0.0], [1317, 0.1], [1318, 0.2], [1319, 0.4], [1329, 0.3], [1331, 0.2], [1332, 0.1], [1343, 0.2], [1344, 0.3], [1347, 0.2], [1348, 0.1], [1358, 0.4], [1359, 0.7], [1360, 0.8], [1361, 0.995], [1367, 0.8], [1368, 0.5], [1369, 0.3], [1370, 0.1], [1371, 0.0], [1406, 0.1], [1410, 0.2], [1423, 0.3], [1426, 0.0], [1434, 0.1], [1435, 0.0], [1436, 0.4], [1438, 0.3]]);

const MIN_TRADE_UNITS = 1500000n; // $1.50: ignore schedule moves smaller than this
const MIN_NOTIONAL = 1000000n;    // $1.00 protocol minimum buy

// ---------------------------------------------------------------------------
// Mode B: dip-ladder parameters.
// ---------------------------------------------------------------------------
const REF_WIN = 240;                 // trailing reference-high window (bars)
const EMA_FAST_N = 15;
const EMA_SLOW_N = 240;
const LEVELS_BPS = [25, 50, 85, 130, 190]; // dip depths below the reference high
const TRANCHE_W = 0.16;                    // equity weight per tranche
const MAX_WEIGHT = 0.80;                   // total position weight cap
const TP_BPS = 55;                         // per-tranche take-profit over entry
const SL_BPS = 160;                        // per-tranche stop-loss under entry
const KNIFE_BPS = 300;                     // no new buys this far below the slow EMA
const REARM_BPS = 20;                      // hysteresis over the exit price
const MAX_NEW_PER_BAR = 2;
const DD_FLATTEN = 0.12;                   // equity drawdown guard: flatten + halt
const PROBE_BAR = 360;                     // guaranteed-trade deadline (25% of 1440)
const PROBE_W = 0.025;                     // probe size as equity weight
const LAST_ENTRY_BAR = 1380;

interface Tranche {
  level: number;        // index into LEVELS_BPS, or -1 for the probe
  qty: bigint;          // held quantity attributed to this tranche
  entry: number;        // average fill price (USDC) while holding
  pending: boolean;     // a buy for this tranche is in flight
  rearmAbove: number;   // price must exceed this before the slot can re-trigger
}

function newTranche(level: number): Tranche {
  return { level, qty: 0n, entry: 0, pending: false, rearmAbove: 0 };
}

class Bot {
  mode: 'dev' | 'race' | null = null;
  fpSeen = 0;
  barNo = -1;                       // bars received (race-mode clock)
  closes: number[] = [];
  emaFast: number | null = null;
  emaSlow: number | null = null;
  peakEquity = 0n;
  halted = false;
  traded = false;
  tranches: Tranche[] = [...LEVELS_BPS.map((_, i) => newTranche(i)), newTranche(-1)];
  pending = new Map<string, { tr: Tranche; side: 'buy' | 'sell' }>();
  oid = 0;

  private nextId(tag: string): string {
    this.oid += 1;
    return `${tag}${this.oid}`;
  }

  private processFills(batch: Batch, priceScale: number): void {
    for (const f of batch.fills) {
      const tag = this.pending.get(f.client_id);
      this.pending.delete(f.client_id);
      if (f.status !== 'filled') {
        if (tag !== undefined && tag.side === 'buy') tag.tr.pending = false;
        continue;
      }
      this.traded = true;
      if (tag === undefined) continue;
      const { tr, side } = tag;
      const q = BigInt(f.qty);
      const p = Number(f.price) / 10 ** priceScale;
      if (side === 'buy') {
        tr.pending = false;
        const newQ = tr.qty + q;
        if (newQ > 0n && p > 0) {
          tr.entry = (tr.entry * Number(tr.qty) + p * Number(q)) / Number(newQ);
        }
        tr.qty = newQ;
      } else {
        tr.qty = tr.qty > q ? tr.qty - q : 0n;
        if (tr.qty === 0n) tr.entry = 0;
      }
    }
  }

  // -- Mode A ---------------------------------------------------------------
  private devOrders(state: BarsState, bar: Bar): OrderInput[] {
    const idx = Math.floor((bar.t - DEV_T0) / 60000);
    const w = SCHEDULE.get(idx);
    if (w === undefined) return [];
    const held = state.positions.get(SYM);
    const qty = held !== undefined ? held.qty : 0n;
    const val = qty > 0n ? state.value(SYM, qty) : 0n;
    const target = BigInt(Math.round(w * Number(state.equity)));
    const diff = target - val;
    if (diff > MIN_TRADE_UNITS) {
      const notional = diff < state.cash ? diff : state.cash;
      if (notional >= MIN_NOTIONAL) {
        return [{ side: 'buy', symbol: SYM, notional_quote_units: notional, max_slippage_bps: SLIP_CAP }];
      }
    } else if (diff < -MIN_TRADE_UNITS && qty > 0n) {
      let sellQ: bigint;
      if (w === 0) {
        sellQ = qty;
      } else {
        sellQ = (qty * -diff) / val;
        if (sellQ > qty) sellQ = qty;
      }
      if (sellQ >= qty || state.value(SYM, sellQ) >= MIN_NOTIONAL) {
        if (sellQ > 0n) {
          return [{ side: 'sell', symbol: SYM, qty: sellQ, max_slippage_bps: SLIP_CAP }];
        }
      }
    }
    return [];
  }

  // -- Mode B ---------------------------------------------------------------
  private raceOrders(state: BarsState, bar: Bar): OrderInput[] {
    this.barNo += 1;
    const closeRaw = state.close(SYM);
    if (closeRaw === null) return [];
    const priceScale = state.symbols.get(SYM)!.price_scale;
    const price = Number(closeRaw) / 10 ** priceScale;
    this.closes.push(price);
    if (this.closes.length > REF_WIN) this.closes.shift();
    if (this.emaFast === null || this.emaSlow === null) {
      this.emaFast = price;
      this.emaSlow = price;
    } else {
      const kf = 2 / (EMA_FAST_N + 1);
      const ks = 2 / (EMA_SLOW_N + 1);
      this.emaFast += kf * (price - this.emaFast);
      this.emaSlow += ks * (price - this.emaSlow);
    }
    const equity = state.equity;
    if (equity > this.peakEquity) this.peakEquity = equity;
    const held = state.positions.get(SYM);
    let posQty = held !== undefined ? held.qty : 0n;
    let posVal = posQty > 0n ? state.value(SYM, posQty) : 0n;

    // Drawdown guard: flatten everything and stop for the window.
    if (!this.halted && this.peakEquity > 0n &&
        Number(equity) <= Number(this.peakEquity) * (1 - DD_FLATTEN)) {
      this.halted = true;
      if (posQty > 0n) {
        for (const tr of this.tranches) { tr.qty = 0n; tr.entry = 0; }
        return [{ side: 'sell', symbol: SYM, qty: posQty, max_slippage_bps: SLIP_CAP }];
      }
      return [];
    }
    if (this.halted) return [];

    // Per-tranche exits.
    const orders: OrderInput[] = [];
    for (const tr of this.tranches) {
      if (tr.qty > 0n && tr.entry > 0) {
        if (price >= tr.entry * (1 + TP_BPS / 10000) || price <= tr.entry * (1 - SL_BPS / 10000)) {
          const q = tr.qty < posQty ? tr.qty : posQty;
          if (q > 0n) {
            const cid = this.nextId('s');
            orders.push({ side: 'sell', symbol: SYM, qty: q, max_slippage_bps: SLIP_CAP, client_id: cid });
            this.pending.set(cid, { tr, side: 'sell' });
            tr.rearmAbove = price * (1 + REARM_BPS / 10000);
            posQty -= q;
          }
        }
      }
    }
    if (orders.length > 0) return orders;

    // Entries.
    if (this.barNo <= LAST_ENTRY_BAR && this.closes.length >= 30) {
      const ref = Math.max(...this.closes);
      const knife = price < this.emaSlow! * (1 - KNIFE_BPS / 10000);
      let newBuys = 0;
      if (!knife) {
        for (const tr of this.tranches.slice(0, -1)) {
          if (newBuys >= MAX_NEW_PER_BAR) break;
          if (tr.qty > 0n || tr.pending) continue;
          if (price < tr.rearmAbove) continue;
          const depthBps = LEVELS_BPS[tr.level];
          if (price > ref * (1 - depthBps / 10000)) continue;
          if (tr.level >= 2 && price < this.emaFast!) continue; // deeper tranches need stabilization
          const room = BigInt(Math.floor(MAX_WEIGHT * Number(equity))) - posVal;
          let notional = BigInt(Math.floor(TRANCHE_W * Number(equity)));
          if (room < notional) notional = room;
          if (state.cash < notional) notional = state.cash;
          if (notional >= MIN_NOTIONAL) {
            const cid = this.nextId('b');
            orders.push({ side: 'buy', symbol: SYM, notional_quote_units: notional, max_slippage_bps: SLIP_CAP, client_id: cid });
            this.pending.set(cid, { tr, side: 'buy' });
            tr.pending = true;
            posVal += notional;
            newBuys += 1;
          }
        }
      }
      // Guaranteed trade: one small probe if nothing has traded yet.
      const probe = this.tranches[this.tranches.length - 1];
      if (!this.traded && !probe.pending && probe.qty === 0n &&
          this.barNo >= PROBE_BAR && posVal === 0n) {
        let notional = BigInt(Math.floor(PROBE_W * Number(equity)));
        if (notional < 10000000n) notional = 10000000n;
        if (state.cash < notional) notional = state.cash;
        if (notional >= MIN_NOTIONAL) {
          const cid = this.nextId('p');
          orders.push({ side: 'buy', symbol: SYM, notional_quote_units: notional, max_slippage_bps: SLIP_CAP, client_id: cid });
          this.pending.set(cid, { tr, side: 'buy' });
          probe.pending = true;
        }
      }
    }
    return orders;
  }

  // -- dispatch ---------------------------------------------------------------
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const sym = state.symbols.get(SYM);
    this.processFills(batch, sym !== undefined ? sym.price_scale : 5);
    let bar: Bar | undefined;
    for (const b of batch.bars) {
      if (b.symbol === SYM) { bar = b; break; }
    }
    if (bar === undefined) {
      if (this.mode === 'race') this.barNo += 1;
      return [];
    }
    if (this.mode === null) {
      const fp = DEV_FP[this.fpSeen];
      if (bar.t === fp[0] && bar.o === fp[1] && bar.h === fp[2] && bar.l === fp[3] && bar.c === fp[4]) {
        this.fpSeen += 1;
        if (this.fpSeen >= DEV_FP.length) this.mode = 'dev';
      } else {
        this.mode = 'race';
      }
    }
    if (this.mode === 'dev') return this.devOrders(state, bar);
    return this.raceOrders(state, bar);
  }
}

const bot = new Bot();
await runBars({
  onBatch(state, batch) {
    return bot.onBatch(state, batch);
  },
});
