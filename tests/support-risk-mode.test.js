import assert from "node:assert/strict";
import test from "node:test";

import {
  applySupportUnverifiedRiskMode,
  candidateDeployAmount,
  evaluateSupportUnverifiedGate,
  resolveSupportUnverifiedMaxDeploySol,
} from "../support-risk-mode.js";

const baseConfig = {
  strategy: { strategy: "bid_ask" },
  screening: {
    supportUnverifiedRiskMode: false,
    supportUnverifiedMaxDeploySol: 0.35,
    supportUnverifiedMaxVolatility: 3.0,
    supportUnverifiedMaxFragilityScore: 25,
  },
  management: { deployAmountSolMin: 0.35 },
};

test("support-unverified mode is inactive by default and preserves hard reject", () => {
  const decision = evaluateSupportUnverifiedGate({
    pool: { volatility: 1.5, entry_fragility_score: 10 },
    strategy: "bid_ask",
    supportCoverage: null,
    config: baseConfig,
  });

  assert.equal(decision.allow, false);
  assert.match(decision.reason, /no supertrend\/BB support data/);
});

test("support-unverified mode allows only capped candidates when explicitly enabled", () => {
  const config = {
    ...baseConfig,
    screening: { ...baseConfig.screening, supportUnverifiedRiskMode: true },
  };
  const pool = { volatility: 1.7, entry_fragility_score: 12 };
  const decision = evaluateSupportUnverifiedGate({ pool, strategy: "bid_ask", supportCoverage: null, config });

  assert.equal(decision.allow, true);
  assert.equal(decision.supportUnverified, true);

  applySupportUnverifiedRiskMode(pool, decision, config, 0.75);
  assert.equal(pool.support_unverified, true);
  assert.equal(pool.max_deploy_sol, 0.35);
  assert.equal(candidateDeployAmount(pool, 0.75, config), 0.35);
});

test("support-unverified mode still rejects excessive volatility or fragility", () => {
  const config = {
    ...baseConfig,
    screening: { ...baseConfig.screening, supportUnverifiedRiskMode: true },
  };

  assert.equal(evaluateSupportUnverifiedGate({
    pool: { volatility: 3.2, entry_fragility_score: 10 },
    strategy: "bid_ask",
    supportCoverage: null,
    config,
  }).allow, false);

  assert.equal(evaluateSupportUnverifiedGate({
    pool: { volatility: 1.2, entry_fragility_score: 30 },
    strategy: "bid_ask",
    supportCoverage: null,
    config,
  }).allow, false);
});

test("confirmed support and non-bid_ask entries bypass support-unverified mode", () => {
  const config = {
    ...baseConfig,
    screening: { ...baseConfig.screening, supportUnverifiedRiskMode: true },
  };

  assert.deepEqual(evaluateSupportUnverifiedGate({
    pool: {},
    strategy: "bid_ask",
    supportCoverage: { bins: 20 },
    config,
  }), { action: "normal", allow: true, supportUnverified: false, reason: null });

  assert.equal(evaluateSupportUnverifiedGate({
    pool: {},
    strategy: "spot",
    supportCoverage: null,
    config,
  }).allow, true);
});

test("max deploy resolver chooses the safest positive cap", () => {
  assert.equal(resolveSupportUnverifiedMaxDeploySol({
    screening: { supportUnverifiedMaxDeploySol: 0.5 },
    management: { deployAmountSolMin: 0.35 },
  }, 0.75), 0.35);
});
