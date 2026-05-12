import test from "node:test";
import assert from "node:assert/strict";
import { assignBand } from "../tools/scoring.js";

const cfg = {
  xNarrativeMinConfidence: "moderate",
  minPoolTvl: 15000,
  minPoolOpenPositions: 1,
  minFeeActiveTvlRatio: 0.1,
};

function passingCandidate(overrides = {}) {
  return {
    active_tvl: 50000,
    open_positions: 5,
    fee_active_tvl_ratio: 0.2,
    volatility: 1.2,
    fragility_level: "normal",
    ...overrides,
  };
}

test("rejects weak X narrative after basic pool quality gates pass", () => {
  const result = assignBand(passingCandidate({
    discord_active: true,
  }), {
    narrative_confidence: "weak",
    shill_burst_flag: false,
  }, cfg);

  assert.equal(result.band, "REJECT");
  assert.equal(result.stage, "x_narrative");
});

test("rejects shill burst even if narrative score would otherwise pass", () => {
  const result = assignBand(passingCandidate(), {
    narrative_confidence: "strong",
    shill_burst_flag: true,
  }, cfg);

  assert.equal(result.band, "REJECT");
  assert.match(result.reasons.join(" "), /shill burst/i);
});

test("pool quality veto beats discord escalation", () => {
  const result = assignBand(passingCandidate({
    fragility_level: "ultrafragile",
    discord_active: true,
  }), {
    narrative_confidence: "strong",
    shill_burst_flag: false,
  }, cfg);

  assert.equal(result.band, "REJECT");
  assert.equal(result.stage, "pool_quality");
});

test("discord candidates become band A", () => {
  const result = assignBand(passingCandidate({
    open_positions: 3,
    lpagent_confidence: "moderate",
    discord_active: true,
  }), {
    narrative_confidence: "moderate",
    shill_burst_flag: false,
  }, cfg);

  assert.equal(result.band, "A");
});

test("non-discord candidates become band B after passing hard gates", () => {
  const result = assignBand(passingCandidate({
    open_positions: 3,
    fragility_level: "fast",
    lpagent_confidence: "moderate",
    discord_active: false,
  }), {
    narrative_confidence: "strong",
    shill_burst_flag: false,
  }, cfg);

  assert.equal(result.band, "B");
  assert.match(result.risks.join(" "), /fragility fast/i);
});

test("fails open when X is unavailable due depleted credits", () => {
  const result = assignBand(passingCandidate({
    open_positions: 3,
    discord_active: false,
  }), {
    narrative_confidence: "unknown",
    x_unavailable_reason: "http 402: CreditsDepleted",
    shill_burst_flag: false,
  }, { ...cfg, xNarrativeFailOpenOnUnavailable: true });

  assert.equal(result.band, "B");
  assert.match(result.reasons.join(" "), /fail-open enabled/i);
  assert.match(result.risks.join(" "), /x narrative unavailable/i);
});

test("does not fail open for healthy weak narrative", () => {
  const result = assignBand(passingCandidate({
    open_positions: 3,
    discord_active: false,
  }), {
    narrative_confidence: "weak",
    reason: "healthy API response",
    shill_burst_flag: false,
  }, { ...cfg, xNarrativeFailOpenOnUnavailable: true });

  assert.equal(result.band, "REJECT");
  assert.equal(result.stage, "x_narrative");
});

test("fail-open X still loses to later pool quality gates", () => {
  const result = assignBand(passingCandidate({
    active_tvl: 10000,
    open_positions: 3,
    discord_active: false,
  }), {
    narrative_confidence: "unknown",
    x_unavailable_reason: "http 402: CreditsDepleted",
    shill_burst_flag: false,
  }, { ...cfg, xNarrativeFailOpenOnUnavailable: true });

  assert.equal(result.band, "REJECT");
  assert.equal(result.stage, "pool_quality");
  assert.match(result.reasons.join(" "), /fail-open enabled/i);
  assert.match(result.reasons.join(" "), /active_tvl/i);
});
