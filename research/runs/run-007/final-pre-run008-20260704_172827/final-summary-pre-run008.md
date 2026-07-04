# Meridian autoresearch run-007 final archive — pre run-008

- archived_at: `2026-07-04T17:28:27.863427Z`
- closed_count: `55`
- open_positions_at_archive: `0`
- net_sol_position_level: `0.037631193`
- winrate: `0.6545`
- profit_factor: `1.5779`
- worst_close_sol: `-0.035809298`
- best_close_sol: `0.016136771`
- archive_dir: `/root/meridian/research/runs/run-007/final-pre-run008-20260704_172827`
- checkpoint_dir: `/root/meridian/checkpoints/autoresearch-pre-run008-20260704_172827`

## Verdict

Run-007 was profitable but exploratory/adaptive, not direct-promotion material, because threshold evolution changed minFeeActiveTvlRatio from 0.24 → 0.29 → 0.30 mid-run despite darwinEnabled=false.

## Phase summaries

- 0.24_initial: n=20, net_sol=-0.007625781, winrate=0.65, worst=-0.021612445, best=0.0095316
- 0.29_transitional: n=5, net_sol=0.015843818, winrate=1.0, worst=2.901e-06, best=0.008289004
- 0.30_evolved: n=30, net_sol=0.029413156, winrate=0.6, worst=-0.035809298, best=0.016136771

## Next action

Start run-008: same meteora_yunus source, same 0.35 SOL sizing, maxPositions=1, minFeeActiveTvlRatio fixed at 0.30, Darwin and threshold evolution frozen.
