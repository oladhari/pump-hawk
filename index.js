/**
 * PumpHawk V3 — Solana boosted-token paper sniper
 *
 * WHAT IT DOES
 * ────────────
 * 1. Polls Dexscreener every 60s for newly-boosted Solana tokens
 * 2. Enriches each token with live price/liquidity/volume/momentum data
 * 3. Applies strict entry filters (liq gate, age cap, pc_5m range, scoring)
 * 4. Opens paper positions for tokens that pass all filters
 * 5. Tracks each position with:
 *    - Real-time SL via PumpPortal WebSocket (<200ms for bonding-curve rugs)
 *    - 5s Dexscreener poll for TP tranche logic and Raydium token coverage
 * 6. Writes results.csv (trades) and rejected.csv (filtered signals)
 *
 * RUN
 * ───
 *   npm install
 *   node index.js
 *
 * TUNE WITHOUT CODE CHANGES
 * ─────────────────────────
 *   Copy .env.example to .env and set variables.
 *   Key levers: V3_MAX_PC5M (25), V3_MIN_LIQ (10000), V3_MAX_AGE_MIN (60)
 *
 * OUTPUT FILES
 * ────────────
 *   results.csv    — one row per trade, full TP/SL tracking + 8 hypothetical PnL columns
 *   rejected.csv   — one row per rejected signal (for retrospective analysis)
 *   bot-history.log — all console output timestamped
 */

import 'dotenv/config';
import { log } from './logger.js';
import { start_boost_poller } from './boosts.js';
import { enrich, fmt } from './enricher.js';
import { filter, fmt_score } from './strategy.js';
import { Monitor, write_rejected } from './monitor.js';
import { CONFIG } from './config.js';

const monitor = new Monitor();
monitor.start();

log('[PUMPHAWK V3] Starting');
log(`[CONFIG] pc_5m: ${CONFIG.min_pc_5m}–${CONFIG.max_pc_5m}%  liq>$${CONFIG.min_liq_usd / 1000}k  mcap<$${CONFIG.max_mcap_usd / 1000}k  age<${CONFIG.max_age_min}min  score>=${CONFIG.min_score}`);
log(`[CONFIG] exits: TP1=+${CONFIG.tp1_pct * 100}%(50%)  TP2=+${CONFIG.tp2_pct * 100}%(30%)  runner=20%@trail${CONFIG.runner_trail_pct * 100}%  SL=${CONFIG.sl_pct * 100}%  timeout=${CONFIG.max_hold_s}s`);
log(`[OUTPUT] trades → ${CONFIG.results_csv}   rejected → ${CONFIG.rejected_csv}`);

async function on_signal(signal) {
  const mint = signal.mint;

  if (monitor.open_count() >= CONFIG.max_positions) {
    log(`[SKIP] max_positions (${CONFIG.max_positions}) reached — ${mint.slice(0, 8)}`);
    return;
  }

  const snap = await enrich(mint);
  if (!snap) {
    log(`[REJECT] ${mint.slice(0, 8)} — no Dexscreener data`);
    write_rejected(mint, null, signal, { score: 0, reason: 'no Dexscreener data' });
    return;
  }

  const boost_meta = {
    boost_amount:  signal.boost_amount  || 0,
    total_boosted: signal.total_boosted || 0,
  };

  const result = filter(snap, boost_meta);

  if (!result.pass) {
    log(`[REJECT] ${mint.slice(0, 8)} [${snap.symbol}]  ${result.reason}  ${fmt(snap)}`);
    write_rejected(mint, snap, signal, result);
    return;
  }

  log(`[PASS]   ${mint.slice(0, 8)} [${snap.symbol}]  ${fmt_score(result)}  ${fmt(snap)}`);
  monitor.open_position(mint, snap, signal, boost_meta, result.score);
}

start_boost_poller((signal) => {
  on_signal(signal).catch(err => log(`[ERROR] signal handler: ${err.message}`));
});

process.on('SIGINT', () => {
  log('[PUMPHAWK V3] Shutting down');
  process.exit(0);
});
