// support-risk-mode.js — pure helpers for approval-gated support-unverified entries.
//
// This module is intentionally inert unless config.screening.supportUnverifiedRiskMode
// is true. It does not deploy; it only classifies missing-support bid_ask candidates
// and computes a per-cycle max deploy cap consumed by the existing staged-signal
// executor guard.

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function resolveSupportUnverifiedMaxDeploySol(config = {}, fallbackDeployAmount = null) {
  const configured = finiteNumber(config.screening?.supportUnverifiedMaxDeploySol);
  const reduced = finiteNumber(config.management?.deployAmountSolMin);
  const fallback = finiteNumber(fallbackDeployAmount);
  const candidates = [configured, reduced, fallback].filter((n) => n != null && n > 0);
  return candidates.length ? Math.min(...candidates) : 0.35;
}

export function evaluateSupportUnverifiedGate({ pool = {}, strategy = null, supportCoverage = null, config = {} } = {}) {
  if (supportCoverage) {
    return { action: "normal", allow: true, supportUnverified: false, reason: null };
  }
  if (strategy !== "bid_ask") {
    return { action: "normal", allow: true, supportUnverified: false, reason: null };
  }

  const cfg = config.screening || {};
  if (cfg.supportUnverifiedRiskMode !== true) {
    return {
      action: "reject",
      allow: false,
      supportUnverified: false,
      reason: "no supertrend/BB support data for bid_ask entry",
    };
  }

  const volatility = finiteNumber(pool.volatility);
  const maxVolatility = finiteNumber(cfg.supportUnverifiedMaxVolatility) ?? 3.0;
  if (volatility != null && volatility > maxVolatility) {
    return {
      action: "reject",
      allow: false,
      supportUnverified: false,
      reason: `missing support data and volatility ${volatility} > support-unverified max ${maxVolatility}`,
    };
  }

  const fragilityScore = finiteNumber(pool.entry_fragility_score);
  const maxFragilityScore = finiteNumber(cfg.supportUnverifiedMaxFragilityScore) ?? 25;
  if (fragilityScore != null && fragilityScore > maxFragilityScore) {
    return {
      action: "reject",
      allow: false,
      supportUnverified: false,
      reason: `missing support data and fragility ${fragilityScore} > support-unverified max ${maxFragilityScore}`,
    };
  }

  return {
    action: "allow_capped",
    allow: true,
    supportUnverified: true,
    reason: "support-unverified risk mode: missing supertrend/BB support data, capped deployment only",
  };
}

export function applySupportUnverifiedRiskMode(pool = {}, decision = {}, config = {}, deployAmount = null) {
  if (!decision.supportUnverified) return pool;
  const maxDeploySol = resolveSupportUnverifiedMaxDeploySol(config, deployAmount);
  pool.support_unverified = true;
  pool.support_unverified_reason = decision.reason;
  pool.max_deploy_sol = maxDeploySol;
  pool.funnel_risks = Array.from(new Set([...(pool.funnel_risks || []), "support_unverified"]));
  return pool;
}

export function candidateDeployAmount(pool = {}, defaultDeployAmount = 0, config = {}) {
  const defaultAmount = finiteNumber(defaultDeployAmount) ?? 0;
  if (pool.support_unverified) {
    const cap = finiteNumber(pool.max_deploy_sol) ?? resolveSupportUnverifiedMaxDeploySol(config, defaultAmount);
    return Math.min(defaultAmount, cap);
  }
  return defaultAmount;
}
