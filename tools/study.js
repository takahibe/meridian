import { config } from "../config.js";

const AGENT_MERIDIAN_API = config.api.url;
const AGENT_MERIDIAN_PUBLIC_KEY =
  config.api.publicApiKey || process.env.PUBLIC_API_KEY || "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";

export async function studyTopLPers({ pool_address, limit = 4 }) {
  const headers = { "x-api-key": AGENT_MERIDIAN_PUBLIC_KEY };
  const [poolRes, signalRes] = await Promise.all([
    fetch(`${AGENT_MERIDIAN_API}/top-lp/${pool_address}`, { headers }),
    fetch(`${AGENT_MERIDIAN_API}/study-top-lp/${pool_address}`, { headers }),
  ]);

  if (!poolRes.ok) {
    if (poolRes.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before studying this pool again.");
    }
    throw new Error(`top-lp API error: ${poolRes.status}`);
  }

  if (!signalRes.ok) {
    if (signalRes.status === 429) {
      throw new Error("Rate limit exceeded. Please wait 60 seconds before studying this pool again.");
    }
    throw new Error(`study-top-lp API error: ${signalRes.status}`);
  }

  const poolData = await poolRes.json();
  const signalData = await signalRes.json();
  const topLpers = Array.isArray(poolData.topLpers) ? poolData.topLpers : [];
  const historicalOwners = Array.isArray(poolData.historicalOwners) ? poolData.historicalOwners : [];
  const ranked = topLpers.slice(0, Math.max(1, limit));

  if (!ranked.length) {
    return {
      pool: pool_address,
      message: "No LPAgent top LPer data found for this pool yet.",
      patterns: {},
      lpers: [],
    };
  }

  const historicalMap = new Map(historicalOwners.map((owner) => [owner.owner, owner]));

  const lpers = ranked.map((owner) => {
    const history = historicalMap.get(owner.owner);
    return {
      owner: owner.owner,
      owner_short: owner.ownerShort || `${owner.owner.slice(0, 8)}...`,
      signal_tags: [
        history?.preferredStrategy ? `strategy:${history.preferredStrategy}` : null,
        history?.preferredRangeStyle ? `range:${history.preferredRangeStyle}` : null,
      ].filter(Boolean),
      summary: {
        total_positions: owner.totalLp || history?.topPositions?.length || 0,
        avg_hold_hours: round(owner.avgAgeHours ?? history?.avgHoldHours ?? 0, 2),
        avg_open_pnl_pct: round(owner.pnlPerInflowPct ?? history?.avgPnlPct ?? 0, 2),
        avg_fee_per_tvl_24h_pct: round(owner.feePercent ?? history?.avgFeePercent ?? 0, 2),
        total_pnl_usd: round(owner.totalPnlUsd ?? 0, 2),
        total_balance_usd: round(owner.totalInflowUsd ?? 0, 2),
        avg_range_width_pct: null,
        avg_distance_to_active_pct: null,
        win_rate: round((owner.winRatePct ?? 0) / 100, 2),
        roi: round((owner.roiPct ?? 0) / 100, 4),
        fee_pct_of_capital: round(owner.feePercent ?? 0, 2),
        preferred_strategy: history?.preferredStrategy || "unknown",
        preferred_range_style: history?.preferredRangeStyle || "unknown",
      },
      positions: Array.isArray(history?.topPositions)
        ? history.topPositions.map((position) => ({
            pool: pool_address,
            pair: poolData.overview?.name || "Unknown pool",
            hold_hours: round(position.ageHours ?? 0, 2),
            pnl_usd: round(position.pnlUsd ?? 0, 2),
            pnl_pct: fmtPct(position.pnlPct),
            fee_usd: round(position.feeUsd ?? 0, 2),
            in_range_pct: position.inRange == null ? null : position.inRange ? 100 : 0,
            strategy: position.strategy || null,
            closed_reason: position.rangeStyle || null,
            balance_usd: round(position.inputValue ?? 0, 2),
            fee_per_tvl_24h_pct: round(position.feePercent ?? 0, 2),
            range_width_pct: position.widthBins ?? null,
            distance_to_active_pct: null,
            lower_bin_id: position.lowerBinId ?? null,
            upper_bin_id: position.upperBinId ?? null,
          }))
        : [],
    };
  });

  const patterns = buildPatterns(ranked, historicalOwners, signalData, poolData.overview || {});
  const screeningSignal = buildScreeningSignal(patterns, poolData.overview || {});

  return {
    pool: pool_address,
    pool_name:
      poolData.overview?.name ||
      `${poolData.overview?.tokenXSymbol || "TOKEN"}-${poolData.overview?.tokenYSymbol || "SOL"}`,
    message:
      "LPAgent-backed top LP study from Agent Meridian 30m cached owner aggregates plus owner historical positions.",
    patterns,
    screening_signal: screeningSignal,
    lpers,
  };
}

