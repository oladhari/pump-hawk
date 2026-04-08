/**
 * monitor.js — 3-tranche paper position tracker with real-time SL
 *
 * EXIT STRATEGY
 * ─────────────
 *   Tranche 1 (50%):  TP at +15%
 *   Tranche 2 (30%):  TP at +30%, activates runner
 *   Runner   (20%):   trailing stop 12% from peak, or timeout
 *   SL:               -15% closes all tranches immediately
 *   Timeout:          600s → close everything at market price
 *
 * REAL-TIME SL (biggest fix vs V2)
 * ──────────────────────────────────
 *   For pump.fun bonding-curve tokens, PumpPortal fires a WebSocket event
 *   on every on-chain trade (<200ms). The monitor subscribes per position
 *   and fires SL immediately when price drops -15%.
 *   Previously: 5s Dexscreener poll → rug exits at -40% to -97%.
 *   Now: bonding-curve rugs caught within 200ms of the dump trade.
 *   Graduated Raydium tokens still use the 5s poll (LP is locked, less rug risk).
 *
 * TWO POSITION FLAGS
 * ──────────────────
 *   pos.exited    — trade financially closed (no more exit decisions)
 *   pos.finalized — polling stopped, CSV row written
 *   After exit, polling continues until max_hold for TP50/75/100 data collection.
 *
 * CSV COLUMNS
 * ───────────
 *   results.csv — one row per trade with full TP/SL hit tracking + hypothetical PnL columns
 *   rejected.csv — one row per rejected signal (for retrospective analysis)
 */

import fs from 'fs';
import fetch from 'node-fetch';
import { CONFIG } from './config.js';
import { log } from './logger.js';
import {
  connect_pp,
  subscribe_token_trades,
  unsubscribe_token_trades,
} from './pumpportal.js';

const POLL_MS       = 5000;
const SOL_PRICE_USD = parseFloat(process.env.SOL_PRICE_USD || '150');

// ── CSV schema ────────────────────────────────────────────────────

const CSV_HEADER = [
  'token_mint', 'symbol', 'detected_at', 'source',
  // entry snapshot
  'entry_price_usd', 'entry_mcap_usd', 'entry_liq_usd',
  'entry_buys_5m', 'entry_vol_5m', 'entry_pc_5m', 'entry_age_min',
  // boost metadata
  'boost_amount', 'total_boosted',
  // scoring
  'entry_score',
  // trade outcome
  'close_reason', 'hold_seconds',
  'peak_multiplier', 'close_multiplier',
  // TP hit tracking (across entire max_hold window)
  'hit_tp10',  'time_to_tp10_s',
  'hit_tp15',  'time_to_tp15_s',
  'hit_tp20',  'time_to_tp20_s',
  'hit_tp30',  'time_to_tp30_s',
  'hit_tp35',  'time_to_tp35_s',
  'hit_tp50',  'time_to_tp50_s',
  'hit_tp75',  'time_to_tp75_s',
  'hit_tp100', 'time_to_tp100_s',
  // SL hit tracking (different levels for calibration)
  'hit_sl10',  'time_to_sl10_s',
  'hit_sl15',  'time_to_sl15_s',
  'hit_sl20',  'time_to_sl20_s',
  // Active strategy PnL (weighted 3-tranche)
  'pnl_active_strategy',
  // Hypothetical single-exit PnLs (TP calibration)
  'pnl_if_tp15_full',
  'pnl_if_tp20_full',
  'pnl_if_tp30_full',
  'pnl_if_tp35_full',
  'pnl_if_tp50_full',
  // Hypothetical SL-only PnLs
  'pnl_if_sl10',
  'pnl_if_sl15',
  'pnl_if_sl20',
  // No exit — hold entire window
  'pnl_if_timeout',
  // Diagnostics
  'rt_sl_fired',   // 'yes' if PumpPortal real-time SL fired (not poll)
].join(',');

// ── Monitor class ─────────────────────────────────────────────────

export class Monitor {
  constructor() {
    this._positions = new Map();
    this._timer     = null;
  }

