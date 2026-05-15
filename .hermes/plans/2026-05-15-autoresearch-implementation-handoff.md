# Meridian Autoresearch Implementation Handoff

> **For Hermes / next agent:** Use `subagent-driven-development` for implementation. Do not touch live deployment behavior without explicit approval after tests and runtime checks.

**Goal:** Plan and implement an autoresearch harness that improves Meridian's SOL-denominated LP profitability without disturbing the live farmer.

**Primary objectives:**
1. **Do not disturb Meridian live action** — main PM2 `meridian` process, main wallet, main state, and main lessons must remain stable.
2. **Continuously benefit live Meridian** — research runs produce isolated evidence, metrics, and promotion candidates for the main farmer.
3. **Increase SOL profit compoundingly** — promote only rules that improve realized net SOL and reduce tail risk, not merely increase deploy count or USD-marked PnL.

**Current repo/context:**
- Repo: `git@github-takahibe:takahibe/meridian.git`
- Working dir on VPS: `/root/meridian`
- Main branch in use: `experimental`
- Upstream maintainer: `yunus-0x/meridian`
- Upstream branches of interest: `upstream/experimental`, `upstream/autoresearch`
- Maintainer bug fixes already ported locally in commit `ad629d9bee225f53a9b982cfbeb3791f6eaab215`.
- Live PM2 process: `meridian`
- Charon remains dry-run and out of scope.

**Hard safety rules:**
- Never expose or print private keys, API keys, `.env`, seed phrases, or wallet secrets.
- Do not use the main Meridian wallet for autoresearch.
- Do not share mutable files between main and autoresearch profiles.
- Do not let research write main `state.json`, `lessons.json`, `pool-memory.json`, `decision-log.jsonl`, HiveMind cache, or `user-config.json`.
- Prefix all research Telegram/log output with `[AUTORES]` or route separately.
- Start shadow-only; use tiny-wallet live mode only after explicit approval.
- Promotion into main is manual only.

---

## Architecture

Build autoresearch as a separate profile/run system:

```text
main Meridian
  PM2 app: meridian
  wallet: main wallet
  state/logs/lessons/pool memory: main profile

research Meridian
  PM2 app: meridian-autoresearch
  wallet: separate tiny wallet
  profile: autoresearch
  run id: research/runs/run-XXX
  state/logs/lessons/pool memory/decision log/HiveMind cache: isolated paths
```

Use upstream `autoresearch` as reference, but do not blindly merge it. Port deliberately and harden isolation gaps.

---

## Implementation Plan

### Task 1: Create implementation branch

**Objective:** Isolate all autoresearch work from live `experimental`.

**Commands:**
```bash
cd /root/meridian
git fetch origin upstream
git checkout experimental
git pull origin experimental
git checkout -b feat/autoresearch-harness
```

**Verify:**
```bash
git status --short --branch
```
Expected: branch is `feat/autoresearch-harness`; only old unrelated untracked backup files may exist.

**Commit:** none.

---

### Task 2: Audit upstream autoresearch files before porting

**Objective:** Identify exact files and isolation assumptions from upstream.

**Commands:**
```bash
git diff --name-only upstream/experimental..upstream/autoresearch
git diff --stat upstream/experimental..upstream/autoresearch
git log --oneline upstream/experimental..upstream/autoresearch
```

**Expected upstream files:**
- `paths.js`
- `config.js`
- `decision-log.js`
- `ecosystem.config.cjs`
- `hivemind.js`
- `index.js`
- `lessons.js`
- `logger.js`
- `pool-memory.js`
- `state.js`
- `tools/executor.js`
- `research/runs/run-001/config.json`
- `README.md`

**Verify:** Document any additional files before touching code.

**Commit:** none.

---

### Task 3: Port `paths.js` profile abstraction first

**Objective:** Add a single source of truth for profile-specific paths.

**Files:**
- Create/modify: `paths.js`
- Test: `tests/paths-profile.test.js`

**Behavior required:**
- Default profile must preserve current main behavior.
- `MERIDIAN_PROFILE=autoresearch` and `MERIDIAN_DATA_DIR=profiles/autoresearch` must redirect mutable files.
- `pathFor('state.json')`, `pathFor('lessons.json')`, etc. must not point to root when profile is non-main.

**Test cases:**
```js
import test from 'node:test';
import assert from 'node:assert/strict';

// Pseudocode: adapt to exported API.
test('main profile preserves root paths', () => {
  // env unset -> state path ends with /state.json
});

test('autoresearch profile redirects mutable data', () => {
  // env MERIDIAN_PROFILE=autoresearch, MERIDIAN_DATA_DIR=profiles/autoresearch
  // state path contains profiles/autoresearch/state.json
});
```

**Run:**
```bash
node --test tests/paths-profile.test.js
npm run test:syntax
```

**Commit:**
```bash
git add paths.js tests/paths-profile.test.js
git commit -m "feat: add Meridian profile path abstraction"
```

---

### Task 4: Convert mutable modules to profile paths

**Objective:** Remove root-path leakage.

**Files to audit/modify:**
- `state.js`
- `lessons.js`
- `pool-memory.js`
- `decision-log.js`
- `hivemind.js`
- `logger.js`
- `tools/executor.js`
- `briefing.js`
- `smart-wallets.js`
- `strategy-library.js`
- `token-blacklist.js`
- `dev-blocklist.js`
- `telegram.js`
- `setup.js`

**Critical leaks from initial audit:**
- `briefing.js` may read root `state.json` / `lessons.json`.
- `smart-wallets.js` may use root `smart-wallets.json`.
- `strategy-library.js` may use root `strategy-library.json`.
- `token-blacklist.js` may use root `token-blacklist.json`.
- `dev-blocklist.js` may use root `dev-blocklist.json`.
- `telegram.js` may use root `user-config.json`.
- `tools/executor.js` may reference root `gmgn-config.json`.

