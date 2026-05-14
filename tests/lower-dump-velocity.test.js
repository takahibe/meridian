import test from "node:test";
import assert from "node:assert/strict";
import { computeLowerDumpVelocityClose } from "../management-rules.js";

function baseArgs(overrides = {}) {
  return {
    strategy: "bid_ask",
    managementBand: "B",
    mgmtConfig: {
      lowerDumpVelocityEnabled: true,
      lowerDumpBinVelocityClose: 20,
      lowerDumpBinVelocityEmergency: 30,
      lowerDumpPnlClosePct: -5,
      lowerDumpLookbackSnapshots: 3,
    },
    activeBin: 100,
    lowerBin: 120,
    oorDirection: "lower",
    currentPnlPct: -6,
    snapshots: [
      { active_bin: 125 },
      { active_bin: 115 },
      { active_bin: 100 },
    ],
    ...overrides,
  };
}

test("RoyalPop-like fast drop triggers close before -15% stop loss", () => {
  const result = computeLowerDumpVelocityClose(baseArgs());
  assert.equal(result?.action, "LOWER_DUMP_VELOCITY");
  assert.match(result?.reason, /dropped 25 bins/i);
});

test("slow lower fill does NOT close prematurely", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({
    snapshots: [
      { active_bin: 123 },
      { active_bin: 122 },
      { active_bin: 121 },
    ],
  }));
  assert.equal(result, null);
});

test("upper-OOR pump does NOT trigger lower dump guard", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({
    oorDirection: "upper",
    snapshots: [
      { active_bin: 100 },
      { active_bin: 130 },
      { active_bin: 140 },
    ],
  }));
  assert.equal(result, null);
});

test("emergency close on 30+ bin drop bypasses PnL check", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({
    currentPnlPct: -2,
    snapshots: [
      { active_bin: 135 },
      { active_bin: 120 },
      { active_bin: 100 },
    ],
  }));
  assert.equal(result?.action, "EMERGENCY_CLOSE");
  assert.equal(result?.emergency, true);
});

test("velocity guard disabled by config", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({
    mgmtConfig: { lowerDumpVelocityEnabled: false },
  }));
  assert.equal(result, null);
});

test("last-N snapshots detect drop even if position age is >60 minutes", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({
    snapshots: [
      { active_bin: 130 },
      { active_bin: 115 },
      { active_bin: 102 },
    ],
  }));
  assert.equal(result?.action, "LOWER_DUMP_VELOCITY");
});

test("missing timestamps / age_minutes does not break last-N mode", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({
    snapshots: [
      { active_bin: 130 },
      { active_bin: 110 },
    ],
  }));
  assert.equal(result?.action, "LOWER_DUMP_VELOCITY");
});

test("non-bid_ask strategy does not trigger", () => {
  const result = computeLowerDumpVelocityClose(baseArgs({ strategy: "spot" }));
  assert.equal(result, null);
});