  start() {
    // Create CSVs if not present
    for (const f of [CONFIG.results_csv, CONFIG.rejected_csv]) {
      if (!fs.existsSync(f)) {
        const header = f === CONFIG.results_csv ? CSV_HEADER : REJECTED_HEADER;
        fs.writeFileSync(f, header + '\n');
        log(`[MON] Created ${f}`);
      } else {
        log(`[MON] Appending to ${f}`);
      }
    }

    // Open PumpPortal WebSocket for real-time SL
    connect_pp();

    this._timer = setInterval(() => this._poll(), POLL_MS);
    log(`[MON] TP1:+${CONFIG.tp1_pct * 100}%(50%)  TP2:+${CONFIG.tp2_pct * 100}%(30%)  runner:20%@trail${CONFIG.runner_trail_pct * 100}%  SL:${CONFIG.sl_pct * 100}%  max_hold:${CONFIG.max_hold_s}s`);
    log(`[MON] Real-time SL active via PumpPortal (bonding-curve tokens)`);
  }

  open_count() {
    return [...this._positions.values()].filter(p => !p.exited).length;
  }

  open_position(mint, snap, signal, boost_meta = {}, score = 0) {
    if (this._positions.has(mint)) return;

    const pos = {
      mint,
      symbol:        snap.symbol || signal?.symbol || '?',
      source:        signal?.source || 'boost',
      entry_price:   snap.price_usd,
      entry_mcap:    snap.market_cap,
      entry_liq:     snap.liquidity_usd,
      entry_buys5m:  snap.buys_5m,
      entry_vol5m:   snap.vol_5m,
      entry_pc5m:    snap.pc_5m,
      entry_age:     snap.age_min,
      boost_amount:  boost_meta.boost_amount  || 0,
      total_boosted: boost_meta.total_boosted || 0,
      entry_score:   score,
      opened_ms:     Date.now(),
      detected_at:   new Date().toISOString(),
      max_hold_ms:   CONFIG.max_hold_s * 1000,
      peak_mult:     1.0,
      last_price:    snap.price_usd,

      // TP/SL level timestamps (set on first touch, never cleared)
      tp10_t: null, tp15_t: null, tp20_t: null, tp30_t: null,
      tp35_t: null, tp50_t: null, tp75_t: null, tp100_t: null,
      sl10_t: null, sl15_t: null, sl20_t: null,

      // 3-tranche exit state
      t1_taken:         false, t1_exit_mult:    null,
      t2_taken:         false, t2_exit_mult:    null,
      runner_closed:    false, runner_exit_mult: null,
      runner_peak_mult: 1.0,

      exited:       false,
      close_reason: null,
      close_mult:   null,
      exit_s:       null,
      finalized:    false,
      timeout_mult: null,

      // Real-time SL tracking
      rt_sl_fired:     false,
      entry_price_sol: snap.price_usd / SOL_PRICE_USD,
    };

    this._positions.set(mint, pos);
    log(`[ENTRY] ${mint.slice(0, 8)} [${pos.symbol}]  $${snap.price_usd.toFixed(8)}  mcap=$${(snap.market_cap / 1000).toFixed(0)}k  liq=$${(snap.liquidity_usd / 1000).toFixed(0)}k  score=${score}`);

    // Subscribe to real-time trade events — catches bonding-curve rugs instantly
    subscribe_token_trades(mint, (trade) => this._on_trade(mint, trade));
  }

  // ── Real-time SL via PumpPortal ─────────────────────────────────

  /**
   * Fires on every on-chain trade for this token.
   * Uses bonding curve virtual reserves to compute current price ratio.
   * Only fires SL — TP tranche logic stays in the poll loop.
   */
  _on_trade(mint, trade) {
    const pos = this._positions.get(mint);
    if (!pos || pos.exited || pos.finalized) return;

    const vSol    = parseFloat(trade.vSolInBondingCurve);
    const vTokens = parseFloat(trade.vTokensInBondingCurve);
    if (!vSol || !vTokens || vTokens === 0) return;
    if (!pos.entry_price_sol || pos.entry_price_sol === 0) return;

    const price_sol = vSol / vTokens;
    const mult      = price_sol / pos.entry_price_sol;
    const age_s     = (Date.now() - pos.opened_ms) / 1000;

    // Keep tracking fields up to date
    if (mult > pos.peak_mult) pos.peak_mult = mult;
    if (!pos.sl10_t && mult <= 0.90) pos.sl10_t = age_s;
    if (!pos.sl15_t && mult <= 0.85) pos.sl15_t = age_s;
    if (!pos.sl20_t && mult <= 0.80) pos.sl20_t = age_s;

    // Fire SL immediately — don't wait for next 5s poll
    if (mult <= 1 + CONFIG.sl_pct) {
      pos.rt_sl_fired = true;
      this._apply_exit_logic(mint, pos, mult, age_s);
    }
  }

