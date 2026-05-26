/**
 * Research data collector — append-only candidate factors and shadow labels.
 *
 * Purpose: capture deterministic screening variables before the LLM deploy/no-deploy
 * decision, then attach outcome labels when a deployed position eventually closes.
 * Files live under MERIDIAN_DATA_DIR, so production and autoresearch stay isolated.
 */

import fs from "fs";
import path from "path";
import { paths } from "./paths.js";
import { config } from "./config.js";
import { log } from "./logger.js";

const MAX_TEXT = 180;

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(value) {
  return value == null ? null : Boolean(value);
}

function shortText(value, max = MAX_TEXT) {
  if (value == null) return null;
  const s = String(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function collectorEnabled() {
  return config.autoresearch?.dataCollectorEnabled !== false;
}

function shadowLabelsEnabled() {
  return collectorEnabled() && config.autoresearch?.shadowLabelsEnabled !== false;
}

export function summarizeRecentPoolTrend(poolAddress, snapshots = []) {
  const snaps = Array.isArray(snapshots) ? snapshots.filter(Boolean) : [];
  if (!poolAddress || snaps.length < 2) {
    return {
      recent_pnl_drift_pct: null,
      recent_active_bin_drift: null,
      recent_oor_count: snaps.filter((s) => s?.in_range === false).length,
      recent_snapshot_count: snaps.length,
      recent_fee_per_tvl_24h: snaps.at(-1)?.fee_per_tvl_24h ?? null,
    };
  }

  const first = snaps[0];
  const last = snaps[snaps.length - 1];
  const pnlDrift = finiteOrNull(last.pnl_pct) != null && finiteOrNull(first.pnl_pct) != null
    ? finiteOrNull(last.pnl_pct) - finiteOrNull(first.pnl_pct)
    : null;
  const binDrift = finiteOrNull(last.active_bin) != null && finiteOrNull(first.active_bin) != null
    ? finiteOrNull(last.active_bin) - finiteOrNull(first.active_bin)
    : null;

  return {
    recent_pnl_drift_pct: pnlDrift != null ? Math.round(pnlDrift * 100) / 100 : null,
    recent_active_bin_drift: binDrift,
    recent_oor_count: snaps.filter((s) => s?.in_range === false).length,
    recent_snapshot_count: snaps.length,
    recent_fee_per_tvl_24h: finiteOrNull(last.fee_per_tvl_24h),
  };
}

export function buildCandidateFactors({ pool, sw = null, ti = null, x = null, lpSignal = null, banding = null, activeBin = null, recentTrend = null } = {}) {
  const baseMint = pool?.base?.mint || pool?.base_mint || ti?.mint || null;
  const feeTvl = pool?.fee_active_tvl_ratio ?? pool?.fee_tvl_ratio ?? null;
  const volume = pool?.volume_window ?? pool?.volume ?? pool?.volume_24h ?? null;
  const smartWalletCount = sw?.in_pool?.length ?? pool?.smart_wallet_count ?? pool?.gmgn_smart_wallets ?? 0;

  return {
    pool: pool?.pool ?? null,
    pool_name: pool?.name ?? null,
    base_mint: baseMint,
    source: pool?.gmgn ? "gmgn" : "meteora",
    screening_band: banding?.band ?? pool?.screening_band ?? null,
    gmgn_score: finiteOrNull(pool?.gmgn_score),
    active_tvl: finiteOrNull(pool?.active_tvl),
    open_positions: finiteOrNull(pool?.open_positions),
    fee_active_tvl_ratio: finiteOrNull(feeTvl),
    volume: finiteOrNull(volume),
    turnover_pct: finiteOrNull(pool?.active_tvl) > 0 && finiteOrNull(volume) != null
      ? Math.round((finiteOrNull(volume) / finiteOrNull(pool.active_tvl)) * 10000) / 100
      : null,
    volatility: finiteOrNull(pool?.volatility),
    bin_step: finiteOrNull(pool?.bin_step),
    base_fee: finiteOrNull(pool?.base_fee),
    mcap: finiteOrNull(pool?.mcap ?? ti?.mcap),
    token_age_hours: finiteOrNull(pool?.token_age_hours),
    organic_score: finiteOrNull(pool?.organic_score ?? ti?.organic_score),
    holders: finiteOrNull(ti?.holders ?? pool?.holders),
    top10_pct: finiteOrNull(ti?.audit?.top_holders_pct ?? pool?.gmgn_token_info_top10_pct ?? pool?.gmgn_top10_holder_pct),
    bot_holders_pct: finiteOrNull(ti?.audit?.bot_holders_pct ?? pool?.gmgn_bot_holders_pct),
    bundle_pct: finiteOrNull(pool?.bundle_pct ?? pool?.gmgn_bundler_pct),
    sniper_pct: finiteOrNull(pool?.sniper_pct),
    suspicious_pct: finiteOrNull(pool?.suspicious_pct),
    new_wallet_pct: finiteOrNull(pool?.new_wallet_pct),
    price_vs_ath_pct: finiteOrNull(pool?.price_vs_ath_pct ?? pool?.gmgn_price_action?.priceVsAthPct),
    top_cluster_trend: pool?.top_cluster_trend ?? null,
    top_cluster_hold_pct: finiteOrNull(pool?.top_cluster_hold_pct),
    smart_wallets_present: smartWalletCount > 0,
    smart_wallet_count: finiteOrNull(smartWalletCount),
    kol_in_clusters: boolOrNull(pool?.kol_in_clusters),
    discord_active: boolOrNull(pool?.discord_signal),
    narrative_confidence: x?.narrative_confidence ?? null,
    x_narrative_score: finiteOrNull(x?.x_narrative_score),
    x_unavailable_reason: x?.reason ?? null,
    lpagent_confidence: lpSignal?.confidence ?? pool?.lpagent_confidence ?? null,
    fragility_score: finiteOrNull(pool?.entry_fragility_score),
    fragility_level: pool?.entry_fragility_level ?? null,
    recommended_bins_below: finiteOrNull(pool?.recommended_bins_below),
    support_bins_below: finiteOrNull(pool?.support_bins_below),
    active_bin: finiteOrNull(activeBin),
    price_change_pct: finiteOrNull(pool?.gmgn_price_action?.priceChangePct ?? pool?.price_change_pct),
    rsi2: finiteOrNull(pool?.gmgn_price_action?.rsi2),
    max_volume_share_pct: finiteOrNull(pool?.gmgn_price_action?.maxVolumeShare),
    recent_pnl_drift_pct: recentTrend?.recent_pnl_drift_pct ?? null,
    recent_active_bin_drift: recentTrend?.recent_active_bin_drift ?? null,
    recent_oor_count: recentTrend?.recent_oor_count ?? null,
    recent_snapshot_count: recentTrend?.recent_snapshot_count ?? null,
    recent_fee_per_tvl_24h: recentTrend?.recent_fee_per_tvl_24h ?? null,
  };
}

export function recordCandidateObservation(payload = {}) {
  if (!collectorEnabled()) return;
  try {
    const factors = payload.factors || buildCandidateFactors(payload);
    appendJsonl(paths.researchEventsPath, {
      ts: new Date().toISOString(),
      event: "candidate_observation",
      profile: process.env.MERIDIAN_PROFILE || "production",
      run_id: config.autoresearch?.runId ?? null,
      cycle_id: payload.cycleId ?? null,
      selected_for_prompt: payload.selectedForPrompt ?? true,
      deployed: payload.deployed ?? false,
      reject_reason: shortText(payload.rejectReason),
      factors,
    });
  } catch (error) {
    log("collector_warn", `candidate observation skipped: ${error.message}`);
  }
}

export function recordDeployObservation({ position, pool, pool_name, signal_snapshot = null, deploy_result = null } = {}) {
  if (!collectorEnabled()) return;
  try {
    appendJsonl(paths.researchEventsPath, {
      ts: new Date().toISOString(),
      event: "deploy_observation",
      profile: process.env.MERIDIAN_PROFILE || "production",
      run_id: config.autoresearch?.runId ?? null,
      position: position ?? deploy_result?.position ?? null,
      pool: pool ?? deploy_result?.pool ?? null,
      pool_name: pool_name ?? deploy_result?.pool_name ?? null,
      factors: signal_snapshot || {},
      deploy_result: deploy_result ? {
        bin_range: deploy_result.bin_range ?? null,
        range_coverage: deploy_result.range_coverage ?? null,
        amount_y: deploy_result.amount_y ?? null,
        amount_x: deploy_result.amount_x ?? null,
        strategy: deploy_result.strategy ?? null,
        band: deploy_result.band ?? null,
      } : null,
    });
  } catch (error) {
    log("collector_warn", `deploy observation skipped: ${error.message}`);
  }
}

export function buildShadowLabels(perf = {}) {
  const pnlPct = finiteOrNull(perf.pnl_pct);
  const closeReason = String(perf.close_reason || "").toLowerCase();
  const feeYieldPct = finiteOrNull(perf.initial_value_usd) > 0
    ? ((finiteOrNull(perf.fees_earned_usd) || 0) / finiteOrNull(perf.initial_value_usd)) * 100
    : null;
  const rangeEfficiency = finiteOrNull(perf.range_efficiency);

  return {
    label_win: pnlPct != null ? pnlPct >= 0 : null,
    label_loss: pnlPct != null ? pnlPct < 0 : null,
    label_bad_loss: pnlPct != null ? pnlPct <= -5 : null,
    label_stop_loss: closeReason.includes("stop loss"),
    label_low_yield: closeReason.includes("low yield"),
    label_upper_oor: closeReason.includes("upper") || closeReason.includes("pumped far above range"),
    label_lower_oor: closeReason.includes("lower") || closeReason.includes("oor below"),
    label_good_fee_capture: feeYieldPct != null ? feeYieldPct >= Number(config.management.repeatDeployCooldownMinFeeEarnedPct ?? 1) : null,
    label_high_range_efficiency: rangeEfficiency != null ? rangeEfficiency >= 80 : null,
    fee_yield_pct: feeYieldPct != null ? Math.round(feeYieldPct * 100) / 100 : null,
  };
}

export function recordShadowLabel(perf = {}) {
  if (!shadowLabelsEnabled()) return;
  try {
    const labels = buildShadowLabels(perf);
    const record = {
      ts: new Date().toISOString(),
      event: "shadow_label",
      profile: process.env.MERIDIAN_PROFILE || "production",
      run_id: config.autoresearch?.runId ?? null,
      position: perf.position ?? null,
      pool: perf.pool ?? null,
      pool_name: perf.pool_name ?? null,
      base_mint: perf.base_mint ?? perf.signal_snapshot?.base_mint ?? null,
      pnl_pct: finiteOrNull(perf.pnl_pct),
      pnl_usd: finiteOrNull(perf.pnl_usd),
      minutes_held: finiteOrNull(perf.minutes_held),
      range_efficiency: finiteOrNull(perf.range_efficiency),
      close_reason: shortText(perf.close_reason),
      labels,
      factors: perf.signal_snapshot || {},
    };
    appendJsonl(paths.shadowLabelsPath, record);
    appendJsonl(paths.researchEventsPath, record);
  } catch (error) {
    log("collector_warn", `shadow label skipped: ${error.message}`);
  }
}