**Rule:** All mutable files must use profile-aware path helpers. Read-only source files can remain root.

**Tests:**
- Add one test that scans source text for forbidden root literals in known mutable modules.
- Add one integration-style test that writes under a temporary profile dir and verifies root files are untouched.

**Run:**
```bash
node --test tests/profile-isolation.test.js
npm run test:syntax
```

**Commit:**
```bash
git add paths.js state.js lessons.js pool-memory.js decision-log.js hivemind.js logger.js tools/executor.js briefing.js smart-wallets.js strategy-library.js token-blacklist.js dev-blocklist.js telegram.js setup.js tests/profile-isolation.test.js
git commit -m "refactor: route mutable files through profile paths"
```

---

### Task 5: Add autoresearch run config schema

**Objective:** Make research runs explicit and constrained.

**Files:**
- Create: `research/runs/run-001/config.json`
- Create: `research/README.md`
- Optional: `research/schema.json`

**Minimum config fields:**
```json
{
  "run_id": "run-001",
  "mode": "shadow",
  "hypothesis": "Candidate Watcher reduces bad entries and early OOR churn.",
  "capital_budget_pct": 0,
  "max_wallet_sol": 0,
  "daily_loss_limit_sol": 0,
  "max_open_positions": 0,
  "min_deploy_amount_sol": 0,
  "experiment": {
    "type": "candidate_watcher",
    "watch_seconds": 180,
    "tick_seconds": 20
  }
}
```

**Initial mode must be `shadow`, not live.**

**Commit:**
```bash
git add research/
git commit -m "docs: add autoresearch run config scaffold"
```

---

### Task 6: Add PM2 app without enabling capital deployment

**Objective:** Let autoresearch run alongside main, safely shadow-only.

**Files:**
- Modify: `ecosystem.config.cjs`

**PM2 app shape:**
```js
{
  name: 'meridian-autoresearch',
  script: 'index.js',
  env: {
    MERIDIAN_PROFILE: 'autoresearch',
    MERIDIAN_DATA_DIR: 'profiles/autoresearch',
    MERIDIAN_RESEARCH_RUN_ID: 'run-001',
    DRY_RUN: 'true'
  }
}
```

**Verify:**
```bash
pm2 start ecosystem.config.cjs --only meridian-autoresearch --env autoresearch
pm2 status meridian-autoresearch
pm2 logs meridian-autoresearch --lines 80 --nostream --no-color
pm2 stop meridian-autoresearch
```

Expected: starts and stops; no main state modification; logs clearly identify `[AUTORES]` or equivalent profile.

**Commit:**
```bash
git add ecosystem.config.cjs
git commit -m "chore: add shadow-only autoresearch PM2 app"
```

---

### Task 7: Implement Candidate Watcher shadow logging

**Objective:** Test deploy timing without changing live deployment decisions.

**Files:**
- Create: `research/candidate-watcher.js`
- Modify: `index.js` only enough to call shadow logger after candidate screening.
- Append-only output: profile-specific `research/runs/run-001/results.jsonl`.

**Each record should include:**
- timestamp
- run_id
- pool address/name/base mint
- initial candidate metrics
- watcher tick metrics if available
- decision: `would_deploy` / `would_reject` / `insufficient_data`
- reason codes
- later outcome placeholder

**Do not deploy from watcher in this task.**

**Run:**
```bash
node --test tests/candidate-watcher-shadow.test.js
npm run test:syntax
```

**Commit:**
```bash
git add research/candidate-watcher.js index.js tests/candidate-watcher-shadow.test.js
git commit -m "feat: add shadow Candidate Watcher research logs"
```

---

### Task 8: Add promotion report generator

**Objective:** Turn research artifacts into human review reports.

**Files:**
- Create: `scripts/research-report.js`

**Report metrics:**
- candidates observed
- would-deploy count
- would-reject count
- later actual deploy outcome when matched
- early OOR rate
- lower-OOR rate
- realized net SOL where available
- reason-code hit rates
- recommendation: promote / keep testing / reject

**Run:**
```bash
node scripts/research-report.js --run run-001
```

**Commit:**
```bash
git add scripts/research-report.js
git commit -m "feat: add autoresearch promotion report"
```

---

### Task 9: Verification and handoff

**Objective:** Prove main Meridian is not disturbed.

**Commands:**
```bash
npm run test:syntax
node --test tests/paths-profile.test.js tests/profile-isolation.test.js tests/candidate-watcher-shadow.test.js
pm2 status meridian --no-color
python3 - <<'PY'
import json, pathlib
p=pathlib.Path('state.json')
data=json.loads(p.read_text())
print('main_state_positions', len(data.get('positions', [])))
PY
```

**Do not restart live `meridian` unless explicitly approved and current open positions are checked first.**

**Push:**
```bash
git push -u origin feat/autoresearch-harness
```

**Handoff footer required:**
```text
Repo: https://github.com/takahibe/meridian
Branch: feat/autoresearch-harness
Latest pushed commit: <full SHA>
Push confirmation: local HEAD and origin/feat/autoresearch-harness both match <full SHA>
Main live process: meridian PM2 untouched / or restart explicitly approved
Autoresearch process: shadow-only, no capital
Next action: collect shadow Candidate Watcher data and review report before tiny-wallet live mode
```

---

## Promotion Doctrine

A research result graduates only when it satisfies all:
- net SOL improvement vs baseline,
- reduced tail loss / lower-OOR / bad-entry rate,
- enough sample size,
- explainable reason codes,
- zero profile leakage,
- manual approval by Asta.

If a result only increases activity but not SOL profit, reject it. Busy bots are not profitable bots; they are just caffeinated liabilities.
