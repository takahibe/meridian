import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
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
