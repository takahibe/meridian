# Meridian Autoresearch Run-001 Handoff — 2026-05-24

Purpose: return to this session when Meridian autoresearch run-001 reaches **10 closed positions** or **14 days**, whichever comes first.

## User instruction
Asta approved:
- Let run-001 finish.
- Keep run-001 labeled **exploratory**.
- When it reaches 10 positions or 14 days, report back and then move to step 2: freeze Darwin in autoresearch before starting run-002.

## Current state when saved
- Repo: `github.com/takahibe/meridian`
- Branch: `feat/autoresearch-foundation`
- Run config: `research/runs/run-001/config.json`
- Autoresearch profile data: `profiles/autoresearch/`
- Existing 10-close monitor cron: `Meridian autoresearch run-001 10-close monitor`, job id `be870e614c8a`, script `~/.hermes/scripts/meridian_autoresearch_run001_monitor.py`
- Run-001 was labeled exploratory in commit `37a0399`.

## Run-001 label
`research/runs/run-001/config.json` contains:
- `classification: exploratory`
- `promotion_status: not_eligible_for_direct_promotion`
- reason: generic `outOfRangeWaitMinutes` test is drifted vs current band-specific OOR/management config; use for signal discovery only, not direct promotion.

## Review command
Use:

```bash
cd /root/meridian
node scripts/research-compare.js --json
```

Also inspect:

```bash
python3 - <<'PY'
import json
from pathlib import Path
perf=json.loads(Path('profiles/autoresearch/lessons.json').read_text()).get('performance', [])
print('autoresearch closes:', len(perf))
PY
```

## Next action after threshold report
Do **not** promote run-001 directly.
After review with Asta, move to step 2:
- freeze Darwin in autoresearch (`darwinEnabled: false`),
- then start clean run-002 with one falsifiable config hypothesis.

## Doctrine reference
- LLM Wiki: `wiki/concepts/meridian-autoresearch-workflow.md`
- Skill reference: `meridian-lp-engineering/references/meridian-autoresearch-workflow-2026-05-24.md`