  // ── 5s poll (backup for Raydium + TP tranche logic) ─────────────

  async _poll() {
    for (const [mint, pos] of this._positions) {
      if (pos.finalized) continue;

      const age_ms = Date.now() - pos.opened_ms;
      const price  = await _get_price(mint);

      if (price) {
        pos.last_price = price;
        const mult  = price / pos.entry_price;
        const age_s = age_ms / 1000;

        if (mult > pos.peak_mult) pos.peak_mult = mult;

        // Track all TP/SL levels
        if (!pos.tp10_t  && mult >= 1.10) pos.tp10_t  = age_s;
        if (!pos.tp15_t  && mult >= 1.15) pos.tp15_t  = age_s;
        if (!pos.tp20_t  && mult >= 1.20) pos.tp20_t  = age_s;
        if (!pos.tp30_t  && mult >= 1.30) pos.tp30_t  = age_s;
        if (!pos.tp35_t  && mult >= 1.35) pos.tp35_t  = age_s;
        if (!pos.tp50_t  && mult >= 1.50) pos.tp50_t  = age_s;
        if (!pos.tp75_t  && mult >= 1.75) pos.tp75_t  = age_s;
        if (!pos.tp100_t && mult >= 2.00) pos.tp100_t = age_s;
        if (!pos.sl10_t  && mult <= 0.90) pos.sl10_t  = age_s;
        if (!pos.sl15_t  && mult <= 0.85) pos.sl15_t  = age_s;
        if (!pos.sl20_t  && mult <= 0.80) pos.sl20_t  = age_s;

        if (!pos.exited) {
          this._apply_exit_logic(mint, pos, mult, age_s);
        }
      }

      if (age_ms >= pos.max_hold_ms) {
        this._finalize(mint, pos);
      }
    }

    // Prune finalized positions
    for (const [mint, pos] of this._positions) {
      if (pos.finalized && (Date.now() - pos.opened_ms) > 30_000) {
        this._positions.delete(mint);
      }
    }
  }

  // ── Exit logic (shared by poll and real-time handler) ────────────

  _apply_exit_logic(mint, pos, mult, age_s) {
    // SL — close all tranches immediately
    if (mult <= 1 + CONFIG.sl_pct) {
      pos.t1_exit_mult     = pos.t1_taken ? 1 + CONFIG.tp1_pct : mult;
      pos.t2_exit_mult     = pos.t2_taken ? 1 + CONFIG.tp2_pct : mult;
      pos.runner_exit_mult = mult;
      pos.close_reason     = 'sl';
      pos.exit_s           = age_s;
      pos.exited           = true;
      pos.close_mult       = _weighted(pos);
      const info = pos.t1_taken
        ? `(t1 locked@+${(CONFIG.tp1_pct * 100).toFixed(0)}%, remainder SL)`
        : `(full SL${pos.rt_sl_fired ? ' — RT' : ''})`;
      log(`[SL]  ${mint.slice(0, 8)} [${pos.symbol}]  ${mult.toFixed(3)}x  weighted=${pos.close_mult.toFixed(3)}x  hold=${age_s.toFixed(1)}s  ${info}`);
      return;
    }

    // Tranche 1 — sell 50% at TP1
    if (!pos.t1_taken && mult >= 1 + CONFIG.tp1_pct) {
      pos.t1_taken     = true;
      pos.t1_exit_mult = 1 + CONFIG.tp1_pct;
      log(`[TP1] ${mint.slice(0, 8)} [${pos.symbol}]  50% @ ${pos.t1_exit_mult.toFixed(3)}x  hold=${age_s.toFixed(1)}s  — waiting TP2`);
      return;
    }

    // Tranche 2 — sell 30% at TP2
    if (pos.t1_taken && !pos.t2_taken && mult >= 1 + CONFIG.tp2_pct) {
      pos.t2_taken         = true;
      pos.t2_exit_mult     = 1 + CONFIG.tp2_pct;
      pos.runner_peak_mult = mult;
      log(`[TP2] ${mint.slice(0, 8)} [${pos.symbol}]  30% @ ${pos.t2_exit_mult.toFixed(3)}x  hold=${age_s.toFixed(1)}s  — runner active`);
      return;
    }

    // Runner — trailing stop
    if (pos.t2_taken && !pos.runner_closed) {
      if (mult > pos.runner_peak_mult) pos.runner_peak_mult = mult;
      const floor = pos.runner_peak_mult * (1 - CONFIG.runner_trail_pct);
      if (mult <= floor) {
        pos.runner_exit_mult = mult;
        pos.runner_closed    = true;
        pos.close_reason     = 'tp2+trail';
        pos.exit_s           = age_s;
        pos.exited           = true;
        pos.close_mult       = _weighted(pos);
        log(`[TRAIL] ${mint.slice(0, 8)} [${pos.symbol}]  runner @ ${mult.toFixed(3)}x  peak=${pos.runner_peak_mult.toFixed(3)}x  weighted=${pos.close_mult.toFixed(3)}x  hold=${age_s.toFixed(1)}s`);
      }
    }
  }

