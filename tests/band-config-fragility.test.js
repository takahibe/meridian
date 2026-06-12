import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { getBandConfigForPosition } from "../management-rules.js";
import { trackPosition, updatePnlAndCheckExits, getTrackedPosition } from "../state.js";

const REAL_STATE = "./state.json";
const BACKUP_STATE = "./state.json.band-fragility-test-backup";

function backupState() {
  if (fs.existsSync(REAL_STATE)) fs.renameSync(REAL_STATE, BACKUP_STATE);
}

function restoreState() {
  if (fs.existsSync(BACKUP_STATE)) fs.renameSync(BACKUP_STATE, REAL_STATE);
  else if (fs.existsSync(REAL_STATE)) fs.unlinkSync(REAL_STATE);
}

test.before(backupState);
test.after(restoreState);

// Why these tests exist: state.js recomputes fragility every updatePnlAndCheckExits
// and tightens the band thresholds, but the index.js engine used to read the RAW
// config band tables — so a fast-fragility position got the tightened
// upperOorWaitMinutes in one engine and the loose one in the other. Both engines
// must act on the same (fragility-adjusted) thresholds.

const MGMT = {
  stopLossPct: -15,
  trailingTakeProfit: false,
  manualGracePeriodMinutes: 60,
  outOfRangeWaitMinutes: 30,
  upperOorFeeAwareEnabled: false, // isolate band behavior from the fee-aware extension
  managementBands: {
    fallback: "B",
    bandA: { maxVolatility: 1.8 },
    bandB: { maxVolatility: 3.0, upperOorWaitMinutes: 30, lowerOorWaitMinutes: 30 },
    bandC: {},
  },
};

function seedPosition(addr, { fast }) {
  trackPosition({
    position: addr,
    pool: `pool_${addr}`,
    pool_name: "FragilityPool",
    strategy: "spot",
    bin_range: { min: 100, max: 200 },
    amount_sol: 0.5,
    amount_x: 0,
    active_bin: 150,
    bin_step: 100,
    volatility: 2.0, // → Band B
    fee_tvl_ratio: null,
    organic_score: 80,
    // Mature/healthy deploy metadata — zero baseline fragility, momentum drives the score
    // (null here would score as microcap/very-young/weak-organic: Number(null) === 0).
    initial_value_usd: 100_000,
    mcap: 5_000_000,
    token_age_hours: 100,
    signal_snapshot: null,
    management_config: MGMT,
  });
  const state = JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
  const pos = state.positions[addr];
  pos.deployed_at = new Date(Date.now() - 120 * 60_000).toISOString();
  pos.out_of_range_since = new Date(Date.now() - 29 * 60_000).toISOString();
  pos.out_of_range_direction = "upper";
  if (fast) {
    // violent 5m velocity (+12) + sharp 1m acceleration (+10) = score 22 → "fast"
    pos.velocity_5m_pct = 15;
    pos.acceleration_1m_pct = 7;
  }
  fs.writeFileSync(REAL_STATE, JSON.stringify(state, null, 2));
}

const oorData = {
  pnl_pct: 1,
  pnl_pct_suspicious: false,
  in_range: false,
  fee_per_tvl_24h: null,
  unclaimed_fees_usd: 0.05,
  active_bin: 250,
  lower_bin: 100,
  upper_bin: 200,
  age_minutes: 120,
};

test("state.js engine: fast fragility tightens upperOorWaitMinutes (30 → 29)", () => {
  seedPosition("pos_frag_fast", { fast: true });
  const exit = updatePnlAndCheckExits("pos_frag_fast", oorData, MGMT);
  // 29m OOR closes at the tightened 29m limit — at the raw 30m it would still wait
  assert.equal(exit?.action, "OUT_OF_RANGE");
  assert.match(exit?.reason, /limit: 29m/);
});

test("state.js engine: normal fragility keeps the raw 30m wait", () => {
  seedPosition("pos_frag_normal", { fast: false });
  const exit = updatePnlAndCheckExits("pos_frag_normal", oorData, MGMT);
  assert.equal(exit, null);
});

test("index.js engine sees the same tightened threshold via the persisted band table", () => {
  // updatePnlAndCheckExits in the test above persisted management_band_config
  // with a fresh snapshot — getBandConfigForPosition must prefer it.
  const fast = getTrackedPosition("pos_frag_fast");
  const fastBand = getBandConfigForPosition(fast, MGMT);
  assert.equal(fastBand.band, "B");
  assert.equal(fastBand.upperOorWaitMinutes, 29);

  const normal = getTrackedPosition("pos_frag_normal");
  const normalBand = getBandConfigForPosition(normal, MGMT);
  assert.equal(normalBand.upperOorWaitMinutes, 30);
});

test("stale adjusted table (no snapshot in >10m) falls back to raw config bands", () => {
  const staleTracked = {
    management_band: "B",
    management_band_config: { key: "B", upperOorWaitMinutes: 29 },
    snapshots: [{ ts: new Date(Date.now() - 11 * 60_000).toISOString() }],
  };
  const band = getBandConfigForPosition(staleTracked, MGMT);
  assert.equal(band.upperOorWaitMinutes, 30);
});

test("untracked position falls back to the fallback band's raw config", () => {
  const band = getBandConfigForPosition(null, MGMT);
  assert.equal(band.band, "B");
  assert.equal(band.upperOorWaitMinutes, 30);
});
