# PumpHawk — Paper Trading Research Targets

This file is the reference document for understanding what each bot is doing,
what data we are collecting, and what decisions we are trying to make.
Read this before analyzing results or making config changes.

---

## Purpose

We are running multiple parallel paper-trading bots to answer one question:
**what is the optimal entry filter + TP/SL combination for boosted Solana tokens?**

No real funds are moved. Every trade is simulated. The bots write CSV files
that we analyze to find the best strategy before going live.

---

## Running Bots

All bots run on the DigitalOcean droplet at `165.22.252.134` as systemd services.
All share the same codebase (`/root/pumphawk/`) and the same `monitor.js` — so
every bot tracks the exact same TP/SL hit columns. The only difference between
bots is their **entry filters**.

### 1. `pumphawk` — Strict (original)
- **Purpose:** Test the original hypothesis. Tight quality gate.
- **CSV:** `results.csv` / `rejected.csv`
- **Entry filters:**
  - pc_5m: 10–25%
  - mcap: < $80k
  - liq: > $10k
  - buys_5m: 20–250
  - vol_5m: > $1500
  - score: ≥ 70 / 100
  - age: < 60 min
- **Status:** Very few trades (age < 60min filter blocks most of the boost feed)

### 2. `pumphawk-relaxed` — Wide filters (data collection)
- **Purpose:** Collect high-volume data fast. Sacrifice signal quality for sample size.
- **CSV:** `results-relaxed.csv` / `rejected-relaxed.csv`
- **Entry filters:**
  - pc_5m: 5–100%
  - mcap: < $300k
  - liq: > $7k
  - buys_5m: 3–2000
  - vol_5m: > $200
  - score: ≥ 40 / 100
  - age: no cap (99999 min)
  - dedup window: 15 min (re-checks tokens quickly)
- **Status:** Primary data source — 500+ trades collected

### 3. `pumphawk-v4` — Data-driven filters
- **Purpose:** Apply lessons from the first 219-trade analysis. Test whether
  better entry filters improve PnL vs the relaxed baseline.
- **CSV:** `results-v4.csv` / `rejected-v4.csv`
- **Entry filters (derived from analysis):**
  - pc_5m: 5–40% (>40% showed -5.38% avg)
  - mcap: < $100k (>$100k showed -2.40% avg)
  - liq: > $7k
  - buys_5m: 30–300 (sweet spot from data)
  - vol_5m: > $200
  - score: 60–80 (>80 showed -11.59% avg — over-hyped)
  - age: 120–1000 min (avoids 60–120min dead zone: -8.72% avg)
  - dedup window: 15 min
- **Status:** Collecting — needs 50+ trades for statistical confidence

---

## What We Track Per Trade (CSV columns)

Every trade row records:

### Entry snapshot
`entry_price_usd`, `entry_mcap_usd`, `entry_liq_usd`, `entry_buys_5m`,
`entry_vol_5m`, `entry_pc_5m`, `entry_age_min`, `boost_amount`, `total_boosted`, `entry_score`

### Trade outcome
`close_reason` — how the trade closed: `sl`, `tp1+timeout`, `tp2+trail`, `tp2+timeout`, `timeout`
`hold_seconds` — how long the position was open
`peak_multiplier` — highest price reached (vs entry)
`close_multiplier` — weighted exit price (vs entry)

### TP hit flags + timestamps (across full hold window)
| Column | Level |
|--------|-------|
| `hit_tp10` / `time_to_tp10_s` | +10% |
| `hit_tp15` / `time_to_tp15_s` | +15% |
| `hit_tp20` / `time_to_tp20_s` | +20% |
| `hit_tp30` / `time_to_tp30_s` | +30% |
| `hit_tp35` / `time_to_tp35_s` | +35% |
| `hit_tp50` / `time_to_tp50_s` | +50% |
| `hit_tp60` / `time_to_tp60_s` | +60% *(added after 219-trade analysis)* |
| `hit_tp75` / `time_to_tp75_s` | +75% |
| `hit_tp100` / `time_to_tp100_s` | +100% (2x) |
| `hit_tp130` / `time_to_tp130_s` | +130% (2.3x) *(added after 219-trade analysis)* |
| `hit_tp200` / `time_to_tp200_s` | +200% (3x) *(added after 219-trade analysis)* |

