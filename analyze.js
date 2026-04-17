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

const file = process.argv[2];
if (!file) {
  console.error('Usage: node analyze.js <results.csv>');
  process.exit(1);
}

const lines  = fs.readFileSync(file, 'utf8').trim().split('\n');
const headers = lines[0].split(',');
const rows = lines.slice(1).filter(Boolean).map(line => {
  const vals = line.split(',');
  const obj  = {};
  headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
  return obj;
});

if (rows.length === 0) {
  console.log('No trades found in', file);
  process.exit(0);
}

console.log(`\nAnalyzing ${rows.length} trades from ${file}\n`);

// ── TP levels to test (as multipliers) ─────────────────────────────
const TP_LEVELS = [
  { label: 'TP+15%',  mult: 1.15, col: 'hit_tp15',  time_col: 'time_to_tp15_s'  },
  { label: 'TP+20%',  mult: 1.20, col: 'hit_tp20',  time_col: 'time_to_tp20_s'  },
  { label: 'TP+30%',  mult: 1.30, col: 'hit_tp30',  time_col: 'time_to_tp30_s'  },
  { label: 'TP+35%',  mult: 1.35, col: 'hit_tp35',  time_col: 'time_to_tp35_s'  },
  { label: 'TP+50%',  mult: 1.50, col: 'hit_tp50',  time_col: 'time_to_tp50_s'  },
  { label: 'TP+60%',  mult: 1.60, col: 'hit_tp60',  time_col: 'time_to_tp60_s'  },
  { label: 'TP+75%',  mult: 1.75, col: 'hit_tp75',  time_col: 'time_to_tp75_s'  },
  { label: 'TP+100%', mult: 2.00, col: 'hit_tp100', time_col: 'time_to_tp100_s' },
  { label: 'TP+130%', mult: 2.30, col: 'hit_tp130', time_col: 'time_to_tp130_s' },
  { label: 'TP+200%', mult: 3.00, col: 'hit_tp200', time_col: 'time_to_tp200_s' },
];

// ── SL levels to test (as multipliers) ─────────────────────────────
const SL_LEVELS = [
  { label: 'SL-10%', mult: 0.90, col: 'hit_sl10', time_col: 'time_to_sl10_s' },
  { label: 'SL-15%', mult: 0.85, col: 'hit_sl15', time_col: 'time_to_sl15_s' },
  { label: 'SL-20%', mult: 0.80, col: 'hit_sl20', time_col: 'time_to_sl20_s' },
  { label: 'SL-30%', mult: 0.70, col: 'hit_sl30', time_col: 'time_to_sl30_s' },
  { label: 'SL-60%', mult: 0.40, col: 'hit_sl60', time_col: 'time_to_sl60_s' },
  { label: 'no SL',  mult: null, col: null,        time_col: null             },
];

// ── Get hit timestamp in seconds, or null if not hit ───────────────
function get_time(row, level) {
  if (!level.col) return null;
  // Use explicit hit column if present
  const hit = row[level.col];
  if (hit !== undefined && hit !== 'yes') return null;
  // Use timestamp column
  const t = level.time_col ? parseFloat(row[level.time_col]) : NaN;
  if (!isNaN(t) && t > 0) return t;
  // Fallback for TP: derive hit from peak_multiplier (no timestamp available)
  if (level.mult >= 1 && hit === undefined) {
    return parseFloat(row['peak_multiplier'] || 0) >= level.mult ? Infinity : null;
  }
  // Fallback for SL: derive hit from close_multiplier (no timestamp available)
  if (level.mult < 1 && hit === undefined) {
    return parseFloat(row['close_multiplier'] || 1) <= level.mult ? Infinity : null;
  }
  return hit === 'yes' ? Infinity : null;  // hit but no timestamp — assume last
}

// ── Simulate single-exit PnL for a TP+SL combo ─────────────────────
// Uses timestamps to determine which level fired first.
// If timestamps are missing for one side, falls back to hit-only logic.
function simulate(row, tp, sl) {
  const tm   = parseFloat(row['close_multiplier'] || 1);
  const tp_t = get_time(row, tp);
  const sl_t = sl.mult ? get_time(row, sl) : null;

  if (tp_t !== null && sl_t !== null) {
    // Both hit — whichever came first wins
    return tp_t <= sl_t
      ? (tp.mult - 1) * 100   // TP hit first
      : (sl.mult - 1) * 100;  // SL hit first
  }
  if (sl_t !== null) return (sl.mult - 1) * 100;
  if (tp_t !== null) return (tp.mult - 1) * 100;
  return (tm - 1) * 100;  // neither hit — timeout price
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
