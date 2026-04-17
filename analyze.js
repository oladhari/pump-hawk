/**
 * analyze.js — find best TP/SL combination from any results CSV
 *
 * Usage:
 *   node analyze.js results-relaxed.csv
 *   node analyze.js results-v4.csv
 *
 * For each TP × SL combo it calculates:
 *   - avg PnL  (lower is bad, higher is good)
 *   - win rate (% of trades that close positive)
 *   - trade count
 *
 * Logic:
 *   - TP hit   → exit 100% at that TP level
 *   - TP miss  → exit at timeout price (close_multiplier when no SL)
 *   - SL hit first → exit at SL level
 *   - Uses peak_multiplier to determine TP hits for levels not in CSV
 *   - Uses hit_sl* columns for SL hit detection; falls back to close_multiplier for -30/-60
 */

import fs from 'fs';
import { parse } from 'csv-parse/sync';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node analyze.js <results.csv>');
  process.exit(1);
}

const raw  = fs.readFileSync(file, 'utf8');
const rows = parse(raw, { columns: true, skip_empty_lines: true });

if (rows.length === 0) {
  console.log('No trades found in', file);
  process.exit(0);
}

console.log(`\nAnalyzing ${rows.length} trades from ${file}\n`);

// ── TP levels to test (as multipliers) ─────────────────────────────
const TP_LEVELS = [
  { label: 'TP+15%',  mult: 1.15, col: 'hit_tp15'  },
  { label: 'TP+20%',  mult: 1.20, col: 'hit_tp20'  },
  { label: 'TP+30%',  mult: 1.30, col: 'hit_tp30'  },
  { label: 'TP+35%',  mult: 1.35, col: 'hit_tp35'  },
  { label: 'TP+50%',  mult: 1.50, col: 'hit_tp50'  },
  { label: 'TP+60%',  mult: 1.60, col: 'hit_tp60'  },  // derived from peak if col missing
  { label: 'TP+75%',  mult: 1.75, col: 'hit_tp75'  },
  { label: 'TP+100%', mult: 2.00, col: 'hit_tp100' },
  { label: 'TP+130%', mult: 2.30, col: 'hit_tp130' },
  { label: 'TP+200%', mult: 3.00, col: 'hit_tp200' },
];

// ── SL levels to test (as multipliers) ─────────────────────────────
const SL_LEVELS = [
  { label: 'SL-10%', mult: 0.90, col: 'hit_sl10' },
  { label: 'SL-15%', mult: 0.85, col: 'hit_sl15' },
  { label: 'SL-20%', mult: 0.80, col: 'hit_sl20' },
  { label: 'SL-30%', mult: 0.70, col: 'hit_sl30' },
  { label: 'SL-60%', mult: 0.40, col: 'hit_sl60' },
  { label: 'no SL',  mult: null, col: null        },
];

// ── Helper: was a level hit? ────────────────────────────────────────
// Prefer the explicit hit_* column; fall back to peak/close comparison.
function tp_hit(row, tp) {
  if (tp.col && row[tp.col] !== undefined) return row[tp.col] === 'yes';
  return parseFloat(row['peak_multiplier'] || 0) >= tp.mult;
}

function sl_hit(row, sl) {
  if (!sl.mult) return false;
  if (sl.col && row[sl.col] !== undefined) return row[sl.col] === 'yes';
  // fallback: close_multiplier dropped below SL level
  return parseFloat(row['close_multiplier'] || 1) <= sl.mult;
}

// ── Simulate single-exit PnL for a TP+SL combo ─────────────────────
// Returns PnL % for one trade. SL fires if price hits SL before TP.
// Since we only have hit flags (not which hit first), we approximate:
//   if both TP and SL hit → SL takes precedence (conservative, realistic for meme tokens)
//   if only TP hit        → +TP%
//   if only SL hit        → -SL%
//   neither               → timeout price
function simulate(row, tp, sl) {
  const tm    = parseFloat(row['close_multiplier'] || 1);
  const t_hit = tp_hit(row, tp);
  const s_hit = sl.mult ? sl_hit(row, sl) : false;

  if (s_hit) return (sl.mult - 1) * 100;      // SL fired
  if (t_hit) return (tp.mult - 1) * 100;      // TP hit, no SL
  return (tm - 1) * 100;                       // held to timeout
}

// ── Run all combos ──────────────────────────────────────────────────
const results = [];

for (const tp of TP_LEVELS) {
  for (const sl of SL_LEVELS) {
    const pnls = rows.map(r => simulate(r, tp, sl));
    const avg  = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const wins = pnls.filter(p => p > 0).length;
    results.push({
      tp: tp.label,
      sl: sl.label,
      n:  pnls.length,
      avg_pnl: avg,
      win_pct: (wins / pnls.length) * 100,
    });
  }
}

// ── Sort and display ────────────────────────────────────────────────
results.sort((a, b) => b.avg_pnl - a.avg_pnl);

const TOP = 20;
console.log(`TOP ${TOP} TP/SL COMBINATIONS (by avg PnL)\n`);
console.log('Rank  TP        SL         n    win%   avg_pnl');
console.log('─'.repeat(55));
for (const [i, r] of results.slice(0, TOP).entries()) {
  const rank   = String(i + 1).padStart(3);
  const tp_    = r.tp.padEnd(9);
  const sl_    = r.sl.padEnd(9);
  const win_   = r.win_pct.toFixed(0).padStart(4);
  const avg_   = (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(2) + '%';
  console.log(`${rank}   ${tp_}  ${sl_}  ${r.n}  ${win_}%  ${avg_}`);
}

console.log('\nBOTTOM 5 (avoid these)\n');
console.log('Rank  TP        SL         n    win%   avg_pnl');
console.log('─'.repeat(55));
for (const [i, r] of results.slice(-5).entries()) {
  const rank = String(results.length - 4 + i).padStart(3);
  const tp_  = r.tp.padEnd(9);
  const sl_  = r.sl.padEnd(9);
  const win_ = r.win_pct.toFixed(0).padStart(4);
  const avg_ = (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(2) + '%';
  console.log(`${rank}   ${tp_}  ${sl_}  ${r.n}  ${win_}%  ${avg_}`);
}

// ── Best per TP level (best SL for each TP) ─────────────────────────
console.log('\nBEST SL FOR EACH TP LEVEL\n');
console.log('TP        best_SL    win%   avg_pnl');
console.log('─'.repeat(42));
const best_per_tp = {};
for (const r of results) {
  if (!best_per_tp[r.tp] || r.avg_pnl > best_per_tp[r.tp].avg_pnl) {
    best_per_tp[r.tp] = r;
  }
}
for (const tp of TP_LEVELS) {
  const r   = best_per_tp[tp.label];
  const sl_ = r.sl.padEnd(9);
  const win_= r.win_pct.toFixed(0).padStart(4);
  const avg_= (r.avg_pnl >= 0 ? '+' : '') + r.avg_pnl.toFixed(2) + '%';
  console.log(`${tp.label.padEnd(9)}  ${sl_}  ${win_}%  ${avg_}`);
}
