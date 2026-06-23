# Meridian autoresearch run-004 manual SOL PnL review

- Reviewed at: `2026-06-23T10:23:37.601Z`
- Verdict: **DO_NOT_PROMOTE**
- Classification: `exploratory_closed_no_promotion`
- Promotion status: `not_eligible_for_direct_promotion`
- Operational action: stopped meridian-autoresearch after confirming 0 open positions

## Manual SOL PnL method

The persisted records have `pnl_pct`, `pnl_usd`, `amount_sol`, `initial_value_usd`, and `final_value_usd`, but **no exact `pnl_sol` / `net_sol` fields**. Therefore promotion cannot use automatic SOL-normalized compare. For review only, estimated SOL PnL is:

`estimated_sol = amount_sol * pnl_pct / 100`

This matches the USD-implied estimate closely because every deploy was 0.2 SOL.

## Summary

| Window | Closes | W/L/Flat | Avg pct/close | Estimated SOL | Deployed SOL | Worst | Auto-swap failed |
|---|---:|---:|---:|---:|---:|---:|---:|
| All run-004 | 18 | 8/9/1 | -0.0983% | -0.00354 | 3.60 | -1.5% | 7 |
| Last 10 | 10 | 5/4/1 | -0.146% | -0.00292 | 2.00 | -1.48% | 6 |

## Close reasons — all run

| Reason | N | W/L | Sum pct |
|---|---:|---:|---:|
| Upper OOR close (Band B) | 15 | 6/8 | -2.02% |
| Low yield | 1 | 0/1 | -0.10% |
| Trailing TP (Band B) | 1 | 1/0 | 0.34% |
| Upper OOR close (Band C) | 1 | 1/0 | 0.01% |

## Pool concentration — all run

| Pool | N | W/L | Sum pct |
|---|---:|---:|---:|
| FLKR-SOL | 3 | 2/1 | -0.62% |
| FRAG-SOL | 3 | 2/1 | 0.86% |
| WORLDCUP-SOL | 1 | 0/1 | -0.10% |
| HermesWorld-SOL | 1 | 0/1 | -0.17% |
| Daemon-SOL | 3 | 1/2 | -0.20% |
| drooling-SOL | 3 | 1/2 | -1.55% |
| CONDOR-SOL | 3 | 2/1 | 0.01% |
| JTVO-SOL | 1 | 0/0 | 0.00% |

## Interpretation

- Tail-loss behavior was good: worst close only -1.5%, no catastrophic stop-loss cluster.
- EV was not good: estimated SOL PnL was -0.00354 SOL over 3.60 deployed SOL, and all exact SOL fields are missing.
- The run mostly harvested **upper-OOR exits**, not strong fee productivity. Fees were only $0.1508; auto-swap failures occurred 7 times.
- Main conclusion: `meteora_yunus` is useful as a low-tail candidate source lead, but run-004 is **not promotable** to main.

## Next recommended experiment

Do not promote source switch. If we continue research, start run-005 with one cleaner variable: keep `meteora_yunus` discovery but tighten/re-rank for fee productivity before deploy, or instrument exact SOL PnL persistence first so the next run can be judged without pct fallback.
