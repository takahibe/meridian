import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolate every file write (user-config.json, lessons.json, logs) into a
// throwaway profile dir — evolveThresholds persists changes via paths.js,
// and these tests must never touch the live project root.
process.env.MERIDIAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-evolve-"));

const { evolveThresholds } = await import("../lessons.js");

function mockConfig(overrides = {}) {
  return {
    screening: {
      minFeeActiveTvlRatio: 0.05,
      minOrganic: 60,
      xNarrativeMinConfidence: "moderate",
      maxVolatility: 5.0,
      ...overrides.screening,
    },
    management: {
      bandDeployEnabled: false,
      bandBSizeMultiplier: 0.5,
      ...overrides.management,
    },
    darwin: { windowDays: 60, ...overrides.darwin },
  };
}

function close({ pnl, feeTvl = 0.05, organic = 70, daysAgo = 1, band = null, pnlUsd } = {}) {
  return {
    pnl_pct: pnl,
    pnl_usd: pnlUsd ?? (pnl >= 0 ? 2 : -2),
    fee_tvl_ratio: feeTvl,
    organic_score: organic,
    volatility: 2.0,
    screening_band: band,
    recorded_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  };
}

function many(n, args) {
  return Array.from({ length: n }, () => close(args));
}

test("dead regime anchoring blocked: losers outside the 60d window do not move thresholds", () => {
  const winners = many(10, { pnl: 10, organic: 80, daysAgo: 2 });

  // 10 low-organic losers from a 90-day-old regime — invisible to evolution.
  const oldLosers = many(10, { pnl: -20, organic: 20, daysAgo: 90 });
  const r1 = evolveThresholds([...oldLosers, ...winners], mockConfig());
  assert.equal(r1.changes.minOrganic, undefined,
    "stale losers must not ratchet minOrganic");

  // The identical losers dated inside the window DO move it — proving the
  // window, not a broken rule, is what blocked the change above.
  const recentLosers = many(10, { pnl: -20, organic: 20, daysAgo: 5 });
  const r2 = evolveThresholds([...recentLosers, ...winners], mockConfig());
  assert.ok(r2.changes.minOrganic > 60,
    "in-window losers with an organic gap should raise minOrganic");
});

test("small-N drift blocked: 9 losers and 9 winners do not move thresholds", () => {
  // Strong winner/loser separation on every signal — but one record short of
  // the 10-record minimum per rule, so nothing may move on noise this thin.
  const cfg = mockConfig();
  const perf = [
    ...many(9, { pnl: -20, organic: 20, feeTvl: 0.02, daysAgo: 3 }),
    ...many(9, { pnl: 10, organic: 90, feeTvl: 0.5, daysAgo: 2 }),
  ];
  const result = evolveThresholds(perf, cfg);
  assert.deepEqual(result.changes, {}, "no threshold may move below 10 qualifying records");
  assert.equal(cfg.screening.minOrganic, 60, "live config must stay untouched");
  assert.equal(cfg.screening.minFeeActiveTvlRatio, 0.05, "live config must stay untouched");
});

test("screening starvation blocked: minFeeActiveTvlRatio cannot ratchet above 0.30", () => {
  // 12 winners with fee_tvl=5.0 would previously walk the floor toward 10.0,
  // silently starving the screener — the clamp must hold it at 0.30.
  const cfg = mockConfig({ screening: { minFeeActiveTvlRatio: 0.30 } });
  const perf = [
    ...many(12, { pnl: 15, feeTvl: 5.0, daysAgo: 2 }),
    ...many(10, { pnl: -20, feeTvl: 5.0, daysAgo: 3 }), // losers present → no decay path
  ];
  const result = evolveThresholds(perf, cfg);
  assert.equal(result.changes.minFeeActiveTvlRatio, undefined,
    "already at the 0.30 ceiling — no further ratchet allowed");
  assert.equal(cfg.screening.minFeeActiveTvlRatio, 0.30);
});

