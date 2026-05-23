# Meridian Autoresearch

Isolated research profile that runs alongside the live `meridian` PM2 process without touching live state, wallet, or capital.

## Layout

- `research/runs/<run_id>/config.json` — run scaffold: hypothesis, caps, notes.
- `research/runs/<run_id>/results.jsonl` — append-only outcomes (gitignored).
- `profiles/autoresearch/` — runtime data directory: `state.json`, `lessons.json`, `pool-memory.json`, `signal-weights.json`, etc. Fully isolated from main. Gitignored.
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
