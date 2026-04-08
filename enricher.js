/**
 * enricher.js — Dexscreener token snapshot
 *
 * Fetches real-time price, liquidity, mcap, volume, buys, and momentum
 * for a Solana token from the Dexscreener token API.
 *
 * Returns null if the token has no Dexscreener listing yet.
 * Picks the most-liquid pair when multiple pools exist.
 */

import fetch from 'node-fetch';

const DEX_URL = 'https://api.dexscreener.com/latest/dex/tokens/';
const TIMEOUT = parseInt(process.env.ENRICH_TIMEOUT_MS || '6000');

export async function enrich(mint) {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), TIMEOUT);
    const res = await fetch(`${DEX_URL}${mint}`, { signal: controller.signal });
    clearTimeout(tid);

    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    // Pick most liquid Solana pair
    const pair = pairs
      .filter(p => p.chainId === 'solana')
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];

    if (!pair) return null;

    const price = parseFloat(pair.priceUsd || 0);
    if (!price) return null;

    const age_min = pair.pairCreatedAt
      ? (Date.now() - pair.pairCreatedAt) / 60_000
      : null;

    return {
      price_usd:     price,
      liquidity_usd: pair.liquidity?.usd    || 0,
      market_cap:    pair.marketCap          || 0,
      age_min,
      buys_5m:       pair.txns?.m5?.buys    || 0,
      sells_5m:      pair.txns?.m5?.sells   || 0,
      buys_1h:       pair.txns?.h1?.buys    || 0,
      sells_1h:      pair.txns?.h1?.sells   || 0,
      vol_5m:        pair.volume?.m5        || 0,
      vol_1h:        pair.volume?.h1        || 0,
      pc_5m:         pair.priceChange?.m5   || 0,
      pc_1h:         pair.priceChange?.h1   || 0,
      dex_id:        pair.dexId             || '',
      pair_address:  pair.pairAddress       || '',
      name:          pair.baseToken?.name   || '',
      symbol:        pair.baseToken?.symbol || '',
    };
  } catch {
    return null;
  }
}

/** One-line snapshot for logging */
export function fmt(snap) {
  if (!snap) return 'no data';
  return [
    `$${snap.price_usd.toFixed(8)}`,
    `liq=$${(snap.liquidity_usd / 1000).toFixed(0)}k`,
    `mcap=$${(snap.market_cap / 1000).toFixed(0)}k`,
    `age=${snap.age_min?.toFixed(0)}min`,
    `buys5m=${snap.buys_5m}`,
    `vol5m=$${(snap.vol_5m / 1000).toFixed(1)}k`,
    `pc5m=${snap.pc_5m?.toFixed(1)}%`,
  ].join('  ');
}
