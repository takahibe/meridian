/**
 * Agent learning system.
 *
 * After each position closes, performance is analyzed and lessons are
 * derived. These lessons are injected into the system prompt so the
 * agent avoids repeating mistakes and doubles down on what works.
 */

import fs from "fs";
import { paths } from "./paths.js";
import { log } from "./logger.js";
import { getSharedLessonsForPrompt, pushHiveLesson, pushHivePerformanceEvent } from "./hivemind.js";
import { getTrackedPosition } from "./state.js";
import { recordShadowLabel } from "./data-collector.js";

const USER_CONFIG_PATH = paths.userConfigPath;
const LESSONS_FILE = paths.lessonsPath;
const MIN_EVOLVE_POSITIONS = 5;   // don't evolve until we have real data
const MAX_CHANGE_PER_STEP  = 0.20; // never shift a threshold more than 20% at once
const MIN_RULE_RECORDS     = 10;  // per-rule qualifying records before a threshold may move
const EVOLVE_WINDOW_MAX_CLOSES = 100; // evolve from recent closes only, never full lifetime
const DECAY_STEP = 0.10; // zero losers in window → step evolved keys 10% back toward defaults
// config.js defaults for the evolved keys — decay targets when the window has no losers
const EVOLVE_DEFAULTS = {
  minFeeActiveTvlRatio: 0.05,
  minOrganic: 60,
  xNarrativeMinConfidence: "moderate",
};
const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
  "recent_pnl_drift_pct",
  "recent_active_bin_drift",
  "recent_oor_count",
  "recent_snapshot_count",
  "recent_fee_per_tvl_24h",
];
const MAX_MANUAL_LESSON_LENGTH = 400;

