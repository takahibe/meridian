import test from "node:test";
import assert from "node:assert/strict";
import { computeFeeDecayClose } from "../management-rules.js";

function baseArgs(overrides = {}) {
  return {
    managementBand: "B",
    mgmtConfig: {
      feeDecayWarnPct: 35,
      feeDecayClosePctBandA: 65,
      feeDecayClosePctBandB: 50,
      feeDecayClosePctBandC: 45,
      feeDecayImmediatePct: 70,
      feeDecayMinAgeMinutes: 45,
      feeDecayMinAgeMinutesBandA: 60,
      feeDecayMinAgeMinutesBandB: 45,
      feeDecayMinAgeMinutesBandC: 30,
      feeDecayStagnantFeeGrowthUsd: 0.10,
    },
    ageMinutes: 60,
    deployFeeTvl: 10,
    currentFeeTvl: 4,
    snapshots: [
      { unclaimed_fees_usd: 0 },
      { unclaimed_fees_usd: 0.02 },
      { unclaimed_fees_usd: 0.03 },
    ],
    inManualGrace: false,
    ...overrides,
  };
}

test("Band C closes earlier than Band A under identical decay", () => {
  // Band C: minAge=30, closePct=45 → CLOSE at 50min/50% decay
  const c = computeFeeDecayClose(baseArgs({ managementBand: "C", ageMinutes: 50, currentFeeTvl: 5 }));
  assert.equal(c?.action, "FEE_DECAY");

  // Band A: minAge=60, closePct=65 → no close at 50min/50% decay
  const a = computeFeeDecayClose(baseArgs({ managementBand: "A", ageMinutes: 50, currentFeeTvl: 5 }));
  assert.equal(a, null);
});

test("strong fee growth suppresses close even if nominal decay exceeds threshold", () => {
  const args = baseArgs({
    snapshots: [
      { unclaimed_fees_usd: 0 },
      { unclaimed_fees_usd: 1.0 },
      { unclaimed_fees_usd: 2.5 },
    ],
  });
  const result = computeFeeDecayClose(args);
  assert.equal(result, null);
});

test("missing deploy fee metric does not crash", () => {
  const result = computeFeeDecayClose(baseArgs({ deployFeeTvl: null, currentFeeTvl: 0.5 }));
  assert.equal(result?.skip, true);
  assert.equal(result?.action, null);
});

test("immediate close on severe decay (>=70%)", () => {
  const result = computeFeeDecayClose(baseArgs({
    currentFeeTvl: 2, // 80% decay
    snapshots: [
      { unclaimed_fees_usd: 0 },
      { unclaimed_fees_usd: 1.0 },
      { unclaimed_fees_usd: 2.5 },
    ],
  }));
  assert.equal(result?.action, "FEE_DECAY");
  assert.match(result?.reason, /immediate/i);
});

test("computeFeeDecayClose returns identical results for same inputs", () => {
  const args = baseArgs();
  const results = Array.from({ length: 100 }, () => computeFeeDecayClose(args));
  const first = JSON.stringify(results[0]);
  assert.ok(results.every((r) => JSON.stringify(r) === first));
});

test("manual grace blocks fee-decay entirely", () => {
  const result = computeFeeDecayClose(baseArgs({ inManualGrace: true }));
  assert.equal(result, null);
});