test("organic over-tightening blocked: minOrganic cannot ratchet above 75", () => {
  // Winners at organic 95 vs losers at 20 used to allow a climb toward 90,
  // rejecting nearly every token — the new ceiling holds at 75.
  const cfg = mockConfig({ screening: { minOrganic: 75 } });
  const perf = [
    ...many(10, { pnl: 10, organic: 95, daysAgo: 2 }),
    ...many(10, { pnl: -20, organic: 20, daysAgo: 3 }),
  ];
  const result = evolveThresholds(perf, cfg);
  assert.equal(result.changes.minOrganic, undefined,
    "already at the 75 ceiling — no further ratchet allowed");
  assert.equal(cfg.screening.minOrganic, 75);
});

test("decay does not undershoot defaults: keys already at config.js defaults stay put", () => {
  // Zero losers in window with everything at defaults — decay has nothing to
  // unwind and must not push thresholds below their config.js baselines.
  const cfg = mockConfig();
  const result = evolveThresholds(many(6, { pnl: 10, daysAgo: 2 }), cfg);
  assert.deepEqual(result.changes, {}, "nothing to decay at defaults");
  assert.equal(cfg.screening.minFeeActiveTvlRatio, 0.05);
  assert.equal(cfg.screening.minOrganic, 60);
  assert.equal(cfg.screening.xNarrativeMinConfidence, "moderate");
});

test("one-way ratchet broken: zero losers in window decays evolved keys toward defaults", () => {
  // Thresholds tightened by a dead regime must relax once recent closes show
  // no losers — otherwise a single bad month pins the screener shut forever.
  const cfg = mockConfig({
    screening: { minFeeActiveTvlRatio: 0.30, minOrganic: 75, xNarrativeMinConfidence: "strong" },
  });
  const result = evolveThresholds(many(6, { pnl: 10, daysAgo: 2 }), cfg);
  assert.ok(
    result.changes.minFeeActiveTvlRatio < 0.30 && result.changes.minFeeActiveTvlRatio >= 0.05,
    `minFeeActiveTvlRatio should step toward 0.05, got ${result.changes.minFeeActiveTvlRatio}`,
  );
  assert.ok(
    result.changes.minOrganic < 75 && result.changes.minOrganic >= 60,
    `minOrganic should step toward 60, got ${result.changes.minOrganic}`,
  );
  assert.equal(result.changes.xNarrativeMinConfidence, "moderate",
    "narrative floor relaxes one step back toward default");
  // Decay is applied to the live config like any other evolution
  assert.equal(cfg.screening.minOrganic, result.changes.minOrganic);
});

test("inert knob frozen: bandBSizeMultiplier not evolved while bandDeployEnabled=false", () => {
  // The multiplier only affects deploys when bandDeployEnabled=true (dlmm.js);
  // with it off, evolution would just grind the knob to its 0.2 floor.
  const bandBLosers = many(16, { pnl: -10, pnlUsd: -3, band: "B", daysAgo: 2 });

  const off = mockConfig();
  const r1 = evolveThresholds(bandBLosers, off);
  assert.equal(r1.changes.bandBSizeMultiplier, undefined,
    "disabled band deploys → multiplier must not move");
  assert.equal(off.management.bandBSizeMultiplier, 0.5);
  // The narrative tightening still applies — only the inert multiplier is frozen
  assert.equal(r1.changes.xNarrativeMinConfidence, "strong");

  const on = mockConfig({ management: { bandDeployEnabled: true } });
  const r2 = evolveThresholds(bandBLosers, on);
  assert.equal(r2.changes.bandBSizeMultiplier, 0.4,
    "enabled band deploys → losses reduce the multiplier as before");
});

test("dead knob removed: maxVolatility is no longer evolved (maxVolatilityHard is the real gate)", () => {
  // Losers clustered at low volatility used to tighten the soft maxVolatility,
  // but no gate reads it — only the static maxVolatilityHard blocks deploys.
  const cfg = mockConfig();
  const perf = [
    ...many(10, { pnl: -20, daysAgo: 3 }),
    ...many(3, { pnl: 10, daysAgo: 2 }),
  ];
  const result = evolveThresholds(perf, cfg);
  assert.ok(!("maxVolatility" in result.changes), "maxVolatility must never appear in changes");
  assert.equal(cfg.screening.maxVolatility, 5.0, "soft ceiling left untouched");
});
