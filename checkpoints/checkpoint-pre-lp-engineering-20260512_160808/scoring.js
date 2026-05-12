const CONFIDENCE_ORDER = {
  unknown: 0,
  absent: 1,
  weak: 2,
  moderate: 3,
  strong: 4,
};

export function compareConfidence(actual, minimum) {
  return (CONFIDENCE_ORDER[String(actual || "unknown").toLowerCase()] ?? 0)
    - (CONFIDENCE_ORDER[String(minimum || "moderate").toLowerCase()] ?? 0);
}

function isXUnavailableFailOpenReason(reason = "") {
  return /creditsdepleted|credit|billing|payment|required|rate limited|timeout|missing bearer token|http 402|http 429/i.test(String(reason || ""));
}

export function assignBand(candidate = {}, signals = {}, cfg = {}) {
  const reasons = [];
  const risks = [];
  const narrativeConfidence = String(signals.narrative_confidence || candidate.narrative_confidence || "unknown").toLowerCase();
  const minNarrative = String(cfg.xNarrativeMinConfidence || "moderate").toLowerCase();
  const xUnavailableReason = String(signals.x_unavailable_reason || signals.reason || candidate.x_unavailable_reason || candidate.x_narrative?.reason || "");
  const xFailOpen = cfg.xNarrativeFailOpenOnUnavailable !== false;
  const xFailOpenApplies = xFailOpen && narrativeConfidence === "unknown" && isXUnavailableFailOpenReason(xUnavailableReason);
  const shillBurst = Boolean(signals.shill_burst_flag);
  const activeTvl = Number(candidate.active_tvl);
  const minPoolTvl = Number(cfg.minPoolTvl ?? 15000);
  const openPositions = Number(candidate.open_positions);
  const minPoolOpenPositions = Number(cfg.minPoolOpenPositions ?? 1);
  const fragilityLevel = String(candidate.fragility_level || candidate.entry_fragility_level || "normal").toLowerCase();
  const lpagentConfidence = String(candidate.lpagent_confidence || signals.lpagent_confidence || "").toLowerCase();
  const discordActive = Boolean(candidate.discord_active ?? candidate.discord_signal);

  // ── Standalone hard gate: minimum token age ──
  const ageHours = Number(candidate.token_age_hours);
  const minAge = Number(cfg.minTokenAgeHours ?? cfg.gmgn?.minTokenAgeHours ?? 0);
  if (Number.isFinite(ageHours) && Number.isFinite(minAge) && minAge > 0 && ageHours < minAge) {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: [`age ${ageHours}h < minimum ${minAge}h`],
      risks: ["token too young — high dump probability"],
    };
  }

  // ── Standalone hard gate: minimum fee/TVL ratio ──
  const feeTvl = Number(candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio ?? 0);
  const minFeeTvl = Number(cfg.minFeeActiveTvlRatio ?? 0);
  if (Number.isFinite(feeTvl) && Number.isFinite(minFeeTvl) && minFeeTvl > 0 && feeTvl < minFeeTvl) {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: [`fee/TVL ${feeTvl}% < minimum ${minFeeTvl}%`],
      risks: ["fee engine too weak — insufficient LP yield"],
    };
  }

  // ── Volatility null handling: reject blind deployments ──
  const volatility = candidate.volatility;
  if (volatility == null && (cfg.rejectNullVolatility ?? true)) {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: ["volatility=null (no poolDetail.volatility)"],
      risks: ["blind deployment — no volatility data for range sizing"],
    };
  }

  if (compareConfidence(narrativeConfidence, minNarrative) < 0 && !xFailOpenApplies) {
    return {
      band: "REJECT",
      stage: "x_narrative",
      reasons: [`x narrative ${narrativeConfidence} < ${minNarrative}`],
      risks: narrativeConfidence === "unknown" ? ["x narrative unavailable"] : [],
    };
  }
  if (xFailOpenApplies) {
    reasons.push(`x narrative unavailable; fail-open enabled (${xUnavailableReason || "unknown X failure"})`);
    risks.push("x narrative unavailable — passed only because fail-open is enabled");
  } else {
    reasons.push(`x narrative ${narrativeConfidence}`);
  }

  if (shillBurst) {
    return {
      band: "REJECT",
      stage: "x_narrative",
      reasons: [...reasons, "x shill burst detected"],
      risks: ["coordinated low-quality posting"],
    };
  }

  if (Number.isFinite(activeTvl) && activeTvl < minPoolTvl) {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: [...reasons, `active_tvl ${Math.round(activeTvl)} < ${Math.round(minPoolTvl)}`],
      risks,
    };
  }
  reasons.push(`active_tvl ${Math.round(activeTvl || 0)} cleared`);

  if (Number.isFinite(minPoolOpenPositions) && minPoolOpenPositions > 0 && (!Number.isFinite(openPositions) || openPositions < minPoolOpenPositions)) {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: [...reasons, `open_positions ${Number.isFinite(openPositions) ? openPositions : 0} < ${minPoolOpenPositions}`],
      risks,
    };
  }
  if (Number.isFinite(openPositions)) reasons.push(`open_positions ${openPositions} cleared`);
  else reasons.push(`open_positions unknown (min=${minPoolOpenPositions})`);

  if (fragilityLevel === "ultrafragile") {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: [...reasons, "fragility ultrafragile"],
      risks: [...risks, "pool fragility hard veto"],
    };
  }
  if (fragilityLevel === "fast") risks.push("fragility fast");
  else reasons.push(`fragility ${fragilityLevel}`);

  if (lpagentConfidence === "avoid") {
    return {
      band: "REJECT",
      stage: "pool_quality",
      reasons: [...reasons, "lpagent confidence avoid"],
      risks: [...risks, "LP cohort quality weak"],
    };
  }
  if (lpagentConfidence) reasons.push(`lpagent ${lpagentConfidence}`);

  if (discordActive) {
    reasons.push("discord escalation active");
    return { band: "A", stage: "discord", reasons, risks };
  }

  reasons.push("discord absent → band B");
  return { band: "B", stage: "discord", reasons, risks };
}
