import test from "node:test";
import assert from "node:assert/strict";
import { analyzeSecurity, securityFromRankToken } from "../tools/gmgn.js";
import { config } from "../config.js";

// In gmgn screening mode the meteora/hybrid HARD GATES block in screening.js is
// skipped entirely — analyzeSecurity over rank-payload token fields is the ONLY
// security gate. These tests pin that gate: each rejection must carry a reason
// string so funnel reports stay observable (screening-starvation incident).

const g = config.gmgn;

// A rank-payload token that passes every security threshold in config.gmgn.
// Note: no is_honeypot / renounced_* / is_wash_trading fields — the rank
// payload does not carry them.
function cleanRankToken(overrides = {}) {
  return {
    rug_ratio: 0,
    top_10_holder_rate: 0.1,
    bundler_rate: 0,
    rat_trader_amount_rate: 0,
    sniper_count: 0,
    ...overrides,
  };
}

test("clean rank token passes despite missing honeypot/renounce data (unavailable in gmgn mode)", () => {
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken()));
  assert.equal(result.passed, true);
  assert.deepEqual(result.reasons, []);
});

test("rejects rug ratio above maxRugRatio with a funnel-visible reason", () => {
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken({ rug_ratio: g.maxRugRatio + 0.05 })));
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.startsWith("rug ratio")), `reasons: ${result.reasons}`);
});

test("rejects top-10 holder concentration above maxTop10HolderRate", () => {
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken({ top_10_holder_rate: g.maxTop10HolderRate + 0.05 })));
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.startsWith("top10")), `reasons: ${result.reasons}`);
});

test("maps rank field bundler_rate to bundler_trader_amount_rate and rejects above maxBundlerRate", () => {
  // The rank payload names the field bundler_rate; analyzeSecurity reads
  // bundler_trader_amount_rate — the gate only works if the mapping holds.
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken({ bundler_rate: g.maxBundlerRate + 0.05 })));
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.startsWith("bundler")), `reasons: ${result.reasons}`);
});

test("rejects insider (rat trader) rate above maxRatTraderRate", () => {
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken({ rat_trader_amount_rate: g.maxRatTraderRate + 0.05 })));
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.startsWith("insider")), `reasons: ${result.reasons}`);
});

test("rejects sniper count above maxSniperCount", () => {
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken({ sniper_count: g.maxSniperCount + 1 })));
  assert.equal(result.passed, false);
  assert.ok(result.reasons.some((r) => r.startsWith("snipers")), `reasons: ${result.reasons}`);
});

test("collects multiple rejection reasons so the funnel shows every failed signal", () => {
  const result = analyzeSecurity(securityFromRankToken(cleanRankToken({
    rug_ratio: g.maxRugRatio + 0.05,
    rat_trader_amount_rate: g.maxRatTraderRate + 0.05,
  })));
  assert.equal(result.passed, false);
  assert.ok(result.reasons.length >= 2, `expected >=2 reasons, got: ${result.reasons}`);
});

test("securityFromRankToken does not fabricate fields the rank payload lacks", () => {
  // Honeypot/wash/renounce/creator status must stay absent (not e.g. false) so
  // analyzeSecurity skips those checks instead of misreading defaults.
  const sec = securityFromRankToken(cleanRankToken());
  assert.equal(sec.is_honeypot, undefined);
  assert.equal(sec.is_wash_trading, undefined);
  assert.equal(sec.renounced_mint, undefined);
  assert.equal(sec.renounced_freeze_account, undefined);
  assert.equal(sec.creator_token_status, undefined);
});

test("analyzeSecurity still rejects honeypot/renounce when a fuller security payload provides them", () => {
  // Guards the dormant checks: if a future data source supplies these fields,
  // the gate must use them.
  const result = analyzeSecurity({
    ...securityFromRankToken(cleanRankToken()),
    is_honeypot: "yes",
    renounced_mint: false,
  });
  assert.equal(result.passed, false);
  assert.ok(result.reasons.includes("honeypot"), `reasons: ${result.reasons}`);
  assert.ok(result.reasons.includes("mint not renounced"), `reasons: ${result.reasons}`);
});
