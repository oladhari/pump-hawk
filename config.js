/**
 * config.js — all tunable parameters for PumpHawk V3
 *
 * Every value can be overridden via environment variable (see .env.example).
 * No code changes needed to tune the strategy — just set env vars.
 *
 * ENTRY FILTERS (hard rejection)
 * ─────────────────────────────
 *   pc_5m range:   10–25%    — mid-momentum zone, not over-pumped
 *   min_liq_usd:   $10,000   — blocks zero-liq tokens (47% of V2 failures)
 *   max_mcap_usd:  $80,000   — small caps only, more upside room
 *   max_age_min:   60 min    — boost effect fades after ~1 hour
 *   min_score:     70/100    — scoring gate (see strategy.js)
 *
 * EXIT STRATEGY (3-tranche)
 * ─────────────────────────
 *   Tranche 1 (50%):  TP at +15%
 *   Tranche 2 (30%):  TP at +30%
 *   Runner   (20%):   trailing stop 12% from peak, or timeout
 *   SL:               -15% closes all tranches immediately
 *   Timeout:          600s (10 min)
 *
 *   Real-time SL fires via PumpPortal trade events (<200ms) for bonding-curve tokens.
 *   Graduated Raydium tokens fall back to 5s Dexscreener poll.
 */

export const CONFIG = {

  // ── Hard entry filters ─────────────────────────────────────────
  min_pc_5m:        parseFloat(process.env.V3_MIN_PC5M      || '10'),
  max_pc_5m:        parseFloat(process.env.V3_MAX_PC5M      || '25'),
  max_mcap_usd:     parseFloat(process.env.V3_MAX_MCAP      || '80000'),
  min_liq_usd:      parseFloat(process.env.V3_MIN_LIQ       || '10000'),
  min_vol_5m:       parseFloat(process.env.V3_MIN_VOL5M     || '1500'),
  min_buys_5m:      parseInt(process.env.V3_MIN_BUYS5M      || '20'),
  max_buys_5m:      parseInt(process.env.V3_MAX_BUYS5M      || '250'),
  min_boost_amount: parseFloat(process.env.V3_MIN_BOOST     || '0.01'),
  min_score:        parseInt(process.env.V3_MIN_SCORE       || '70'),
  max_age_min:      parseFloat(process.env.V3_MAX_AGE_MIN   || '60'),

  // ── Exit strategy ──────────────────────────────────────────────
  tp1_pct:          parseFloat(process.env.V3_TP1           || '0.15'),  // +15% → sell 50%
  tp2_pct:          parseFloat(process.env.V3_TP2           || '0.30'),  // +30% → sell 30%
  sl_pct:           parseFloat(process.env.V3_SL            || '-0.15'), // -15% → close all
  runner_trail_pct: parseFloat(process.env.V3_RUNNER_TRAIL  || '0.12'),  // trailing 12% from peak
  max_hold_s:       parseInt(process.env.V3_MAX_HOLD_S      || '600'),

  // Tranche sizes — must sum to 1.0
  tranche1_pct: 0.50,
  tranche2_pct: 0.30,
  runner_pct:   0.20,

  // ── Runtime ────────────────────────────────────────────────────
  max_positions: parseInt(process.env.V3_MAX_POS || '10'),

  // ── Output files (overridable for parallel bot instances) ──────
  results_csv:  process.env.RESULTS_CSV  || 'results.csv',
  rejected_csv: process.env.REJECTED_CSV || 'rejected.csv',
};