function buildScreeningSignal(patterns, overview) {
  const ownerCount = Number(patterns?.owner_count || 0);
  const avgHoldHours = Number(patterns?.avg_hold_hours || 0);
  const avgFeePercent = Number(patterns?.avg_fee_percent || 0);
  const avgRoiPct = Number(patterns?.avg_roi_pct || 0);
  const holderCount = Number(patterns?.holder_count || 0);
  const scalperCount = Number(patterns?.scalper_count || 0);
  const feePct = Number(overview?.feePct || 0);

  let score = 0;
  const reasons = [];
  const risks = [];

  if (ownerCount >= 8) { score += 2; reasons.push(`deep LP cohort (${ownerCount})`); }
  else if (ownerCount >= 4) { score += 1; reasons.push(`some LP cohort depth (${ownerCount})`); }
  else risks.push(`thin LP cohort (${ownerCount})`);

  if (avgFeePercent >= 8) { score += 2; reasons.push(`top LPers harvest meaningful fees (${round(avgFeePercent, 2)}%)`); }
  else if (avgFeePercent >= 3) { score += 1; reasons.push(`top LPers collect some fees (${round(avgFeePercent, 2)}%)`); }
  else risks.push(`top LPers show weak fee capture (${round(avgFeePercent, 2)}%)`);

  if (avgRoiPct >= 10) { score += 1; reasons.push(`cohort ROI positive (${round(avgRoiPct, 2)}%)`); }
  else if (avgRoiPct < 0) { score -= 1; risks.push(`cohort ROI negative (${round(avgRoiPct, 2)}%)`); }

  if (avgHoldHours >= 24 && avgHoldHours <= 24 * 21) { score += 1; reasons.push(`hold duration looks usable (${round(avgHoldHours, 1)}h avg)`); }
  else if (avgHoldHours > 24 * 45) { score -= 1; risks.push(`LP cohort is stale (${round(avgHoldHours, 1)}h avg age)`); }

  if (holderCount > scalperCount && holderCount >= 2) reasons.push(`holder cohort dominates (${holderCount} vs ${scalperCount})`);
  if (scalperCount > holderCount && scalperCount >= 2) risks.push(`mostly scalper cohort (${scalperCount} vs ${holderCount})`);
  if (feePct > 0 && avgFeePercent > 0 && avgFeePercent < feePct * 3) risks.push(`LPAgent fee capture looks modest versus pool fee (${round(avgFeePercent, 2)}% vs ${round(feePct, 2)}%)`);

  const confidence = score >= 4 ? "strong" : score >= 2 ? "moderate" : score >= 0 ? "weak" : "avoid";
  return {
    confidence,
    score,
    reasons,
    risks,
  };
}

function buildPatterns(ranked, historicalOwners, signalData, overview) {
  const avgHold = avg(ranked.map((o) => o.avgAgeHours).filter(isNum));
  const avgOpenPnlPct = avg(ranked.map((o) => o.pnlPerInflowPct).filter(isNum));
  const avgFeePct = avg(ranked.map((o) => o.feePercent).filter(isNum));
  const avgRoiPct = avg(ranked.map((o) => o.roiPct).filter(isNum));
  const preferredStrategies = countValues(historicalOwners.map((o) => o.preferredStrategy).filter(Boolean));
  const preferredRanges = countValues(historicalOwners.map((o) => o.preferredRangeStyle).filter(Boolean));

  return {
    top_lper_count: ranked.length,
    study_mode: "lpagent_top_lpers",
    pool_name:
      overview.name || `${overview.tokenXSymbol || "TOKEN"}-${overview.tokenYSymbol || "SOL"}`,
    active_position_count: signalData.activePositionCount ?? ranked.length,
    owner_count: signalData.ownerCount ?? ranked.length,
    avg_hold_hours: round(avgHold, 2),
    avg_open_pnl_pct: round(avgOpenPnlPct, 2),
    avg_fee_percent: round(avgFeePct, 2),
    avg_roi_pct: round(avgRoiPct, 2),
    best_open_pnl_pct: ranked[0] ? `${round(ranked[0].pnlPerInflowPct || 0, 2)}%` : null,
    scalper_count: ranked.filter((o) => (o.avgAgeHours || 0) < 1).length,
    holder_count: ranked.filter((o) => (o.avgAgeHours || 0) >= 4).length,
    preferred_strategies: preferredStrategies,
    preferred_range_styles: preferredRanges,
    top_historical_owners: (signalData.topHistoricalOwners || []).slice(0, 3),
    suggested_style: signalData.suggestedStyle || null,
  };
}

function countValues(values) {
  const map = new Map();
  for (const value of values) {
    map.set(value, (map.get(value) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function isNum(value) {
  return Number.isFinite(Number(value));
}

function fmtPct(value) {
  const n = Number(value || 0);
  return `${n >= 0 ? "+" : ""}${round(n, 2)}%`;
}
