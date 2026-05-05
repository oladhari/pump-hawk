/**
 * pumpportal.js — PumpPortal WebSocket client
 *
 * Single persistent connection for all subscriptions.
 * Used by the monitor for real-time per-position SL via trade events.
 *
 * API: wss://pumpportal.fun/api/data
 *
 * Exports:
 *   connect_pp()                         — open connection (no new-token sub)
 *   subscribe_token_trades(mint, cb)     — subscribe to trade events for a token
 *   unsubscribe_token_trades(mint)       — unsubscribe when position closes
 */

import WebSocket from 'ws';
import { log, log_warn } from './logger.js';

const PP_URL = 'wss://pumpportal.fun/api/data';

let _ws              = null;
let _reconnect_delay = 2000;
let _ready           = false;

const _trade_cbs  = new Map();   // mint → callback
const _pending    = [];          // queued sends before WS opens

// ── Public API ────────────────────────────────────────────────────

/**
 * Open the PumpPortal WebSocket. Safe to call multiple times — only connects once.
 */
export function connect_pp() {
  if (!_ws) _connect();
}

/**
 * Subscribe to real-time on-chain trade events for a token.
 * Safe to call before connection is open — messages are queued.
 */
export function subscribe_token_trades(mint, callback) {
  _trade_cbs.set(mint, callback);
  _send({ method: 'subscribeTokenTrade', keys: [mint] });
}

/**
 * Unsubscribe when a position closes to stop receiving events.
 */
export function unsubscribe_token_trades(mint) {
  _trade_cbs.delete(mint);
  _send({ method: 'unsubscribeTokenTrade', keys: [mint] });
}

// ── WebSocket lifecycle ───────────────────────────────────────────

function _connect() {
  log('[PP] Connecting to PumpPortal...');
  _ws = new WebSocket(PP_URL);

  _ws.on('open', () => {
    _reconnect_delay = 2000;
    _ready = true;
    log('[PP] Connected');

    // Re-subscribe to any tokens tracked before reconnect
    for (const mint of _trade_cbs.keys()) {
      _ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] }));
    }

    // Drain queue
    while (_pending.length > 0) {
      _ws.send(JSON.stringify(_pending.shift()));
    }
  });

  _ws.on('message', (raw) => {
    try { _handle(JSON.parse(raw.toString())); } catch { /* ignore malformed */ }
  });

  _ws.on('error', (e) => log_warn(`[PP] Error: ${e.message}`));

  _ws.on('close', () => {
    _ready = false;
    log_warn(`[PP] Disconnected — reconnecting in ${_reconnect_delay / 1000}s`);
    setTimeout(() => {
      _reconnect_delay = Math.min(_reconnect_delay * 2, 30_000);
      _connect();
    }, _reconnect_delay);
  });
}

// ── Diagnostic counters ───────────────────────────────────────────
// _raw: every message received from PP (any mint)
// _matched: messages for our subscribed mints
// _fired: callbacks that passed vSol check (real-time SL eligible)
let _dbg = { raw: 0, matched: 0, no_vsol: 0, buys: 0, sells: 0 };
setInterval(() => {
  log(`[PP] 5-min stats — raw_msgs:${_dbg.raw}  matched:${_dbg.matched}  no_vSol:${_dbg.no_vsol}  callbacks(buy/sell):${_dbg.buys}/${_dbg.sells}  subs:${_trade_cbs.size}`);
  _dbg = { raw: 0, matched: 0, no_vsol: 0, buys: 0, sells: 0 };
}, 5 * 60_000);

// ── Message handler ───────────────────────────────────────────────

function _handle(msg) {
  if (typeof msg !== 'object' || !msg?.mint) return;
  _dbg.raw++;

  const cb = _trade_cbs.get(msg.mint);
  if (!cb) return;
  _dbg.matched++;

  // Check if bonding-curve data is present (graduated Raydium tokens won't have it)
  if (!msg.vSolInBondingCurve || !msg.vTokensInBondingCurve) {
    _dbg.no_vsol++;
    return;
  }

  if (msg.txType === 'buy')  { _dbg.buys++;  cb(msg); }
  if (msg.txType === 'sell') { _dbg.sells++; cb(msg); }
}

function _send(payload) {
  if (_ready && _ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify(payload));
  } else {
    _pending.push(payload);
  }
}
