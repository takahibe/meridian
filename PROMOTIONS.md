# Promotions log

Lineage of config changes promoted from `autoresearch` → `main` after surviving the workflow in `research/README.md`.

Append a new row when (and only when) a research run has:
- ≥ 10 closed positions
- Beat main on net SOL per deploy unit, winrate, AND worst-close tail
- Explainable reason codes (not just numerically higher PnL)
- Manual approval

## Format

| Date | Run ID | Variable | Before (main) | After (main) | Sample N | Δ net SOL/deploy | Δ winrate | Notes |
|------|--------|----------|---------------|--------------|----------|------------------|-----------|-------|
| YYYY-MM-DD | run-NNN | `config.key` | old | new | 10+ | +X.XXX | +YY% | one-line mechanism |

## Entries

_(none yet — first promotion will be appended below this line)_

---

## Reverts

If a promotion turns out to underperform once running on the larger main wallet, log the revert here with date and reason. Reverting is honest — don't pretend a bad promotion didn't happen.

_(none yet)_