### SL hit flags + timestamps
| Column | Level |
|--------|-------|
| `hit_sl10` / `time_to_sl10_s` | -10% |
| `hit_sl15` / `time_to_sl15_s` | -15% |
| `hit_sl20` / `time_to_sl20_s` | -20% |
| `hit_sl30` / `time_to_sl30_s` | -30% *(added after 219-trade analysis)* |
| `hit_sl60` / `time_to_sl60_s` | -60% *(added after 219-trade analysis)* |

### Hypothetical PnL columns
These simulate: "if we had used THIS single TP or SL level instead, what would PnL be?"
- TP columns: exit 100% at TP if hit, else hold to timeout
- SL columns: exit 100% at SL if hit, else hold to timeout

| Column | Meaning |
|--------|---------|
| `pnl_active_strategy` | Actual 3-tranche PnL (current live strategy) |
| `pnl_if_tp15_full` | Exit 100% at +15% if hit |
| `pnl_if_tp20_full` | Exit 100% at +20% if hit |
| `pnl_if_tp30_full` | Exit 100% at +30% if hit |
| `pnl_if_tp35_full` | Exit 100% at +35% if hit |
| `pnl_if_tp50_full` | Exit 100% at +50% if hit |
| `pnl_if_tp100_full` | Exit 100% at +100% if hit |
| `pnl_if_tp130_full` | Exit 100% at +130% if hit |
| `pnl_if_tp200_full` | Exit 100% at +200% if hit |
| `pnl_if_sl10` | Exit at -10% SL if hit |
| `pnl_if_sl15` | Exit at -15% SL if hit |
| `pnl_if_sl20` | Exit at -20% SL if hit |
| `pnl_if_sl30` | Exit at -30% SL if hit |
| `pnl_if_sl60` | Exit at -60% SL if hit |
| `pnl_if_timeout` | Hold entire 600s window, no exit |

### Diagnostics
`rt_sl_fired` — `yes` if the real-time PumpPortal WebSocket SL fired (not the 5s poll)

---

## Analysis Tool

Run `node analyze.js <csv_file>` to find the best TP × SL combination for any bot.

```bash
node analyze.js results-relaxed.csv   # full dataset (500+ trades)
node analyze.js results-v4.csv        # v4 filtered set
node analyze.js results.csv           # strict bot
```

The script tests all TP × SL combinations and ranks by avg PnL.

---

## Key Findings So Far (updated as data grows)

### From 509-trade relaxed analysis (April 2026)

**Best TP/SL combo: TP+60% with SL-10% → +1.54% avg PnL**

| TP Level | Best SL | Win% | Avg PnL |
|----------|---------|------|---------|
| TP+15% | SL-30% | 51% | -0.39% |
| TP+20% | SL-30% | 50% | +0.38% |
| TP+30% | SL-30% | 47% | +0.80% |
| TP+35% | SL-30% | 47% | +1.04% |
| **TP+50%** | **SL-10%** | **38%** | **+1.35%** |
| **TP+60%** | **SL-10%** | **38%** | **+1.54%** |
| TP+75% | SL-10% | 38% | +1.05% |
| TP+100% | SL-10% | 38% | +0.38% |

**Entry filter findings (from 219-trade analysis):**
- `age 60–120min` is a dead zone: -8.72% avg PnL — avoid
- `pc_5m > 40%` is over-pumped: -5.38% avg — avoid
- `score > 80` is counter-intuitively bad: -11.59% avg — over-hyped tokens
- `mcap > $100k` drags: -2.40% avg — stay small cap
- `age 300–1000min` is surprisingly good: +3.20% avg, 58% win rate
- `buys_5m 30–300` is the sweet spot

**Current live strategy (TP+15%/+30%, SL-15%) is suboptimal** — not in top 20.

---

## Open Questions / Next Steps

1. **V4 bot needs 50+ trades** before its entry filter improvement can be confirmed
2. **Create a v5 bot** with optimal exit settings: TP+60%, SL-10% — test on top of best entry filters
3. **Compare bots** once v4 hits 50 trades: run `node analyze.js` on all 3 CSVs and compare top combos
4. **Consider shorter hold timeout** — many timeout exits are flat/negative; 600s may be too long