function sanitizeLessonText(text, maxLen = MAX_MANUAL_LESSON_LENGTH) {
  if (text == null) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

function load() {
  if (!fs.existsSync(LESSONS_FILE)) {
    return { lessons: [], performance: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(LESSONS_FILE, "utf8"));
  } catch {
    return { lessons: [], performance: [] };
  }
}

function save(data) {
  fs.writeFileSync(LESSONS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Tag the most recent performance record for a pool with `dumped_on_close`.
 * Called from executor.js when the post-close auto-swap exhausts retries,
 * so screener/evolveThresholds can penalize similar profiles.
 */
export async function tagAutoSwapFailure(poolAddress) {
  if (!poolAddress) return;
  const data = load();
  for (let i = data.performance.length - 1; i >= 0; i--) {
    if (data.performance[i]?.pool === poolAddress) {
      const existing = String(data.performance[i].close_reason || "");
      if (!existing.includes("dumped_on_close")) {
        data.performance[i].close_reason = existing
          ? `${existing} | dumped_on_close`
          : "dumped_on_close";
        data.performance[i].auto_swap_failed = true;
        save(data);
        log("lessons", `Tagged ${poolAddress.slice(0, 8)} as dumped_on_close`);
      }
      return;
    }
  }
}

function buildSignalSnapshot(perf) {
  const snapshot = { ...(perf.signal_snapshot || {}) };
  if (perf.base_mint && snapshot.base_mint == null) snapshot.base_mint = perf.base_mint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && perf[field] != null) {
      snapshot[field] = perf[field];
    }
  }
  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMaybe(value, decimals = 6) {
  const n = finiteNumber(value);
  if (n == null) return null;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function buildSolPnlFields(perf) {
  const initialSol = finiteNumber(perf.initial_value_sol ?? perf.initial_sol);
  const finalSol = finiteNumber(perf.final_value_sol ?? perf.withdrawn_sol ?? perf.final_sol);
  const feesSol = finiteNumber(perf.fees_earned_sol ?? perf.fee_earned_sol);
  const explicitPnlSol = finiteNumber(perf.pnl_sol ?? perf.net_sol);
  const explicitPnlSolPct = finiteNumber(perf.pnl_sol_pct ?? perf.pnl_pct_sol);

  const hasSolComponents = initialSol != null && finalSol != null && feesSol != null;
  const pnlSol = hasSolComponents
    ? (finalSol + feesSol) - initialSol
    : explicitPnlSol;
  const pnlSolPct = initialSol != null && initialSol > 0 && pnlSol != null
    ? (pnlSol / initialSol) * 100
    : explicitPnlSolPct;

  const fields = {};
  if (initialSol != null) fields.initial_value_sol = roundMaybe(initialSol, 9);
  if (finalSol != null) fields.final_value_sol = roundMaybe(finalSol, 9);
  if (feesSol != null) fields.fees_earned_sol = roundMaybe(feesSol, 9);
  if (pnlSol != null) {
    fields.pnl_sol = roundMaybe(pnlSol, 9);
    // Alias used by research-compare.js. At position level this is realized SOL
    // PnL from Meteora deposits/withdrawals/fees; gas is accounted separately.
    fields.net_sol = roundMaybe(pnlSol, 9);
    fields.pnl_basis = "sol";
  }
  if (pnlSolPct != null) fields.pnl_sol_pct = roundMaybe(pnlSolPct, 6);
  return fields;
}

// ─── Record Position Performance ──────────────────────────────

/**
 * Call this when a position closes. Captures performance data and
 * derives a lesson if the outcome was notably good or bad.
 *
 * @param {Object} perf
 * @param {string} perf.position       - Position address
 * @param {string} perf.pool           - Pool address
 * @param {string} perf.pool_name      - Pool name (e.g. "Mustard-SOL")
 * @param {string} perf.strategy       - "spot" | "curve" | "bid_ask"
 * @param {number} perf.bin_range      - Bin range used
 * @param {number} perf.bin_step       - Pool bin step
 * @param {number} perf.volatility     - Pool volatility at deploy time
 * @param {number} perf.fee_tvl_ratio  - fee/TVL ratio at deploy time
 * @param {number} perf.organic_score  - Token organic score at deploy time
 * @param {number} perf.amount_sol     - Amount deployed
 * @param {number} perf.fees_earned_usd - Total fees earned (USD)
 * @param {number} perf.fees_earned_sol - Total fees earned (SOL), from closed Meteora PnL when available
 * @param {number} perf.final_value_usd - Value when closed (USD withdrawals)
 * @param {number} perf.initial_value_usd - Value when opened (USD deposits)
 * @param {number} perf.final_value_sol - SOL withdrawn when closed, from closed Meteora PnL when available
 * @param {number} perf.initial_value_sol - SOL deposited when opened, from closed Meteora PnL when available
 * @param {number} perf.minutes_in_range  - Total minutes position was in range
 * @param {number} perf.minutes_held      - Total minutes position was held
 * @param {string} perf.close_reason   - Why it was closed
 */
export async function recordPerformance(perf) {
  const data = load();

  // Guard against unit-mixed records where a SOL-sized final value is
  // accidentally written into a USD field (e.g. final_value_usd = 2 for a 2 SOL close).
  const suspiciousUnitMix =
    Number.isFinite(perf.initial_value_usd) &&
    Number.isFinite(perf.final_value_usd) &&
    Number.isFinite(perf.amount_sol) &&
    perf.initial_value_usd >= 20 &&
    perf.amount_sol >= 0.25 &&
    perf.final_value_usd > 0 &&
    perf.final_value_usd <= perf.amount_sol * 2;

  if (suspiciousUnitMix) {
    log("lessons_warn", `Skipped suspicious performance record for ${perf.pool_name || perf.pool}: initial=${perf.initial_value_usd}, final=${perf.final_value_usd}, amount_sol=${perf.amount_sol}`);
    return;
  }

  const pnl_usd = (perf.final_value_usd + perf.fees_earned_usd) - perf.initial_value_usd;
  const pnl_pct = perf.initial_value_usd > 0
    ? (pnl_usd / perf.initial_value_usd) * 100
    : 0;
  const range_efficiency = perf.minutes_held > 0
    ? (perf.minutes_in_range / perf.minutes_held) * 100
    : 0;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const suspiciousAbsurdClosedPnl =
    Number.isFinite(pnl_pct) &&
    perf.initial_value_usd >= 20 &&
    pnl_pct <= -90 &&
    !closeReasonText.includes("stop loss");

  if (suspiciousAbsurdClosedPnl) {
    log("lessons_warn", `Skipped absurd closed PnL record for ${perf.pool_name || perf.pool}: pnl_pct=${pnl_pct.toFixed(2)} reason=${perf.close_reason}`);
    return;
  }

  const tracked = perf.position ? getTrackedPosition(perf.position) : null;
  const signalSnapshot = buildSignalSnapshot({
    ...perf,
    signal_snapshot: perf.signal_snapshot || tracked?.signal_snapshot || null,
  });
  const screeningBand = perf.screening_band || signalSnapshot?.screening_band || tracked?.screening_band || null;

  const entry = {
    ...perf,
    ...buildSolPnlFields(perf),
    signal_snapshot: signalSnapshot,
    screening_band: screeningBand,
    pnl_usd: Math.round(pnl_usd * 100) / 100,
    pnl_pct: Math.round(pnl_pct * 100) / 100,
    range_efficiency: Math.round(range_efficiency * 10) / 10,
    recorded_at: new Date().toISOString(),
  };

  data.performance.push(entry);
  recordShadowLabel(entry);

  // Derive and store a lesson
  const lesson = derivLesson(entry);
  if (lesson) {
    data.lessons.push(lesson);
    log("lessons", `New lesson: ${lesson.rule}`);
  }

  save(data);
  if (lesson) {
    void pushHiveLesson(lesson);
  }

  // Update pool-level memory
  if (perf.pool) {
    const { recordPoolDeploy } = await import("./pool-memory.js");
    recordPoolDeploy(perf.pool, {
      pool_name: perf.pool_name,
      base_mint: perf.base_mint,
      deployed_at: perf.deployed_at,
      closed_at: entry.recorded_at,
      pnl_pct: entry.pnl_pct,
      pnl_usd: entry.pnl_usd,
      pnl_sol: entry.pnl_sol,
      net_sol: entry.net_sol,
      pnl_sol_pct: entry.pnl_sol_pct,
      range_efficiency: entry.range_efficiency,
      minutes_held: perf.minutes_held,
      fees_earned_usd: perf.fees_earned_usd,
      fees_earned_sol: entry.fees_earned_sol,
      fee_earned_pct: perf.initial_value_usd > 0 ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100 : null,
      close_reason: perf.close_reason,
      strategy: perf.strategy,
      volatility: perf.volatility,
      screening_band: screeningBand,
      signal_snapshot: signalSnapshot,
    });
  }

  // Evolve thresholds every 5 closed positions
  if (data.performance.length % MIN_EVOLVE_POSITIONS === 0) {
    const { config, reloadScreeningThresholds } = await import("./config.js");
    const result = evolveThresholds(data.performance, config);
    if (result?.changes && Object.keys(result.changes).length > 0) {
      reloadScreeningThresholds();
      log("evolve", `Auto-evolved thresholds: ${JSON.stringify(result.changes)}`);
    }

    // Darwinian signal weight recalculation
    if (config.darwin?.enabled) {
      const { recalculateWeights } = await import("./signal-weights.js");
      const wResult = recalculateWeights(data.performance, config);
      if (wResult.changes.length > 0) {
        log("evolve", `Darwin: adjusted ${wResult.changes.length} signal weight(s)`);
      }
    }
  }

  void pushHivePerformanceEvent({
    ...entry,
    base_mint: perf.base_mint || null,
    fees_earned_sol: perf.fees_earned_sol || 0,
    eventId: `close:${perf.position}:${entry.recorded_at}`,
  });

}

/**
 * Derive a lesson from a closed position's performance.
 * Only generates a lesson if the outcome was clearly good or bad.
 */
function derivLesson(perf) {
  const tags = [];
  const feeYieldPct = perf.initial_value_usd > 0
    ? ((perf.fees_earned_usd || 0) / perf.initial_value_usd) * 100
    : 0;

  // Categorize outcome
  const outcome = perf.pnl_pct >= 5 ? "good"
    : (perf.pnl_pct >= 0 && feeYieldPct >= 2) ? "good"
    : perf.pnl_pct >= 0 ? "neutral"
    : perf.pnl_pct >= -5 ? "poor"
    : "bad";

  if (outcome === "neutral") return null; // nothing interesting to learn

  // Build context description
  const context = [
    `${perf.pool_name}`,
    `strategy=${perf.strategy}`,
    `bin_step=${perf.bin_step}`,
    `volatility=${perf.volatility}`,
    `fee_tvl_ratio=${perf.fee_tvl_ratio}`,
    `organic=${perf.organic_score}`,
    `bin_range=${typeof perf.bin_range === 'object' ? JSON.stringify(perf.bin_range) : perf.bin_range}`,
  ].join(", ");

  let rule = "";

  if (outcome === "good" || outcome === "bad") {
    if (perf.range_efficiency < 30 && outcome === "bad") {
      rule = `AVOID: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — went OOR ${100 - perf.range_efficiency}% of the time. Consider wider bin_range or bid_ask strategy.`;
      tags.push("oor", perf.strategy, `volatility_${Math.round(perf.volatility)}`);
    } else if (perf.range_efficiency > 80 && outcome === "good") {
      rule = `PREFER: ${perf.pool_name}-type pools (volatility=${perf.volatility}, bin_step=${perf.bin_step}) with strategy="${perf.strategy}" — ${perf.range_efficiency}% in-range efficiency, PnL +${perf.pnl_pct}%.`;
      tags.push("efficient", perf.strategy);
    } else if (outcome === "bad" && perf.close_reason?.includes("volume")) {
      rule = `AVOID: Pools with fee_tvl_ratio=${perf.fee_tvl_ratio} that showed volume collapse — fees evaporated quickly. Minimum sustained volume check needed before deploying.`;
      tags.push("volume_collapse");
    } else if (outcome === "good") {
      rule = `WORKED: ${context} → PnL +${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%.`;
      tags.push("worked");
    } else {
      rule = `FAILED: ${context} → PnL ${perf.pnl_pct}%, range efficiency ${perf.range_efficiency}%. Reason: ${perf.close_reason}.`;
      tags.push("failed");
    }
  }

  if (!rule) return null;

  const closeReasonText = String(perf.close_reason || "").toLowerCase();
  const positiveEvidence =
    feeYieldPct >= 1 ||
    (perf.fees_earned_usd || 0) >= 3 ||
    perf.pnl_pct >= 3;
  const negativeEvidence =
    perf.pnl_pct <= -5 ||
    perf.range_efficiency <= 30 ||
    closeReasonText.includes("out of range") ||
    closeReasonText.includes("oor") ||
    closeReasonText.includes("low yield") ||
    closeReasonText.includes("volume");

  let confidence = 0.35;
  if (outcome === "good") {
    confidence = positiveEvidence ? 0.82 : 0.22;
  } else if (outcome === "bad") {
    confidence = negativeEvidence ? 0.88 : 0.45;
  } else if (outcome === "poor") {
    confidence = negativeEvidence ? 0.68 : 0.32;
  }

  return {
    id: Date.now(),
    rule,
    tags,
    outcome,
    sourceType: "performance",
    confidence: Math.round(confidence * 100) / 100,
    context,
    pnl_pct: perf.pnl_pct,
    fees_earned_usd: perf.fees_earned_usd,
    initial_value_usd: perf.initial_value_usd,
    range_efficiency: perf.range_efficiency,
    close_reason: perf.close_reason,
    pool: perf.pool,
    created_at: new Date().toISOString(),
  };
}

// ─── Adaptive Threshold Evolution ──────────────────────────────

/**
 * Analyze closed position performance and evolve screening thresholds.
 * Writes changes to user-config.json and returns a summary.
 *
 * @param {Array}  perfData - Array of performance records (from lessons.json)
 * @param {Object} config   - Live config object (mutated in place)
 * @returns {{ changes: Object, rationale: Object } | null}
 */
export function evolveThresholds(perfData, config) {
  if (!perfData || perfData.length < MIN_EVOLVE_POSITIONS) return null;

  // ── Recency window ────────────────────────────────────────────
  // Only the last EVOLVE_WINDOW_MAX_CLOSES closes inside the darwin window
  // count — full-lifetime history lets dead market regimes anchor thresholds.
  const windowDays = config.darwin?.windowDays ?? 60;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffISO = cutoff.toISOString();
  const recent = perfData
    .filter((p) => {
      const ts = p.recorded_at || p.closed_at || p.deployed_at;
      return ts && ts >= cutoffISO;
    })
    .slice(-EVOLVE_WINDOW_MAX_CLOSES);

  const winners = recent.filter((p) => p.pnl_pct > 0);
  const losers  = recent.filter((p) => p.pnl_pct < -5);

  // Need at least some signal in both directions before adjusting.
  // A window with closes but zero losers is also signal: it triggers decay.
  const decayEligible = recent.length > 0 && losers.length === 0;
  const hasSignal = winners.length >= 2 || losers.length >= 2;
  if (!hasSignal && !decayEligible) return null;

  const changes   = {};
  const rationale = {};

  // ── (removed) maxVolatility evolution ─────────────────────────
  // FROZEN: no gate reads the soft config.screening.maxVolatility — the real
  // ceiling is the static maxVolatilityHard (tools/executor.js, index.js).
  // Evolving a dead knob only overfits; the key stays in config.js untouched.

  // ── 2. minFeeTvlRatio ─────────────────────────────────────────
  // Raise the floor if low-fee pools consistently underperform.
  {
    const winnerFees = winners.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const loserFees  = losers.map((p) => p.fee_tvl_ratio).filter(isFiniteNum);
    const current    = config.screening.minFeeActiveTvlRatio;

    if (winnerFees.length >= MIN_RULE_RECORDS) {
      // 10th-percentile fee/TVL among winners — outlier-resistant floor for what works
      const winnerFeeP10 = percentile(winnerFees, 10);
      if (winnerFeeP10 > current * 1.2) {
        const target  = winnerFeeP10 * 0.85; // stay slightly below the winner floor
        // hard ceiling 0.30 — runaway ratchet here starves screening entirely
        const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 0.30);
        const rounded = Number(newVal.toFixed(2));
        if (rounded > current) {
          changes.minFeeActiveTvlRatio = rounded;
          rationale.minFeeActiveTvlRatio = `Winner p10 fee_tvl=${winnerFeeP10.toFixed(2)} — raised floor from ${current} → ${rounded}`;
        }
      }
    }

    if (loserFees.length >= MIN_RULE_RECORDS) {
      // If losers all had high fee/TVL, that's noise (pumps then crash) — don't raise min
      // But if losers had low fee/TVL, raise min
      const maxLoserFee = Math.max(...loserFees);
      if (maxLoserFee < current * 1.5 && winnerFees.length > 0) {
        const minWinnerFee = Math.min(...winnerFees);
        if (minWinnerFee > maxLoserFee) {
          const target  = maxLoserFee * 1.2;
          const newVal  = clamp(nudge(current, target, MAX_CHANGE_PER_STEP), 0.05, 0.30);
          const rounded = Number(newVal.toFixed(2));
          if (rounded > current && !changes.minFeeActiveTvlRatio) {
            changes.minFeeActiveTvlRatio = rounded;
            rationale.minFeeActiveTvlRatio = `Losers had fee_tvl<=${maxLoserFee.toFixed(2)}, winners higher — raised floor from ${current} → ${rounded}`;
          }
        }
      }
    }
  }

  // ── 3. minOrganic ─────────────────────────────────────────────
  // Raise organic floor if low-organic tokens consistently failed.
  {
    const loserOrganics  = losers.map((p) => p.organic_score).filter(isFiniteNum);
    const winnerOrganics = winners.map((p) => p.organic_score).filter(isFiniteNum);
    const current        = config.screening.minOrganic;

    if (loserOrganics.length >= MIN_RULE_RECORDS && winnerOrganics.length >= 1) {
      const avgLoserOrganic  = avg(loserOrganics);
      const avgWinnerOrganic = avg(winnerOrganics);
      // Only raise if there's a clear gap (winners consistently more organic)
      if (avgWinnerOrganic - avgLoserOrganic >= 10) {
        // Set floor just below worst winner
        const minWinnerOrganic = Math.min(...winnerOrganics);
        const target = Math.max(minWinnerOrganic - 3, current);
        // hard ceiling 75 — above that the floor rejects nearly every token
        const newVal = clamp(Math.round(nudge(current, target, MAX_CHANGE_PER_STEP)), 60, 75);
        if (newVal > current) {
          changes.minOrganic = newVal;
          rationale.minOrganic = `Winner avg organic ${avgWinnerOrganic.toFixed(0)} vs loser avg ${avgLoserOrganic.toFixed(0)} — raised from ${current} → ${newVal}`;
        }
      }
    }
  }

  // ── 4. Funnel tuning ──────────────────────────────────────────
  {
    const bandB = recent.filter((p) => p.screening_band === "B");
    const bandBLosses = bandB.filter((p) => (p.pnl_usd ?? 0) < 0);
    const bandBNet = bandB.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
    const currentMult = Number(config.management.bandBSizeMultiplier ?? 0.5);
    const currentNarrative = String(config.screening.xNarrativeMinConfidence || "moderate").toLowerCase();
    const bandBLossRate = bandB.length > 0 ? bandBLosses.length / bandB.length : 0;
    const narrativeSteps = ["weak", "moderate", "strong"];

    // FROZEN unless band deploys are live: the multiplier is only applied when
    // bandDeployEnabled=true (tools/dlmm.js) — evolving it while disabled just
    // grinds an inert knob down to its floor.
    if (config.management.bandDeployEnabled && bandB.length >= 15 && bandBNet < 0 && currentMult > 0.2) {
      const target = Math.max(0.2, currentMult * 0.8);
      const next = Number(clamp(nudge(currentMult, target, MAX_CHANGE_PER_STEP), 0.2, 1).toFixed(2));
      if (next < currentMult) {
        changes.bandBSizeMultiplier = next;
        rationale.bandBSizeMultiplier = `Band B net PnL ${bandBNet.toFixed(2)} across ${bandB.length} closes — reduced size multiplier from ${currentMult} → ${next}`;
      }
    }

    if (bandB.length >= 15 && bandBNet < 0 && bandBLossRate >= 0.6) {
      const idx = narrativeSteps.indexOf(currentNarrative);
      const nextNarrative = idx >= 0 && idx < narrativeSteps.length - 1 ? narrativeSteps[idx + 1] : currentNarrative;
      if (nextNarrative !== currentNarrative) {
        changes.xNarrativeMinConfidence = nextNarrative;
        rationale.xNarrativeMinConfidence = `Band B loss rate ${(bandBLossRate * 100).toFixed(0)}% — tightened X narrative floor from ${currentNarrative} → ${nextNarrative}`;
      }
    }
  }

  // ── 5. Symmetric decay ────────────────────────────────────────
  // Ratchets must not be one-way: with zero losers in the recent window, step
  // each evolved key back toward its config.js default so thresholds tightened
  // in a dead regime can relax again. Only unwinds evolution (current above
  // default) — operator-loosened values are left alone.
  if (decayEligible) {
    const s = config.screening;
    if (changes.minFeeActiveTvlRatio == null && s.minFeeActiveTvlRatio > EVOLVE_DEFAULTS.minFeeActiveTvlRatio) {
      let next = Number((s.minFeeActiveTvlRatio + (EVOLVE_DEFAULTS.minFeeActiveTvlRatio - s.minFeeActiveTvlRatio) * DECAY_STEP).toFixed(2));
      // 2-decimal key: a 10% step smaller than 0.005 rounds away — always make progress
      if (next >= s.minFeeActiveTvlRatio) next = Math.max(EVOLVE_DEFAULTS.minFeeActiveTvlRatio, Number((s.minFeeActiveTvlRatio - 0.01).toFixed(2)));
      changes.minFeeActiveTvlRatio = next;
      rationale.minFeeActiveTvlRatio = `No losers in ${windowDays}d window — decayed toward default ${EVOLVE_DEFAULTS.minFeeActiveTvlRatio}: ${s.minFeeActiveTvlRatio} → ${next}`;
    }
    if (changes.minOrganic == null && s.minOrganic > EVOLVE_DEFAULTS.minOrganic) {
      let next = Math.round(s.minOrganic + (EVOLVE_DEFAULTS.minOrganic - s.minOrganic) * DECAY_STEP);
      if (next >= s.minOrganic) next = s.minOrganic - 1; // integer key: always make progress
      changes.minOrganic = next;
      rationale.minOrganic = `No losers in ${windowDays}d window — decayed toward default ${EVOLVE_DEFAULTS.minOrganic}: ${s.minOrganic} → ${next}`;
    }
    const currentNarrative = String(s.xNarrativeMinConfidence || "moderate").toLowerCase();
    if (changes.xNarrativeMinConfidence == null && currentNarrative === "strong") {
      changes.xNarrativeMinConfidence = EVOLVE_DEFAULTS.xNarrativeMinConfidence;
      rationale.xNarrativeMinConfidence = `No losers in ${windowDays}d window — relaxed X narrative floor from ${currentNarrative} → ${EVOLVE_DEFAULTS.xNarrativeMinConfidence}`;
    }
  }

  if (Object.keys(changes).length === 0) return { changes: {}, rationale: {} };

  // ── Persist changes to user-config.json ───────────────────────
  let userConfig = {};
  if (fs.existsSync(USER_CONFIG_PATH)) {
    try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /* ignore */ }
  }

  Object.assign(userConfig, changes);
  userConfig._lastEvolved = new Date().toISOString();
  userConfig._positionsAtEvolution = perfData.length;

  fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

  // Apply to live config object immediately
  const s = config.screening;
  if (changes.minFeeActiveTvlRatio  != null) s.minFeeActiveTvlRatio  = changes.minFeeActiveTvlRatio;
  if (changes.minOrganic            != null) s.minOrganic            = changes.minOrganic;
  if (changes.xNarrativeMinConfidence != null) s.xNarrativeMinConfidence = changes.xNarrativeMinConfidence;
  if (changes.bandBSizeMultiplier != null) config.management.bandBSizeMultiplier = changes.bandBSizeMultiplier;

  // Log a lesson summarizing the evolution
  const data = load();
  data.lessons.push({
    id: Date.now(),
    rule: `[AUTO-EVOLVED @ ${perfData.length} positions] ${Object.entries(changes).map(([k, v]) => `${k}=${v}`).join(", ")} — ${Object.values(rationale).join("; ")}`,
    tags: ["evolution", "config_change"],
    outcome: "manual",
    created_at: new Date().toISOString(),
  });
  save(data);

  return { changes, rationale };
}

// ─── Helpers ───────────────────────────────────────────────────

function isFiniteNum(n) {
  return typeof n === "number" && isFinite(n);
}

function avg(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/** Move current toward target by at most maxChange fraction. */
function nudge(current, target, maxChange) {
  const delta = target - current;
  const maxDelta = current * maxChange;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

// ─── Manual Lessons ────────────────────────────────────────────

/**
 * Add a manual lesson (e.g. from operator observation).
 *
 * @param {string}   rule
 * @param {string[]} tags
 * @param {Object}   opts
 * @param {boolean}  opts.pinned - Always inject regardless of cap
 * @param {string}   opts.role   - "SCREENER" | "MANAGER" | "GENERAL" | null (all roles)
 */
export function addLesson(rule, tags = [], { pinned = false, role = null } = {}) {
  const safeRule = sanitizeLessonText(rule);
  if (!safeRule) return;
  const data = load();
  const lesson = {
    id: Date.now(),
    rule: safeRule,
    tags,
    outcome: "manual",
    sourceType: tags.includes("self_tune") || tags.includes("config_change") ? "config_change" : "manual",
    pinned: !!pinned,
    role: role || null,
    created_at: new Date().toISOString(),
  };
  data.lessons.push(lesson);
  save(data);
  log("lessons", `Manual lesson added${pinned ? " [PINNED]" : ""}${role ? ` [${role}]` : ""}: ${safeRule}`);
  void pushHiveLesson(lesson);
}

/**
 * Pin a lesson by ID — pinned lessons are always injected regardless of cap.
 */
export function pinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = true;
  save(data);
  log("lessons", `Pinned lesson ${id}: ${lesson.rule.slice(0, 60)}`);
  return { found: true, pinned: true, id, rule: lesson.rule };
}

/**
 * Unpin a lesson by ID.
 */
export function unpinLesson(id) {
  const data = load();
  const lesson = data.lessons.find((l) => l.id === id);
  if (!lesson) return { found: false };
  lesson.pinned = false;
  save(data);
  return { found: true, pinned: false, id, rule: lesson.rule };
}

/**
 * List lessons with optional filters — for agent browsing via Telegram.
 */
export function listLessons({ role = null, pinned = null, tag = null, limit = 30 } = {}) {
  const data = load();
  let lessons = [...data.lessons];

  if (pinned !== null) lessons = lessons.filter((l) => !!l.pinned === pinned);
  if (role)            lessons = lessons.filter((l) => !l.role || l.role === role);
  if (tag)             lessons = lessons.filter((l) => l.tags?.includes(tag));

  return {
    total: lessons.length,
    lessons: lessons.slice(-limit).map((l) => ({
      id: l.id,
      rule: l.rule.slice(0, 120),
      tags: l.tags,
      outcome: l.outcome,
      pinned: !!l.pinned,
      role: l.role || "all",
      created_at: l.created_at?.slice(0, 10),
    })),
  };
}

/**
 * Remove a lesson by ID.
 */
export function removeLesson(id) {
  const data = load();
  const before = data.lessons.length;
  data.lessons = data.lessons.filter((l) => l.id !== id);
  save(data);
  return before - data.lessons.length;
}

/**
 * Remove lessons matching a keyword in their rule text (case-insensitive).
 */
export function removeLessonsByKeyword(keyword) {
  const data = load();
  const before = data.lessons.length;
  const kw = keyword.toLowerCase();
  data.lessons = data.lessons.filter((l) => !l.rule.toLowerCase().includes(kw));
  save(data);
  return before - data.lessons.length;
}

/**
 * Clear ALL lessons (keeps performance data).
 */
export function clearAllLessons() {
  const data = load();
  const count = data.lessons.length;
  data.lessons = [];
  save(data);
  return count;
}

/**
 * Clear ALL performance records.
 */
export function clearPerformance() {
  const data = load();
  const count = data.performance.length;
  data.performance = [];
  save(data);
  return count;
}

// ─── Lesson Retrieval ──────────────────────────────────────────

// Tags that map to each agent role — used for role-aware lesson injection
const ROLE_TAGS = {
  SCREENER: ["screening", "narrative", "strategy", "deployment", "token", "volume", "entry", "bundler", "holders", "organic"],
  MANAGER:  ["management", "risk", "oor", "fees", "position", "hold", "close", "pnl", "rebalance", "claim"],
  GENERAL:  [], // all lessons
};

/**
 * Get lessons formatted for injection into the system prompt.
 * Structured injection with three tiers:
 *   1. Pinned        — always injected, up to PINNED_CAP
 *   2. Role-matched  — lessons tagged for this agentType, up to ROLE_CAP
 *   3. Recent        — fill remaining slots up to RECENT_CAP
 *
 * @param {Object} opts
 * @param {string} [opts.agentType]  - "SCREENER" | "MANAGER" | "GENERAL"
 * @param {number} [opts.maxLessons] - Override total cap (default 35)
 */
export function getLessonsForPrompt(opts = {}) {
  // Support legacy call signature: getLessonsForPrompt(20)
  if (typeof opts === "number") opts = { maxLessons: opts };

  const { agentType = "GENERAL", maxLessons } = opts;

  const data = load();
  if (data.lessons.length === 0) return null;

  // Smaller caps for automated cycles — they don't need the full lesson history
  const isAutoCycle = agentType === "SCREENER" || agentType === "MANAGER";
  const PINNED_CAP  = isAutoCycle ? 5  : 10;
  const ROLE_CAP    = isAutoCycle ? 6  : 15;
  const RECENT_CAP  = maxLessons ?? (isAutoCycle ? 10 : 35);

  const outcomePriority = { bad: 0, poor: 1, failed: 1, good: 2, worked: 2, manual: 1, neutral: 3, evolution: 2 };
  const byPriority = (a, b) => (outcomePriority[a.outcome] ?? 3) - (outcomePriority[b.outcome] ?? 3);

  // ── Tier 1: Pinned ──────────────────────────────────────────────
  // Respect role even for pinned lessons — a pinned SCREENER lesson shouldn't pollute MANAGER
  const pinned = data.lessons
    .filter((l) => l.pinned && (!l.role || l.role === agentType || agentType === "GENERAL"))
    .sort(byPriority)
    .slice(0, PINNED_CAP);

  const usedIds = new Set(pinned.map((l) => l.id));

  // ── Tier 2: Role-matched ────────────────────────────────────────
  const roleTags = ROLE_TAGS[agentType] || [];
  const roleMatched = data.lessons
    .filter((l) => {
      if (usedIds.has(l.id)) return false;
      // Include if: lesson has no role restriction OR matches this role
      const roleOk = !l.role || l.role === agentType || agentType === "GENERAL";
      // Include if: lesson has role-relevant tags OR no tags (general)
      const tagOk  = roleTags.length === 0 || !l.tags?.length || l.tags.some((t) => roleTags.includes(t));
      return roleOk && tagOk;
    })
    .sort(byPriority)
    .slice(0, ROLE_CAP);

  roleMatched.forEach((l) => usedIds.add(l.id));

  // ── Tier 3: Recent fill ─────────────────────────────────────────
  const remainingBudget = RECENT_CAP - pinned.length - roleMatched.length;
  const recent = remainingBudget > 0
    ? data.lessons
        .filter((l) => !usedIds.has(l.id))
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))
        .slice(0, remainingBudget)
    : [];

  const selected = [...pinned, ...roleMatched, ...recent];
  const shared = getSharedLessonsForPrompt({
    agentType,
    maxLessons: isAutoCycle ? 4 : 6,
  });
  if (selected.length === 0 && !shared) return null;

  const sections = [];
  if (pinned.length)      sections.push(`── PINNED (${pinned.length}) ──\n` + fmt(pinned));
  if (roleMatched.length) sections.push(`── ${agentType} (${roleMatched.length}) ──\n` + fmt(roleMatched));
  if (recent.length)      sections.push(`── RECENT (${recent.length}) ──\n` + fmt(recent));
  if (shared)             sections.push(`── HIVEMIND ──\n${shared}`);

  return sections.join("\n\n");
}

