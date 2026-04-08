/**
 * boosts.js — Dexscreener boost signal poller
 *
 * Polls two free Dexscreener endpoints every 60s:
 *   /token-boosts/latest/v1  — tokens boosted most recently
 *   /token-boosts/top/v1     — tokens with most total boost spend
 *
 * Why boost = signal:
 *   Boosting costs $50-$500+. Legit projects boost; pure rugs rarely do.
 *   A boost drives new traffic to the token page → buying pressure.
 *   The boost effect peaks in the first 30-60 minutes after discovery.
 *
 * Deduplicates: same token never fires twice within 2 hours.
 *
 * Usage:
 *   start_boost_poller((signal) => { ... })
 *
 * signal: { mint, boost_amount, total_boosted, source, first_seen_ms }
 */

import fetch from 'node-fetch';
import { log, log_warn } from './logger.js';

const LATEST_URL    = 'https://api.dexscreener.com/token-boosts/latest/v1';
const TOP_URL       = 'https://api.dexscreener.com/token-boosts/top/v1';
const POLL_MS       = parseInt(process.env.BOOST_POLL_MS  || '60000');
const DEDUP_MS      = parseInt(process.env.BOOST_DEDUP_MS || String(2 * 60 * 60 * 1000));  // default 2h, override per instance

const _seen = new Map();   // mint → first_seen_ms

export function start_boost_poller(on_boost) {
  log(`[BOOST] Starting — polling every ${POLL_MS / 1000}s`);
  _poll(on_boost);
  setInterval(() => _poll(on_boost), POLL_MS);

  // Prune stale dedup entries every hour
  setInterval(() => {
    const cutoff = Date.now() - DEDUP_MS;
    for (const [mint, ts] of _seen) {
      if (ts < cutoff) _seen.delete(mint);
    }
  }, 60 * 60_000);
}

async function _poll(on_boost) {
  try {
    const [latest, top] = await Promise.all([
      _fetch(LATEST_URL, 'latest'),
      _fetch(TOP_URL, 'top'),
    ]);

    let new_count = 0;
    for (const b of [...latest, ...top]) {
      if (b.chainId !== 'solana') continue;
      const mint = b.tokenAddress;
      if (!mint || _seen.has(mint)) continue;

      _seen.set(mint, Date.now());
      new_count++;
      on_boost({
        mint,
        boost_amount:  b.amount      || 0,
        total_boosted: b.totalAmount || 0,
        source:        b._source,
        first_seen_ms: Date.now(),
      });
    }

    if (new_count > 0) log(`[BOOST] ${new_count} new boosted Solana tokens`);
  } catch (e) {
    log_warn(`[BOOST] Poll error: ${e.message}`);
  }
}

async function _fetch(url, source) {
  try {
    const res = await fetch(url, { timeout: 8000 });
    if (!res.ok) return [];
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map(b => ({ ...b, _source: source }));
  } catch {
    return [];
  }
}