  // ── Finalize — write CSV row ──────────────────────────────────────

  _finalize(mint, pos) {
    if (pos.finalized) return;
    pos.finalized = true;

    unsubscribe_token_trades(mint);

    const tm = pos.last_price / pos.entry_price;
    pos.timeout_mult = tm;

    if (!pos.exited) {
      pos.t1_exit_mult     = pos.t1_taken ? 1 + CONFIG.tp1_pct : tm;
      pos.t2_exit_mult     = pos.t2_taken ? 1 + CONFIG.tp2_pct : tm;
      pos.runner_exit_mult = tm;

      if (pos.t2_taken)      pos.close_reason = 'tp2+timeout';
      else if (pos.t1_taken) pos.close_reason = 'tp1+timeout';
      else                   pos.close_reason = 'timeout';

      pos.close_mult = _weighted(pos);
      pos.exit_s     = CONFIG.max_hold_s.toFixed(1);
      pos.exited     = true;

      const icon = pos.close_mult >= 1.30 ? 'WIN' : pos.close_mult >= 1.0 ? 'flat' : 'loss';
      log(`[TIMEOUT] ${mint.slice(0, 8)} [${pos.symbol}]  weighted=${pos.close_mult.toFixed(3)}x  peak=${pos.peak_mult.toFixed(3)}x  reason=${pos.close_reason}  [${icon}]`);
    }

    // ── PnL calculations ────────────────────────────────────────
    const pct    = (mult) => ((mult - 1) * 100).toFixed(2);
    const wt     = pos.close_mult;

    const pnl_active = (
      CONFIG.tranche1_pct * (pos.t1_exit_mult - 1) * 100 +
      CONFIG.tranche2_pct * (pos.t2_exit_mult - 1) * 100 +
      CONFIG.runner_pct   * (pos.runner_exit_mult - 1) * 100
    ).toFixed(2);

    // If TP hit: exit 100% at that level; else: hold to timeout
    const hyp_tp = (level, hit_t) => hit_t ? pct(level) : pct(tm);
    const pnl_tp15 = hyp_tp(1.15, pos.tp15_t);
    const pnl_tp20 = hyp_tp(1.20, pos.tp20_t);
    const pnl_tp30 = hyp_tp(1.30, pos.tp30_t);
    const pnl_tp35 = hyp_tp(1.35, pos.tp35_t);
    const pnl_tp50 = hyp_tp(1.50, pos.tp50_t);

    // If SL hit: exit at that level; else: hold to timeout
    const hyp_sl = (hit_t, sl_mult) => hit_t ? pct(sl_mult) : pct(tm);
    const pnl_sl10 = hyp_sl(pos.sl10_t, 0.90);
    const pnl_sl15 = hyp_sl(pos.sl15_t, 0.85);
    const pnl_sl20 = hyp_sl(pos.sl20_t, 0.80);

    const pnl_timeout = pct(tm);

    log(`[FINAL] ${mint.slice(0, 8)} [${pos.symbol}]  reason=${pos.close_reason}  weighted=${wt.toFixed(3)}x  pnl=${pnl_active}%  peak=${pos.peak_mult.toFixed(3)}x  tp15=${pos.tp15_t ? 'Y' : 'N'}  tp30=${pos.tp30_t ? 'Y' : 'N'}  tp50=${pos.tp50_t ? 'Y' : 'N'}  rt_sl=${pos.rt_sl_fired ? 'Y' : 'N'}`);

    const row = [
      mint,
      pos.symbol,
      pos.detected_at,
      pos.source,
      pos.entry_price.toFixed(10),
      pos.entry_mcap?.toFixed(0)  ?? '',
      pos.entry_liq?.toFixed(0)   ?? '',
      pos.entry_buys5m            ?? '',
      pos.entry_vol5m?.toFixed(0) ?? '',
      pos.entry_pc5m?.toFixed(2)  ?? '',
      pos.entry_age?.toFixed(0)   ?? '',
      pos.boost_amount,
      pos.total_boosted,
      pos.entry_score,
      pos.close_reason,
      pos.exit_s,
      pos.peak_mult.toFixed(4),
      wt.toFixed(4),
      // TP hits
      pos.tp10_t  ? 'yes' : 'no', pos.tp10_t  ?? '',
      pos.tp15_t  ? 'yes' : 'no', pos.tp15_t  ?? '',
      pos.tp20_t  ? 'yes' : 'no', pos.tp20_t  ?? '',
      pos.tp30_t  ? 'yes' : 'no', pos.tp30_t  ?? '',
      pos.tp35_t  ? 'yes' : 'no', pos.tp35_t  ?? '',
      pos.tp50_t  ? 'yes' : 'no', pos.tp50_t  ?? '',
      pos.tp75_t  ? 'yes' : 'no', pos.tp75_t  ?? '',
      pos.tp100_t ? 'yes' : 'no', pos.tp100_t ?? '',
      // SL hits
      pos.sl10_t  ? 'yes' : 'no', pos.sl10_t  ?? '',
      pos.sl15_t  ? 'yes' : 'no', pos.sl15_t  ?? '',
      pos.sl20_t  ? 'yes' : 'no', pos.sl20_t  ?? '',
      // PnL
      pnl_active,
      pnl_tp15,
      pnl_tp20,
      pnl_tp30,
      pnl_tp35,
      pnl_tp50,
      pnl_sl10,
      pnl_sl15,
      pnl_sl20,
      pnl_timeout,
      pos.rt_sl_fired ? 'yes' : 'no',
    ].join(',');

    fs.appendFileSync(CONFIG.results_csv, row + '\n');
  }
}