function fmt(lessons) {
  return lessons.map((l) => {
    const date = l.created_at ? l.created_at.slice(0, 16).replace("T", " ") : "unknown";
    const pin  = l.pinned ? "📌 " : "";
    return `${pin}[${l.outcome.toUpperCase()}] [${date}] ${l.rule}`;
  }).join("\n");
}

/**
 * Get individual performance records filtered by time window.
 * Tool handler: get_performance_history
 *
 * @param {Object} opts
 * @param {number} [opts.hours=24]   - How many hours back to look
 * @param {number} [opts.limit=50]   - Max records to return
 */
export function getPerformanceHistory({ hours = 24, limit = 50 } = {}) {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return { positions: [], count: 0, hours };

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const filtered = p
    .filter((r) => r.recorded_at >= cutoff)
    .slice(-limit)
    .map((r) => ({
      pool_name: r.pool_name,
      pool: r.pool,
      strategy: r.strategy,
      pnl_usd: r.pnl_usd,
      pnl_pct: r.pnl_pct,
      fees_earned_usd: r.fees_earned_usd,
      range_efficiency: r.range_efficiency,
      minutes_held: r.minutes_held,
      close_reason: r.close_reason,
      closed_at: r.recorded_at,
    }));

  const totalPnl = filtered.reduce((s, r) => s + (r.pnl_usd ?? 0), 0);
  const wins = filtered.filter((r) => r.pnl_usd > 0).length;

  return {
    hours,
    count: filtered.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    win_rate_pct: filtered.length > 0 ? Math.round((wins / filtered.length) * 100) : null,
    positions: filtered,
  };
}

