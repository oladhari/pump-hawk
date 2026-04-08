/**
 * strategy.js — entry filter + scoring for PumpHawk V3
 *
 * FILTER FLOW
 * ───────────
 * 1. Hard rejection (fast fail — any fail = reject, no score computed)
 * 2. Score 0–100 (quality gate at min_score)
 *
 * HARD REJECTION RULES
 * ─────────────────────
 *   age      > max_age_min   — boost effect faded (stale signal)
 *   liq      = 0             — zero liquidity (rug waiting to happen)
 *   liq      < min_liq_usd   — illiquid pool ($10k floor blocks 46% of universe)
 *   pc_5m    < min_pc_5m     — no momentum
 *   pc_5m    > max_pc_5m     — over-pumped (past peak, inconsistent outcomes)
 *   mcap     >= max_mcap_usd — too large, limited upside
 *   buys_5m  < min_buys_5m   — too quiet
 *   buys_5m  > max_buys_5m   — overcrowded
 *   vol_5m   < min_vol_5m    — no volume confirmation
 *   boost    < min_boost     — no real boost paid
 *
 * SCORING (0–100, gate at min_score default 70)
 * ──────────────────────────────────────────────
 *   pc_5m zone  (35 pts) — sweet spot is 15-25%
 *   vol_5m      (22 pts) — higher conviction
 *   mcap        (20 pts) — smaller cap = more upside room
 *   buys_5m     (15 pts) — organic mid-range (30–150)
 *   liq         ( 8 pts) — safer exit, less slippage
 *
 * Returns: { pass, reason, score, breakdown }
 */

import { CONFIG } from './config.js';

export function filter(snap, boost) {
  const C         = CONFIG;
  const pc5m      = snap?.pc_5m         ?? 0;
  const mcap      = snap?.market_cap    ?? 0;
  const liq       = snap?.liquidity_usd ?? 0;
  const buys      = snap?.buys_5m       ?? 0;
  const vol       = snap?.vol_5m        ?? 0;
  const age       = snap?.age_min;
  const boost_amt = boost?.boost_amount ?? 0;

  // ── 1. Hard rejection ─────────────────────────────────────────

  if (!snap)
    return _reject('no Dexscreener data');

  if (age !== null && age !== undefined && age > C.max_age_min)
    return _reject(`age ${age.toFixed(0)}min > ${C.max_age_min}min (boost effect faded)`);

  if (liq <= 0)
    return _reject(`liq=$${liq.toFixed(0)} — zero liquidity`);

  if (liq < C.min_liq_usd)
    return _reject(`liq=$${liq.toFixed(0)} < $${C.min_liq_usd} (illiquid)`);

  if (pc5m < C.min_pc_5m)
    return _reject(`pc_5m ${pc5m.toFixed(1)}% < ${C.min_pc_5m}% (weak momentum)`);

  if (pc5m > C.max_pc_5m)
    return _reject(`pc_5m ${pc5m.toFixed(1)}% > ${C.max_pc_5m}% (overextended)`);

  if (mcap >= C.max_mcap_usd)
    return _reject(`mcap $${(mcap / 1000).toFixed(0)}k >= $${C.max_mcap_usd / 1000}k (too large)`);

  if (buys < C.min_buys_5m)
    return _reject(`buys_5m ${buys} < ${C.min_buys_5m} (too quiet)`);

  if (buys > C.max_buys_5m)
    return _reject(`buys_5m ${buys} > ${C.max_buys_5m} (overcrowded)`);

  if (vol < C.min_vol_5m)
    return _reject(`vol_5m $${vol.toFixed(0)} < $${C.min_vol_5m}`);

  if (boost_amt < C.min_boost_amount)
    return _reject(`boost_amount ${boost_amt} — no real boost`);

  // ── 2. Scoring ────────────────────────────────────────────────

  let score = 0;
  const b   = {};

  // pc_5m — sweet spot 15–25%, lower half (10–15%) is acceptable
  if (pc5m >= 20)       { score += 35; b.pc5m = `${pc5m.toFixed(1)}%→+35`; }
  else if (pc5m >= 15)  { score += 28; b.pc5m = `${pc5m.toFixed(1)}%→+28`; }
  else                  { score += 18; b.pc5m = `${pc5m.toFixed(1)}%→+18`; }

  // vol_5m — higher = stronger conviction
  if (vol > 8000)       { score += 22; b.vol = `$${(vol / 1000).toFixed(1)}k→+22`; }
  else if (vol > 4000)  { score += 15; b.vol = `$${(vol / 1000).toFixed(1)}k→+15`; }
  else if (vol > 2000)  { score += 10; b.vol = `$${(vol / 1000).toFixed(1)}k→+10`; }
  else                  { score +=  5; b.vol = `$${(vol / 1000).toFixed(1)}k→+5`; }

  // mcap — smaller cap = more upside room
  if (mcap < 25000)     { score += 20; b.mcap = `$${(mcap / 1000).toFixed(0)}k→+20`; }
  else if (mcap < 50000){ score += 13; b.mcap = `$${(mcap / 1000).toFixed(0)}k→+13`; }
  else                  { score +=  6; b.mcap = `$${(mcap / 1000).toFixed(0)}k→+6`; }

  // buys_5m — organic mid-range is best
  if (buys >= 30 && buys <= 150) { score += 15; b.buys = `${buys}→+15`; }
  else if (buys >= 20)           { score +=  8; b.buys = `${buys}→+8`; }

  // liq — higher = safer exit
  if (liq > 30000)      { score += 8; b.liq = `$${(liq / 1000).toFixed(0)}k→+8`; }
  else if (liq > 20000) { score += 5; b.liq = `$${(liq / 1000).toFixed(0)}k→+5`; }
  else                  { score += 2; b.liq = `$${(liq / 1000).toFixed(0)}k→+2`; }

  // ── 3. Score gate ─────────────────────────────────────────────

  if (score < C.min_score)
    return _reject(`score ${score} < ${C.min_score} required`, score, b);

  return { pass: true, reason: 'ok', score, breakdown: b };
}

function _reject(reason, score = 0, breakdown = {}) {
  return { pass: false, reason, score, breakdown };
}

export function fmt_score(result) {
  const parts = Object.entries(result.breakdown).map(([k, v]) => `${k}:${v}`);
  return `score:${result.score}  [${parts.join(' | ')}]`;
}