// ── Weighted average exit across 3 tranches ───────────────────────

function _weighted(pos) {
  const lp = pos.last_price / pos.entry_price;
  return (
    CONFIG.tranche1_pct * (pos.t1_exit_mult     ?? lp) +
    CONFIG.tranche2_pct * (pos.t2_exit_mult     ?? lp) +
    CONFIG.runner_pct   * (pos.runner_exit_mult ?? lp)
  );
}

// ── Dexscreener price fetcher (5s cache) ──────────────────────────

const _price_cache = new Map();

async function _get_price(mint) {
  const cached = _price_cache.get(mint);
  if (cached && Date.now() - cached.ts < 4000) return cached.price;

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: controller.signal });
    clearTimeout(tid);
    if (!res.ok) return null;

    const data = await res.json();
    const pair = (data?.pairs || [])
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    const price = pair ? parseFloat(pair.priceUsd || 0) : null;
    if (price) _price_cache.set(mint, { price, ts: Date.now() });
    return price;
  } catch {
    return null;
  }
}

// ── Rejected CSV schema ───────────────────────────────────────────

const REJECTED_HEADER = [
  'token_mint', 'symbol', 'detected_at', 'source',
  'entry_pc_5m', 'entry_mcap_usd', 'entry_liq_usd',
  'entry_buys_5m', 'entry_vol_5m', 'entry_age_min',
  'entry_score', 'reject_reason',
].join(',');

export function write_rejected(mint, snap, signal, result) {
  const row = [
    mint,
    snap?.symbol || signal?.symbol || '?',
    new Date().toISOString(),
    signal?.source || 'boost',
    snap?.pc_5m?.toFixed(2)         ?? '',
    snap?.market_cap?.toFixed(0)    ?? '',
    snap?.liquidity_usd?.toFixed(0) ?? '',
    snap?.buys_5m                   ?? '',
    snap?.vol_5m?.toFixed(0)        ?? '',
    snap?.age_min?.toFixed(0)       ?? '',
    result.score,
    `"${result.reason}"`,
  ].join(',');
  fs.appendFileSync(CONFIG.rejected_csv, row + '\n');
}