/**
 * Return win rate of the last N closed positions, or null if insufficient data.
 * Used for adaptive position sizing.
 */
export function getRecentWinRate(lookback = 10) {
  const data = load();
  const recent = data.performance.slice(-lookback);
  if (recent.length < 3) return null;
  const wins = recent.filter((p) => p.pnl_pct > 0).length;
  return wins / recent.length;
}

/**
 * Get performance stats summary.
 */
export function getPerformanceSummary() {
  const data = load();
  const p = data.performance;

  if (p.length === 0) return null;

  const totalPnl = p.reduce((s, x) => s + x.pnl_usd, 0);
  const avgPnlPct = p.reduce((s, x) => s + x.pnl_pct, 0) / p.length;
  const avgRangeEfficiency = p.reduce((s, x) => s + x.range_efficiency, 0) / p.length;
  const wins = p.filter((x) => x.pnl_usd > 0).length;

  return {
    total_positions_closed: p.length,
    total_pnl_usd: Math.round(totalPnl * 100) / 100,
    avg_pnl_pct: Math.round(avgPnlPct * 100) / 100,
    avg_range_efficiency_pct: Math.round(avgRangeEfficiency * 10) / 10,
    win_rate_pct: Math.round((wins / p.length) * 100),
    total_lessons: data.lessons.length,
  };
}
