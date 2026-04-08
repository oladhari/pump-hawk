# PumpHawk — Solana Boosted Token Sniper

Paper-trading research bot for Solana meme tokens that receive paid Dexscreener boosts.
Built after 6+ bot iterations and 700+ paper trades across multiple strategies.

> **Status:** Paper trading only — no real funds are moved.

---

## How It Works

1. Polls [Dexscreener boost API](https://docs.dexscreener.com) every 60s for newly-boosted Solana tokens
2. Enriches each token with live price, liquidity, volume, and momentum data
3. Applies entry filters (liquidity gate, momentum range, mcap cap, quality score)
4. Opens a paper position for tokens that pass all filters
5. Tracks each position with:
   - **Real-time SL** via PumpPortal WebSocket — catches bonding-curve rugs in <200ms
   - **5s Dexscreener poll** — TP tranche logic + Raydium token coverage
6. Writes `results.csv` and `rejected.csv` for analysis

**Why boosts?** Boosting a token on Dexscreener costs $50–$500+. This creates a real signal — legitimate projects boost; pure rug operators rarely spend that money. A boost drives new traffic to the token page → buying pressure.

---

## Strategy

### Entry Filters (configurable via `.env`)

| Filter | Default | Reason |
|--------|---------|--------|
| `min_liq_usd` | $10,000 | Blocks zero-liq rug tokens (46% of the boost universe) |
| `min_pc_5m` | 10% | Requires current momentum — token is responding to boost |
| `max_pc_5m` | 25% | Blocks over-pumped entries (inconsistent outcomes) |
| `max_mcap_usd` | $80,000 | Small caps only — more upside room |
| `max_age_min` | 60 min | Boost effect fades; stale boosts trade differently |
| `min_score` | 70/100 | Quality gate combining vol, mcap, buys, liq |

### Exit Strategy — 3-Tranche

```
Entry = 1.00x

+15% → sell 50% of position  (Tranche 1)
+30% → sell 30% of position  (Tranche 2, activates runner)
       Runner (20%): 12% trailing stop from peak
-15% → stop-loss, close ALL tranches immediately
600s → timeout, close at market
```

### Real-Time Stop-Loss

The critical fix over earlier versions: for pump.fun bonding-curve tokens, the bot subscribes to PumpPortal WebSocket trade events per position. Every on-chain trade fires a callback. Price is calculated from bonding curve virtual reserves:

```
price = vSolInBondingCurve / vTokensInBondingCurve
```

If price drops ≥15% from entry, SL fires immediately — no poll lag.
Previously a 5s poll meant rug exits at -40% to -97%. Now caught in <200ms.

---

## Results (Paper Trading)

| Strategy | Trades | Win% | Avg PnL | Key issue |
|----------|--------|------|---------|-----------|
| New token sniper | 14 | 43% | ~0% | Entry into pure noise |
| On-chain burst detector | 180 | 5% | ~-50% | Catching scripted pump completions |
| Burst V2 + guards | 38 | 8% | ~-45% | Fundamental problem unfixable |
| **Boosted V1** | **90** | **63%** | **+2.01%** | Catastrophic SL tail (-97% rugs) |
| Boosted V2 + partial exit | 30 | 47% | +1.48% | 47% zero-liq entries |
| **PumpHawk (current)** | collecting | TBD | TBD | All previous issues fixed |

The boost signal is real. +2.01% avg over 90 trades and 63% win rate confirm it. The failures in earlier versions were execution bugs, not signal quality.

---

## File Structure

```
pumphawk/
├── index.js        ← entry point
├── config.js       ← all parameters with env var overrides
├── strategy.js     ← entry filter + scorer (0–100)
├── monitor.js      ← position tracker, real-time SL, CSV writer
├── boosts.js       ← Dexscreener boost poller (60s)
├── enricher.js     ← Dexscreener token snapshot
├── pumpportal.js   ← PumpPortal WebSocket client
├── logger.js       ← timestamped console + bot-history.log
├── package.json
└── .env.example    ← all tunable parameters documented
```

---

## Setup

```bash
git clone <repo>
cd pumphawk
npm install
cp .env.example .env   # optional — all defaults work out of the box
node index.js
```

**Output files created at runtime:**
- `results.csv` — one row per closed trade, full TP/SL tracking + 8 hypothetical PnL columns
- `rejected.csv` — one row per rejected signal (for retrospective analysis)
- `bot-history.log` — all console output with timestamps

---

## Running Two Instances in Parallel

The bot is fully configurable via env vars, so you can run a strict and a relaxed instance simultaneously:

```bash
# Strict (default filters)
node index.js

# Relaxed (wider filters — more trades, for data collection)
V3_MIN_PC5M=5 V3_MAX_PC5M=100 V3_MAX_MCAP=300000 V3_MAX_AGE_MIN=99999 \
V3_MIN_SCORE=40 RESULTS_CSV=results-relaxed.csv REJECTED_CSV=rejected-relaxed.csv \
node index.js
```

---

## Deploying to a Server (systemd)

```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Copy files, install deps
cd /root/pumphawk && npm install

# Create service
cat > /etc/systemd/system/pumphawk.service << 'EOF'
[Unit]
Description=PumpHawk Solana Sniper
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/pumphawk
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

systemctl enable pumphawk && systemctl start pumphawk

# Monitor
journalctl -u pumphawk -f
```

---

## Configuration Reference

All parameters are env vars. Copy `.env.example` to `.env` to override defaults.

| Variable | Default | Description |
|----------|---------|-------------|
| `V3_MIN_PC5M` | 10 | Min 5-min price change % |
| `V3_MAX_PC5M` | 25 | Max 5-min price change % |
| `V3_MAX_MCAP` | 80000 | Max market cap USD |
| `V3_MIN_LIQ` | 10000 | Min liquidity USD |
| `V3_MIN_VOL5M` | 1500 | Min 5-min volume USD |
| `V3_MIN_BUYS5M` | 20 | Min buys in last 5 min |
| `V3_MAX_BUYS5M` | 250 | Max buys in last 5 min |
| `V3_MIN_SCORE` | 70 | Min entry score (0–100) |
| `V3_MAX_AGE_MIN` | 60 | Max token age in minutes |
| `V3_TP1` | 0.15 | Tranche 1 TP (+15%) |
| `V3_TP2` | 0.30 | Tranche 2 TP (+30%) |
| `V3_SL` | -0.15 | Stop-loss (-15%) |
| `V3_RUNNER_TRAIL` | 0.12 | Runner trailing stop (12%) |
| `V3_MAX_HOLD_S` | 600 | Max hold time (seconds) |
| `V3_MAX_POS` | 10 | Max concurrent positions |
| `BOOST_POLL_MS` | 60000 | Boost API poll interval (ms) |
| `BOOST_DEDUP_MS` | 7200000 | Token dedup window (ms) |
| `SOL_PRICE_USD` | 150 | SOL/USD for PP price ratio |
| `RESULTS_CSV` | results.csv | Output file for trades |
| `REJECTED_CSV` | rejected.csv | Output file for rejections |

---

## Infrastructure Cost

Everything runs on free APIs. Only cost is compute.

| Item | Cost |
|------|------|
| Dexscreener boost API | Free |
| Dexscreener token API | Free |
| PumpPortal WebSocket | Free |
| $4/month VPS (DigitalOcean) | $4/month |

---

## License

MIT
