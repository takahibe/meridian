# Meridian Autoresearch

Isolated research profile that runs alongside the live `meridian` PM2 process without touching live state, wallet, or capital.

## Layout

- `research/runs/<run_id>/config.json` — run scaffold: hypothesis, caps, notes.
- `research/runs/<run_id>/results.jsonl` — append-only outcomes (gitignored).
- `profiles/autoresearch/` — runtime data directory: `state.json`, `lessons.json`, `pool-memory.json`, `signal-weights.json`, etc. Fully isolated from main. Gitignored.
- `profiles/autoresearch/research-events.jsonl` — append-only deterministic candidate/deploy/shadow-label events. Used for factor discovery only.
- `profiles/autoresearch/shadow-labels.jsonl` — append-only closed-position labels joined back to deploy-time `signal_snapshot` factors.
- `.env.autoresearch` — per-profile env overrides; at minimum a separate `WALLET_PRIVATE_KEY`. Gitignored.

## Boot

```
pm2 start ecosystem.config.cjs --only meridian-autoresearch
pm2 logs meridian-autoresearch --lines 80
pm2 stop meridian-autoresearch
```

## Safety guarantees

1. `runAutoresearchStartupGuard()` in `index.js` refuses to start if:
   - `MERIDIAN_DATA_DIR` is unset or resolves to project root
   - `WALLET_PRIVATE_KEY` is unset
   - The autoresearch wallet matches the production wallet stored in project-root `user-config.json`
2. `hiveMindPublishMode` defaults to `"off"` for the autoresearch profile, so lessons never flow to shared HiveMind from this process.
3. Telegram alerts get `[AUTORES] ` prefix injected at the `postTelegram` layer so every outbound is distinguishable from main.
4. `DRY_RUN=true` is set in the PM2 env block; the autoresearch process cannot execute on-chain transactions.

## Promotion doctrine

A research result graduates only when it satisfies all of:
- Net SOL improvement vs baseline
- Reduced tail loss / lower-OOR / bad-entry rate
- Sufficient sample size
- Explainable reason codes
- Zero profile leakage (no writes to project-root state files)
- Manual approval

Busy bots are not profitable bots; activity alone is not promotion-worthy.

## Shadow factor collection

The live agent and autoresearch profile both collect deterministic factors without changing deploy rules. Current default factor variables include:

- `recent_pnl_drift_pct` — repeat-pool PnL drift over recent management snapshots.
- `recent_active_bin_drift` — active-bin movement over recent snapshots.
- `recent_oor_count` — recent out-of-range frequency.
- `fee_active_tvl_ratio`, `turnover_pct`, `volatility`, `fragility_score`, `price_vs_ath_pct`, `top_cluster_trend`, `bot_holders_pct`, `smart_wallet_count`, `lpagent_confidence`.

Candidate next autoresearch variable after HENRY-SOL: `recent_pnl_drift_pct`. Treat it as shadow-only until enough labels show it predicts net SOL / tail-loss better than current memory heuristics.
