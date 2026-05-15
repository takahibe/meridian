import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { trackPosition, updatePnlAndCheckExits } from "../state.js";

const REAL_STATE = "./state.json";
const BACKUP_STATE = "./state.json.low-yield-test-backup";

function backupState() {
  if (fs.existsSync(REAL_STATE)) fs.renameSync(REAL_STATE, BACKUP_STATE);
}

function restoreState() {
  if (fs.existsSync(BACKUP_STATE)) fs.renameSync(BACKUP_STATE, REAL_STATE);
  else if (fs.existsSync(REAL_STATE)) fs.unlinkSync(REAL_STATE);
}

test.before(backupState);
test.after(restoreState);

test("low-yield check uses configured minAgeBeforeYieldCheck without ReferenceError", () => {
  const deployedAt = new Date(Date.now() - 90 * 60_000).toISOString();

  trackPosition({
    position: "pos_low_yield_1",
    pool: "pool_low_yield",
    pool_name: "LowYieldPool",
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
  });

  const state = JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
  state.positions.pos_low_yield_1.deployed_at = deployedAt;
  fs.writeFileSync(REAL_STATE, JSON.stringify(state, null, 2));

  const exit = updatePnlAndCheckExits(
    "pos_low_yield_1",
    {
      pnl_pct: 0,
      in_range: true,
      fee_per_tvl_24h: 1,
      active_bin: 150,
      lower_bin: 100,
      upper_bin: 200,
      age_minutes: 90,
    },
    {
      minFeePerTvl24h: 7,
      minAgeBeforeYieldCheck: 60,
      manualGracePeriodMinutes: 60,
      trailingTakeProfit: false,
      managementBands: { fallback: "B", bandA: {}, bandB: {}, bandC: {} },
    },
  );

  assert.equal(exit?.action, "LOW_YIELD");
  assert.match(exit?.reason, /Low yield/);
});
