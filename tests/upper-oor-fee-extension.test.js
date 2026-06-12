import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { computeUpperOorFeeExtension } from "../management-rules.js";
import { trackPosition, updatePnlAndCheckExits } from "../state.js";

const REAL_STATE = "./state.json";
const BACKUP_STATE = "./state.json.upper-oor-fee-test-backup";

function backupState() {
  if (fs.existsSync(REAL_STATE)) fs.renameSync(REAL_STATE, BACKUP_STATE);
}

function restoreState() {
  if (fs.existsSync(BACKUP_STATE)) fs.renameSync(BACKUP_STATE, REAL_STATE);
  else if (fs.existsSync(REAL_STATE)) fs.unlinkSync(REAL_STATE);
}

test.before(backupState);
test.after(restoreState);

// Why these tests exist: a position pumped above range that is still printing fees
// should be allowed to keep earning a LITTLE longer — but never indefinitely. The
// extension must be capped (upperOorFeeMaxExtensions) or a runaway pump turns into
// an unbounded bag-hold against the upper-OOR exit discipline.

const MGMT = {
  stopLossPct: -15,
  trailingTakeProfit: false,
  manualGracePeriodMinutes: 60,
  outOfRangeWaitMinutes: 30,
  upperOorFeeAwareEnabled: true,
  upperOorFeeGrowthMinUsd: 0.10,
  upperOorFeeExtendMinutes: 5,
  upperOorFeeMaxExtensions: 1,
  managementBands: {
    fallback: "B",
    bandA: { maxVolatility: 1.8 },
    bandB: { maxVolatility: 3.0, upperOorWaitMinutes: 30, lowerOorWaitMinutes: 30 },
    bandC: {},
  },
};

function extArgs(overrides = {}) {
  return {
    managementBand: "B",
    mgmtConfig: MGMT,
    currentPnlPct: 2,
    minutesOOR: 30,
    waitLimit: 30,
    snapshots: [
      { unclaimed_fees_usd: 0.10 },
      { unclaimed_fees_usd: 0.30 },
      { unclaimed_fees_usd: 0.60 },
    ],
    extensionsUsed: 0,
    ...overrides,
  };
}

// ── Pure helper ──────────────────────────────────────────────────

test("stagnant fees do not extend the upper-OOR wait", () => {
  const r = computeUpperOorFeeExtension(extArgs({
    snapshots: [
      { unclaimed_fees_usd: 0.10 },
      { unclaimed_fees_usd: 0.11 },
      { unclaimed_fees_usd: 0.12 },
    ],
  }));
  assert.equal(r.extended, false);
  assert.equal(r.waitLimit, 30);
});

test("flowing fees extend the wait by upperOorFeeExtendMinutes", () => {
  const r = computeUpperOorFeeExtension(extArgs());
  assert.equal(r.extended, true);
  assert.equal(r.waitLimit, 35);
  assert.equal(r.extensionCount, 1);
});

test("extension cap (upperOorFeeMaxExtensions) is respected", () => {
  const r = computeUpperOorFeeExtension(extArgs({ extensionsUsed: 1 }));
  assert.equal(r.extended, false);
  assert.equal(r.waitLimit, 30);
});

test("negative PnL never extends — don't bag-hold a losing pump", () => {
  const r = computeUpperOorFeeExtension(extArgs({ currentPnlPct: -1 }));
  assert.equal(r.extended, false);
});

test("upperOorFeeAwareEnabled=false disables the extension entirely", () => {
  const r = computeUpperOorFeeExtension(extArgs({
    mgmtConfig: { ...MGMT, upperOorFeeAwareEnabled: false },
  }));
  assert.equal(r.extended, false);
  assert.equal(r.waitLimit, 30);
});

// ── state.js engine wiring (updatePnlAndCheckExits) ──────────────

function seedUpperOorPosition(addr, { oorMinutesAgo, snapshots }) {
  trackPosition({
    position: addr,
    pool: `pool_${addr}`,
    pool_name: "FeeExtPool",
    strategy: "spot",
    bin_range: { min: 100, max: 200 },
    amount_sol: 0.5,
    amount_x: 0,
    active_bin: 150,
    bin_step: 100,
    volatility: 2.0,
    fee_tvl_ratio: null,
    organic_score: 80,
    // Mature/healthy deploy metadata keeps fragility "normal" so band thresholds stay
    // raw (null here would score as microcap/very-young/weak-organic: Number(null) === 0).
    initial_value_usd: 100_000,
    mcap: 5_000_000,
    token_age_hours: 100,
    signal_snapshot: null,
    management_config: MGMT,
  });
  const state = JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
  const pos = state.positions[addr];
  pos.deployed_at = new Date(Date.now() - 120 * 60_000).toISOString();
  pos.out_of_range_since = new Date(Date.now() - oorMinutesAgo * 60_000).toISOString();
  pos.out_of_range_direction = "upper";
  pos.snapshots = snapshots;
  fs.writeFileSync(REAL_STATE, JSON.stringify(state, null, 2));
}

function upperOorData(unclaimedFeesUsd) {
  return {
    pnl_pct: 2,
    pnl_pct_suspicious: false,
    in_range: false,
    fee_per_tvl_24h: null,
    unclaimed_fees_usd: unclaimedFeesUsd,
    active_bin: 250,
    lower_bin: 100,
    upper_bin: 200,
    age_minutes: 120,
  };
}

test("stagnant fees close at the base upper-OOR wait", () => {
  seedUpperOorPosition("pos_fee_ext_stagnant", {
    oorMinutesAgo: 31,
    snapshots: [{ unclaimed_fees_usd: 0.10 }, { unclaimed_fees_usd: 0.11 }],
  });
  const exit = updatePnlAndCheckExits("pos_fee_ext_stagnant", upperOorData(0.12), MGMT);
  assert.equal(exit?.action, "OUT_OF_RANGE");
  assert.match(exit?.reason, /limit: 30m/);
  const state = JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
  assert.equal(state.positions.pos_fee_ext_stagnant.upper_oor_fee_extensions, 0);
});

test("flowing fees extend once, then the cap forces the close", () => {
  seedUpperOorPosition("pos_fee_ext_flowing", {
    oorMinutesAgo: 31,
    snapshots: [{ unclaimed_fees_usd: 0.10 }, { unclaimed_fees_usd: 0.20 }],
  });

  // Past base wait (30m) with fees still flowing → extension granted, no close yet
  const exit1 = updatePnlAndCheckExits("pos_fee_ext_flowing", upperOorData(0.60), MGMT);
  assert.equal(exit1, null);
  let state = JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
  assert.equal(state.positions.pos_fee_ext_flowing.upper_oor_fee_extensions, 1);

  // Past the extended wait (35m): maxExtensions=1 already used → close even though fees still flow
  state.positions.pos_fee_ext_flowing.out_of_range_since = new Date(Date.now() - 36 * 60_000).toISOString();
  fs.writeFileSync(REAL_STATE, JSON.stringify(state, null, 2));
  const exit2 = updatePnlAndCheckExits("pos_fee_ext_flowing", upperOorData(0.95), MGMT);
  assert.equal(exit2?.action, "OUT_OF_RANGE");
  assert.match(exit2?.reason, /limit: 35m/);
  state = JSON.parse(fs.readFileSync(REAL_STATE, "utf8"));
  assert.equal(state.positions.pos_fee_ext_flowing.upper_oor_fee_extensions, 1);
});
