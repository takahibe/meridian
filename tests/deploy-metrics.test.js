import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { trackPosition } from "../state.js";

const REAL_STATE = "./state.json";
const BACKUP_STATE = "./state.json.deploy-test-backup";

function backupState() {
  if (fs.existsSync(REAL_STATE)) fs.renameSync(REAL_STATE, BACKUP_STATE);
}
function restoreState() {
  if (fs.existsSync(BACKUP_STATE)) fs.renameSync(BACKUP_STATE, REAL_STATE);
  else if (fs.existsSync(REAL_STATE)) fs.unlinkSync(REAL_STATE);
}

function readState() {
  return JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
}

test.before(backupState);
test.after(restoreState);

function baseArgs(overrides = {}) {
  return {
    position: "pos_test_1",
    pool: "pool_test",
    pool_name: "TestPool",
    strategy: "bid_ask",
    bin_range: { min: 100, max: 200 },
    amount_sol: 0.5,
    amount_x: 0,
    active_bin: 150,
    bin_step: 100,
    volatility: 2.0,
    fee_tvl_ratio: null,
    organic_score: null,
    initial_value_usd: 100,
    mcap: null,
    token_age_hours: null,
    signal_snapshot: null,
    ...overrides,
  };
}

test("trackPosition persists fee_tvl_ratio from signal_snapshot when direct arg is null", () => {
  trackPosition(baseArgs({
    fee_tvl_ratio: null,
    signal_snapshot: { fee_active_tvl_ratio: 0.25 },
  }));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.equal(pos.fee_tvl_ratio, 0.25);
  assert.equal(pos.initial_fee_tvl_24h, 0.25);
});

test("trackPosition persists fee_tvl_ratio from direct arg when provided", () => {
  trackPosition(baseArgs({
    fee_tvl_ratio: 0.3,
    signal_snapshot: { fee_active_tvl_ratio: 0.25 },
  }));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.equal(pos.fee_tvl_ratio, 0.3);
  assert.equal(pos.initial_fee_tvl_24h, 0.3);
});

test("initial_fee_tvl_24h is always set from effective fee_tvl_ratio", () => {
  trackPosition(baseArgs({ fee_tvl_ratio: 0.15 }));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.equal(pos.initial_fee_tvl_24h, pos.fee_tvl_ratio);
});

test("missing signal_snapshot does not crash", () => {
  assert.doesNotThrow(() => trackPosition(baseArgs({ signal_snapshot: null })));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.equal(pos.fee_tvl_ratio, null);
});

test("signal_snapshot with fee_tvl_ratio (not fee_active_tvl_ratio) falls back correctly", () => {
  trackPosition(baseArgs({
    fee_tvl_ratio: null,
    signal_snapshot: { fee_tvl_ratio: 0.15 },
  }));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.equal(pos.fee_tvl_ratio, 0.15);
});

test("deploy_thesis_reasons/risks are persisted from funnel_reasons/funnel_risks", () => {
  trackPosition(baseArgs({
    signal_snapshot: { funnel_reasons: ["a", "b"], funnel_risks: ["x"] },
  }));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.deepEqual(pos.deploy_thesis_reasons, ["a", "b"]);
  assert.deepEqual(pos.deploy_thesis_risks, ["x"]);
});

test("active_tvl_at_deploy and volume_at_deploy are persisted from signal_snapshot", () => {
  trackPosition(baseArgs({
    signal_snapshot: { active_tvl: 50000, volume: 12000 },
  }));
  const state = readState();
  const pos = state.positions.pos_test_1;
  assert.equal(pos.active_tvl_at_deploy, 50000);
  assert.equal(pos.volume_at_deploy, 12000);
});

// Why these tests exist: downside_pct/upside_pct used to bypass both the
// MIN_SAFE_BINS_BELOW floor in dlmm.js and the bins_below safety checks in
// executor.js, letting an LLM-supplied tiny pct produce a 1-bin deploy of real
// money. The runner needs --experimental-test-module-mocks, so it runs in a
// child process (same pattern as agent-deploy-race.test.js).
const pctRunner = fileURLToPath(new URL("./deploy-pct-guard-runner.mjs", import.meta.url));
let _pctGuard = null;
function pctGuardSummary() {
  if (!_pctGuard) {
    const res = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--no-warnings", pctRunner], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `runner failed\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    _pctGuard = JSON.parse(res.stdout.trim().split("\n").pop());
  }
  return _pctGuard;
}

test("downside_pct deploys still respect the MIN_SAFE_BINS_BELOW floor", () => {
  const s = pctGuardSummary();
  assert.ok(
    s.dryRunBinsBelow >= s.minSafeBinsBelow,
    `downside_pct=1 produced ${s.dryRunBinsBelow} bins below — must never deploy under the ${s.minSafeBinsBelow}-bin safety floor`
  );
});

test("auto deploys with pct-range args are blocked by the executor", () => {
  const s = pctGuardSummary();
  assert.match(s.autoDownsideReason ?? "", /manual-only/, "auto deploy with downside_pct must be rejected");
  assert.match(s.autoUpsideReason ?? "", /manual-only/, "untagged deploy with upside_pct must be rejected");
});

test("manual deploys may still use pct-range args", () => {
  const s = pctGuardSummary();
  // Blocked by the NEXT check (out-of-range bin_step), proving the pct gate let it through
  assert.match(s.manualDownsideReason ?? "", /bin_step/, "manual pct deploy must reach the bin_step check");
  assert.doesNotMatch(s.manualDownsideReason ?? "", /manual-only/, "manual pct deploy must not hit the pct gate");
});
