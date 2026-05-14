import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { computeBinsBelow, setRecommendedBins } from "./tools/bin-policy.js";
import { studyTopLPers } from "./tools/study.js";
import { getWalletBalances, sweepPendingTokens } from "./tools/wallet.js";
import { getTopCandidates } from "./tools/screening.js";
import { formatGmgnCandidateForPrompt } from "./tools/gmgn.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { recordSolPrice, getSolTrend, getSolTrendSummary } from "./tools/price-tracker.js";
import { evolveThresholds, getPerformanceSummary, getRecentWinRate } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  notifyXApiDegraded,
  isEnabled as telegramEnabled,
  createLiveMessage,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, markSpotAdded, hasSpotBeenAdded, clearSpotAdd } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote, getRecentSnapshots, getTokenLossCount } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { getXNarrativeSignal } from "./tools/x-narrative.js";
import { assignBand } from "./tools/scoring.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { runWeeklySourceCheck } from "./scripts/weekly-source-check.js";
import { computeFeeDecayClose, computeLowerDumpVelocityClose } from "./management-rules.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
ensureAgentId();
bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
startHiveMindBackgroundSync();

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastStartedAt = 0; // epoch ms — prevents management from spamming screening
let _screeningLastFinishedAt = 0; // epoch ms — tracks the last completed screening cycle
let _pollTriggeredAt = 0; // epoch ms — cooldown for poller-triggered management
let _lastMgmtCycleId = ''; // current cycle ID being processed
let _lastMgmtCompleted = 0; // epoch ms — last completed cycle for dedupe
let _lastXApiAlertAt = 0; // epoch ms — debounce X API degradation alerts
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 5_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;
const TRAILING_HARD_EXIT_NEGATIVE_PNL_PCT = -2.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function shouldUsePnlRecheck() {
  return !config.api.lpAgentRelayEnabled;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress, trailingDropPct = config.management.trailingDropPct, currentPnlPct = null, confirmationDelayMs = null) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const hardExit = Number.isFinite(currentPnlPct) && Number.isFinite(trailingDropPct) && currentPnlPct <= TRAILING_HARD_EXIT_NEGATIVE_PNL_PCT;
  const requestedDelay = Number.isFinite(confirmationDelayMs) ? confirmationDelayMs : TRAILING_DROP_CONFIRM_DELAY_MS;
  const delayMs = hardExit ? 0 : requestedDelay;

  const runCheck = async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — ${_managementBusy ? "already running" : "triggering management"}`);
        if (!_managementBusy) runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  };

  if (delayMs <= 0) {
    const pending = Promise.resolve().then(runCheck);
    _trailingDropConfirmTimers.set(positionAddress, pending);
    return;
  }

  const timer = setTimeout(() => {
    runCheck().catch(() => null);
  }, delayMs);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

let _briefingBusy = false;
async function runBriefing() {
  if (_briefingBusy) { log("cron", "Briefing already in progress — skipping"); return; }
  _briefingBusy = true;
  log("cron", "Starting morning briefing");
  try {
    setLastBriefingDate(); // set BEFORE async send to prevent watchdog race
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  } finally {
    _briefingBusy = false;
  }
}

/**
 * If the agent restarted after the 08:00 UTC+8 (Asia/Singapore) cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  const localNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Singapore" }));
  const localHour = localNow.getHours();
  const localMinute = localNow.getMinutes();
  const minutesSinceEight = (localHour * 60 + localMinute) - (8 * 60);

  if (!Number.isFinite(minutesSinceEight) || minutesSinceEight < 0) return; // too early
  if (minutesSinceEight > 30) {
    log("cron", `Missed briefing skipped for today (outside catch-up window, local UTC+8 ${String(localHour).padStart(2, "0")}:${String(localMinute).padStart(2, "0")})`);
    return;
  }

  log("cron", `Missed briefing detected within catch-up window (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) {
    if (typeof task.stop === 'function') task.stop();
    else clearInterval(task);
  }
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  _cronTasks = [];
}

export async function runManagementCycle({ silent = false } = {}) {
  // Dedupe: if cycle running recently or completed recently, skip
  const thisCycleId = `mgmt-${Date.now()}`;
  const now = Date.now();
  if (_lastMgmtCycleId && (now - parseInt(_lastMgmtCycleId.split('-')[1])) < 30000) {
    log("cron", `[Dedupe] Skipping — cycle already running (ID: ${_lastMgmtCycleId})`);
    return null;
  }
  if (_lastMgmtCompleted && (now - _lastMgmtCompleted) < 60000) {
    log("cron", `[Dedupe] Skipping — recent completed at ${_lastMgmtCompleted}`);
    return null;
  }
  _lastMgmtCycleId = thisCycleId;
  
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", `Starting management cycle [${thisCycleId}]`);
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = Math.max(5, Number(config.schedule.screeningIntervalMin ?? 60)) * 60 * 1000;

  // Attempt to sweep any tokens that failed auto-swap on previous closes.
  sweepPendingTokens().catch((e) => log("sweep_error", e.message));

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      const sinceLastScreenMs = Date.now() - Math.max(_screeningLastStartedAt, _screeningLastFinishedAt);
      if (_screeningBusy || sinceLastScreenMs < screeningCooldownMs) {
        const waitMin = Math.max(1, Math.ceil((screeningCooldownMs - sinceLastScreenMs) / 60000));
        log("cron", `No open positions — skipping extra screening (busy/cooldown, next eligible in ~${waitMin}m)`);
        mgmtReport = `No open positions. Screening already running or recently completed, next eligible in ~${waitMin}m.`;
      } else {
        log("cron", "No open positions — triggering screening cycle");
        mgmtReport = "No open positions. Triggering screening cycle.";
        runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      }
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool), snapshots: getRecentSnapshots(p.pool, 6) };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (
        !p.pnl_pct_suspicious &&
        queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
        shouldUsePnlRecheck()
      ) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, exit.trailing_drop_pct ?? config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position, exit.trailing_drop_pct ?? config.management.trailingDropPct, exit.current_pnl_pct, exit.confirmation_delay_ms);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Spot-add evaluation ──────────────────────────────────────────
    // For each bid_ask position that meets the trigger, add a spot position (once per pool).
    if (config.management.spotAddEnabled) {
      for (const p of positionData) {
        const tracked = getTrackedPosition(p.position);
        if (!tracked || tracked.strategy !== "bid_ask") continue;
        if (hasSpotBeenAdded(p.pool)) continue;
        if (actionMap.get(p.position)?.action === "CLOSE") continue; // don't add to dying position

        const ageMin = p.age_minutes ?? 0;
        if (ageMin < config.management.spotAddMinAgeMinutes) continue;

        const deployFee = tracked.fee_tvl_ratio ?? tracked.initial_fee_tvl_24h ?? null;
        const currentFee = p.fee_per_tvl_24h ?? null;
        const feeSpiked = deployFee != null && currentFee != null &&
          currentFee >= deployFee * config.management.spotAddFeeSpikeMultiplier;

        const smartWalletsPresent = await checkSmartWalletsOnPool({ pool_address: p.pool })
          .then(r => (r?.in_pool?.length ?? 0) > 0).catch(() => false);

        if (!feeSpiked && !smartWalletsPresent) continue;

        const spotAmount = parseFloat(((tracked.amount_sol ?? config.management.deployAmountSol) * config.management.spotAddSizePct).toFixed(3));
        const wallet = await getWalletBalances().catch(() => null);
        if (!wallet || wallet.sol < spotAmount + config.management.gasReserve) {
          log("cron", `Spot-add skipped for ${p.pair} — insufficient SOL (${wallet?.sol ?? 0} < ${spotAmount + config.management.gasReserve})`);
          continue;
        }

        const triggerReason = feeSpiked
          ? `fee/TVL ${currentFee}% ≥ ${deployFee}% × ${config.management.spotAddFeeSpikeMultiplier} (deploy-time)`
          : "smart wallets present";
        log("cron", `Spot-add triggered for ${p.pair} — ${triggerReason}`);

        try {
          const result = await executeTool("deploy_position", {
            pool_address: p.pool,
            lp_strategy: "spot",
            amount_y: spotAmount,
            amount_x: 0,
            bins_below: tracked.bin_range?.bins_below ?? 50,
            bins_above: 0,
            allow_spot_add: true,
          });
          if (result?.position) {
            markSpotAdded(p.pool);
            const posMsg = `➕ SPOT-ADD\n\n${p.pair} • ${spotAmount} SOL added\nPool: ${p.pool.slice(0, 8)}...${p.pool.slice(-4)}\n\n📍 ${triggerReason}`;
            log("cron", `Spot-add SUCCESS for ${p.pair} — ${spotAmount} SOL spot position opened (${result.position.slice(0, 8)})`);
            sendMessage(posMsg).catch(() => {});
          } else {
            log("cron", `Spot-add FAILED for ${p.pair}: ${result?.error || "no position returned"}`);
          }
        } catch (e) {
          log("cron_error", `Spot-add error for ${p.pair}: ${e.message}`);
        }
      }
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    // ── ASCII Bin Map renderer ──────────────────────────────────────
function formatBinMap(lowerBin, upperBin, activeBin) {
  if (lowerBin == null || upperBin == null || activeBin == null) return null;
  const MAP_WIDTH = 27; // chars wide for the bar
  const range = upperBin - lowerBin + 1;
  // Show 15-35 bins wide, centred on the position
  const window = Math.min(Math.max(range, 15), 35);
  const midBin = Math.floor((lowerBin + upperBin) / 2);
  const half = Math.floor(window / 2);
  const windowStart = midBin - half;
  const windowEnd = midBin + half;

  // Build bar: ░ outside position, ▓ = in position
  let bar = "";
  for (let i = 0; i < window; i++) {
    const binId = windowStart + i;
    bar += (binId >= lowerBin && binId <= upperBin) ? "▓" : "░";
  }

  // Active bin marker — only show if within window
  let marker = "";
  if (activeBin >= windowStart && activeBin <= windowEnd) {
    const idx = Math.round((activeBin - windowStart) / (windowEnd - windowStart) * (window - 1));
    marker = " ".repeat(idx) + "◆";
  }

  const pctInRange = activeBin >= lowerBin && activeBin <= upperBin;
  const inRangeTag = pctInRange ? "🟢" : "🔴";
  return `${inRangeTag} bin[${lowerBin}‒${upperBin}] active=${activeBin}\n\`\`\`${bar}\`\`\`${marker ? "\n" + marker : ""}`;
}

// ── Build per-position report lines ────────────────────────────
// New format (user's preferred style):
// 🔄 Management Cycle
// 📊 Spirit-SOL | bid_ask
//    💰 ◎0.250 | PnL: 🟢 +0.3% (+◎0.000) | Range: 🟢 [████████████████] 99% (bin -602/-670–-601) | 📥 ◎0.000 | 📈 3.46%/24h
//    🟢 IN | ⏱️ 28m 
// 📊 Staccana-SOL | bid_ask
//    💰 ◎0.249 | PnL: 🟢 +5.5% (+◎0.012) | Range: 🟢 [████████████░░░░] 74% (bin -583/-609–-574) | 📥 ◎0.013 | 📈 708.84%/24h
//    🟢 IN | ⏱️ 10m 
// 📦 2 positions | 💵 ◎0.499 | 📥 fees: ◎0.013
// 📊 Avg PnL: +2.89% | 🔔 Action: none | ✅ Stay: 2

function computeRangePct(lowerBin, upperBin, activeBin) {
  if (lowerBin == null || upperBin == null || activeBin == null) return 0;
  const total = upperBin - lowerBin + 1;
  if (total <= 0) return 0;
  if (activeBin < lowerBin) return 0;
  if (activeBin > upperBin) return 100;
  return Math.round(((activeBin - lowerBin + 1) / total) * 100);
}

function formatBinBar(lowerBin, upperBin, activeBin) {
  if (lowerBin == null || upperBin == null || activeBin == null) return "░░░░░░░░░░░░░░░░░";
  const range = upperBin - lowerBin + 1;
  if (range <= 0) return "░░░░░░░░░░░░░░░░░░";
  const BARSIZE = 16;
  
  // Position of active bin within the range (0 to range-1)
  let posInRange = 0;
  if (activeBin < lowerBin) posInRange = 0;
  else if (activeBin > upperBin) posInRange = range - 1;
  else posInRange = activeBin - lowerBin;
  
  // How many bars to fill based on position
  let filled = Math.round((posInRange / range) * BARSIZE);
  if (filled < 0) filled = 0;
  if (filled > BARSIZE) filled = BARSIZE;
  
  return "▓".repeat(filled) + "░".repeat(BARSIZE - filled);
}

const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range;
      const inRangeTag = inRange ? "🟢" : "🔴";
      const statusLine = inRange ? `🟢 IN` : `🔴 OOR`;
      
      // Compute range %
      const rangePct = computeRangePct(p.lower_bin, p.upper_bin, p.active_bin);
      const binBar = formatBinBar(p.lower_bin, p.upper_bin, p.active_bin);
      
      // PnL formatting
      const pnlVal = p.pnl_pct ?? 0;
      const pnlTag = pnlVal >= 0 ? "🟢" : "🔴";
      const pnlStr = `${pnlTag} ${pnlVal >= 0 ? "+" : ""}${pnlVal.toFixed(2)}%`;
      
      // Value and fees
      const val = config.management.solMode ? `◎${(p.total_value_usd ?? 0).toFixed(3)}` : `$${(p.total_value_usd ?? 0).toFixed(2)}`;
      const fees = config.management.solMode ? `◎${(p.unclaimed_fees_usd ?? 0).toFixed(3)}` : `$${(p.unclaimed_fees_usd ?? 0).toFixed(4)}`;
      
      // Yield/24h
      const yield24h = p.fee_per_tvl_24h ?? 0;
      
      // Strategy from position or default
      const strategy = p.strategy || "bid_ask";
      
      // Age in minutes
      const age = p.age_minutes ?? 0;
      
      // Build the position card
      const line = `📊 ${p.pair} | ${strategy}\n` +
        `   💰 ${val} | PnL: ${pnlStr} (+${fees}) | Range: ${inRangeTag} [${binBar}] ${rangePct}% (bin ${p.lower_bin}/${p.active_bin}–${p.upper_bin}) | 📥 ${fees} | 📈 ${yield24h.toFixed(2)}%/24h\n` +
        `   ${statusLine} | ⏱️ ${age}m`;
      
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    // Compute avg PnL
    const avgPnl = positions.length > 0
      ? positionData.reduce((s, p) => s + (p.pnl_pct ?? 0), 0) / positions.length
      : 0;
    const avgPnlTag = avgPnl >= 0 ? "🟢" : "🔴";
    const totalVal = config.management.solMode ? `◎${totalValue.toFixed(3)}` : `$${totalValue.toFixed(2)}`;
    const totalFees = config.management.solMode ? `◎${totalUnclaimed.toFixed(3)}` : `$${totalUnclaimed.toFixed(4)}`;
    const stayCount = [...actionMap.values()].filter(a => a.action === "STAY").length;
    const actionLabel = actionSummary === "no action" ? "none" : actionSummary;
    
    // Build final report - header added separately by liveMessage when present
    mgmtReport = reportLines.join("\n\n") +
      `\n\n📦 ${positions.length} positions | 💵 ${totalVal} | 📥 fees: ${totalFees}\n` +
      `📊 Avg PnL: ${avgPnlTag} ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}% | 🔔 Action: ${actionLabel} | ✅ Stay: ${stayCount}`;

    const deterministicActions = [];
    const instructionPositions = [];

    for (const p of positionData) {
      const act = actionMap.get(p.position);
      if (!act || act.action === "STAY") continue;
      if (act.action === "INSTRUCTION") {
        instructionPositions.push({ p, act });
      } else {
        deterministicActions.push({ p, act });
      }
    }

    if (deterministicActions.length > 0) {
      log("cron", `Management: executing ${deterministicActions.length} deterministic action(s) directly`);
      const deterministicResults = [];
      for (const { p, act } of deterministicActions) {
        try {
          let result;
          if (act.action === "CLOSE") {
            await liveMessage?.toolStart("close_position");
            result = await executeTool("close_position", {
              position_address: p.position,
              reason: act.reason || `Rule ${act.rule || "close"}`,
            });
            await liveMessage?.toolFinish("close_position", result, !result?.error && result?.success !== false);
            deterministicResults.push(`- ${p.pair}: CLOSE ${result?.success === false || result?.error ? `failed (${result.error || "unknown error"})` : `executed${act.reason ? `, ${act.reason}` : ""}`}`);
          } else if (act.action === "CLAIM") {
            await liveMessage?.toolStart("claim_fees");
            result = await executeTool("claim_fees", { position_address: p.position });
            await liveMessage?.toolFinish("claim_fees", result, !result?.error && result?.success !== false);
            deterministicResults.push(`- ${p.pair}: CLAIM ${result?.success === false || result?.error ? `failed (${result.error || "unknown error"})` : "executed"}`);
          }
        } catch (error) {
          deterministicResults.push(`- ${p.pair}: ${act.action} failed (${error.message})`);
          log("cron_error", `Deterministic ${act.action} failed for ${p.pair}: ${error.message}`);
        }
      }
      if (deterministicResults.length > 0) {
        mgmtReport += `\n\nDeterministic actions:\n${deterministicResults.join("\n")}`;
      }
    }

    if (instructionPositions.length > 0) {
      log("cron", `Management: ${instructionPositions.length} instruction-bound position(s) need LLM review [model: ${config.llm.managementModel}]`);

      const actionBlocks = instructionPositions.map(({ p }) => [
        `POSITION: ${p.pair} (${p.position})`,
        `  pool: ${p.pool}`,
        `  action: INSTRUCTION`,
        `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
        `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
        p.instruction ? `  instruction: "${p.instruction}"` : null,
      ].filter(Boolean).join("\n")).join("\n\n");

      const { content } = await agentLoop(`
MANAGEMENT ACTION REQUIRED — ${instructionPositions.length} instruction-bound position(s)

${actionBlocks}

RULES:
- Evaluate the saved instruction only.
- If the instruction condition is met, call close_position.
- If the instruction condition is not met, HOLD and do nothing.
- Do not claim fees unless the instruction explicitly requires it.

After executing, write a brief one-line result per position.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });

      mgmtReport += `\n\n${content}`;
    } else {
      log("cron", "Management: no instruction-bound actions need LLM review");
      if (deterministicActions.length === 0) {
        await liveMessage?.note("No tool actions needed.");
      }
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    const sinceLastScreenMs = Date.now() - Math.max(_screeningLastStartedAt, _screeningLastFinishedAt);
    if (afterCount < config.risk.maxPositions && !_screeningBusy && sinceLastScreenMs > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    } else if (afterCount < config.risk.maxPositions) {
      log("cron", `Post-management: screening not triggered (busy/cooldown, last screen ${Math.round(sinceLastScreenMs / 1000)}s ago)`);
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    // Clear dedupe tracking
    if (_lastMgmtCycleId === thisCycleId) {
      _lastMgmtCycleId = '';
      _lastMgmtCompleted = Date.now();
    }
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastStartedAt = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.error && preBalance.source === "error") {
      log("cron", `Screening skipped — could not verify SOL balance (${preBalance.error})`);
      screenReport = `Screening skipped — could not verify SOL balance (${preBalance.error}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Could not verify SOL balance (${preBalance.error})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    if (!isDryRun && preBalance.sol < minRequired) {
      const sourceNote = preBalance.source === "rpc_fallback" ? " via RPC fallback" : "";
      log("cron", `Screening skipped — insufficient SOL${sourceNote} (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL${sourceNote} (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL${sourceNote} (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    // Record SOL price for trend tracking
    if (currentBalance.sol_price > 0) recordSolPrice(currentBalance.sol_price);
    // Get SOL 7d trend for adaptive sizing
    const solTrend = getSolTrend(168);
    const solTrendPct = solTrend?.changePct ?? null;
    if (solTrend) log("cron", getSolTrendSummary());
    const baseDeployAmount = computeDeployAmount(currentBalance.sol, solTrendPct);
    // Adaptive sizing: reduce by 30% if recent win rate is poor (< 30% over last 10 positions)
    const recentWinRate = getRecentWinRate(10);
    const drawdownMultiplier = (recentWinRate != null && recentWinRate < 0.30) ? 0.70 : 1.0;
    const deployAmount = Math.max(
      parseFloat((baseDeployAmount * drawdownMultiplier).toFixed(2)),
      config.management.deployAmountSolMin ?? 0.35
    );
    if (drawdownMultiplier < 1.0) {
      log("cron", `Adaptive sizing: reduced deploy ${baseDeployAmount} → ${deployAmount} SOL (win rate ${(recentWinRate * 100).toFixed(0)}% < 30%, floor: ${config.management.deployAmountSolMin ?? 0.35})`);
    }
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL | SOL 7d: ${solTrendPct != null ? solTrendPct.toFixed(1) + "%" : "n/a"})`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const strategyBlock = activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `No active strategy — use strategy=${config.strategy.strategy}, bins_above=0, SOL only.`;

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch((e) => ({ _error: e.message }));
    if (topCandidates?._error) {
      screenReport = `Screening failed: ${topCandidates._error}`;
      return screenReport;
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];
    const gmgnStageCounts = topCandidates?.stage_counts ?? null;
    const gmgnAllFiltered = topCandidates?.all_filtered ?? [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const symbol = pool.base?.symbol || pool.name?.split("-")?.[0] || null;
      const [smartWallets, narrative, tokenInfo, xNarrative] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
        // Cost guard: do not call paid X API during broad recon. We check only the top
        // post-filter candidate below, and x-narrative.js persists a 7-day cache.
        Promise.resolve({ narrative_confidence: "unknown", reason: "not checked: top-1 X budget guard" }),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        x: xNarrative.status === "fulfilled" ? xNarrative.value : { narrative_confidence: "unknown" },
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    let xApiHealth = { total: 0, unknown: 0, unknownRate: 0, degraded: false, topReasons: [], examples: [] };

    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, sw, ti }) => {
      const fragility = computeCandidateFragility(pool, ti);
      pool.entry_fragility_score = fragility.score;
      pool.entry_fragility_level = fragility.level;
      pool.entry_fragility_reasons = fragility.reasons;
      let recommendedBinsBelow = computeBinsBelow(pool.volatility, fragility);
      const supportCoverage = estimateBinsToSupport(pool);
      if (supportCoverage) {
        const supportBufferBins = Number(config.strategy.supportBufferBins ?? 3);
        const neededBins = supportCoverage.bins + supportBufferBins;
        const maxSupportBins = Number(config.strategy.maxBinsBelow ?? 69);
        pool.support_bins_below = supportCoverage.bins;
        pool.support_price = supportCoverage.supportPrice;
        pool.support_source = supportCoverage.source;
        if (neededBins > maxSupportBins) {
          log("screening", `Support gate: dropped ${pool.name} — ${supportCoverage.source} support needs ${neededBins} bins below active, max ${maxSupportBins}; entry too early / support too far`);
          filteredOut.push({ name: pool.name, reason: `${supportCoverage.source} support needs ${neededBins} bins > max ${maxSupportBins}` });
          return false;
        }
        if (neededBins > recommendedBinsBelow) {
          log("screening", `Support range widened ${pool.name}: bins_below ${recommendedBinsBelow} → ${neededBins} to cover ${supportCoverage.source} support (${supportCoverage.interval || "?"})`);
          recommendedBinsBelow = neededBins;
        }
      }
      pool.recommended_bins_below = recommendedBinsBelow;
      setRecommendedBins(pool.pool, { bins: recommendedBinsBelow, fragility, volatility: pool.volatility, support: supportCoverage });

      const vol = pool.volatility;
      const maxVolHard = Number(config.screening.maxVolatilityHard ?? 3.5);
      if (vol == null && config.screening.rejectNullVolatility) {
        log("screening", `Vol gate: dropped ${pool.name} — volatility=null (no poolDetail.volatility)`);
        filteredOut.push({ name: pool.name, reason: "volatility=null" });
        return false;
      }
      if (vol != null && vol > maxVolHard) {
        log("screening", `Vol gate: dropped ${pool.name} — volatility ${vol} > max ${maxVolHard} (too volatile for LP)`);
        filteredOut.push({ name: pool.name, reason: `volatility ${vol} > ${maxVolHard} (too volatile)` });
        return false;
      }

      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      const top10Pct = parseFloat(ti?.audit?.top_holders_pct ?? "0") || 0;
      const maxTop10Pct = config.screening.maxTop10Pct;
      if (top10Pct > 0 && maxTop10Pct != null && top10Pct > maxTop10Pct) {
        log("screening", `Top-10 filter: dropped ${pool.name} — top10 ${top10Pct}% > ${maxTop10Pct}%`);
        filteredOut.push({ name: pool.name, reason: `top 10 holders ${top10Pct}% > ${maxTop10Pct}%` });
        return false;
      }
      const feePct = Number(pool.fee_pct ?? 0);
      const feeTvl = Number(pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? 0);

      // ── Standalone hard gate: minimum token age ──
      const ageHours = Number(pool.token_age_hours);
      const minAge = Number(config.screening.minTokenAgeHours ?? 0);
      if (Number.isFinite(ageHours) && Number.isFinite(minAge) && minAge > 0 && ageHours < minAge) {
        log("screening", `Age gate: dropped ${pool.name} — age ${ageHours}h < min ${minAge}h`);
        filteredOut.push({ name: pool.name, reason: `age ${ageHours}h < minimum ${minAge}h` });
        return false;
      }

      // ── Standalone hard gate: minimum fee/TVL ratio ──
      const minFeeTvl = Number(config.screening.minFeeActiveTvlRatio ?? 0);
      if (Number.isFinite(feeTvl) && Number.isFinite(minFeeTvl) && minFeeTvl > 0 && feeTvl < minFeeTvl) {
        log("screening", `Fee/TVL gate: dropped ${pool.name} — fee/TVL ${feeTvl}% < min ${minFeeTvl}%`);
        filteredOut.push({ name: pool.name, reason: `fee/TVL ${feeTvl}% < minimum ${minFeeTvl}%` });
        return false;
      }

      // ── Standalone hard gate: minimum organic score ──
      const organicScore = Number(pool.organic_score ?? pool.base?.organic);
      const minOrganic = Number(config.screening.minOrganic ?? 0);
      if (Number.isFinite(organicScore) && Number.isFinite(minOrganic) && minOrganic > 0 && organicScore < minOrganic) {
        log("screening", `Organic gate: dropped ${pool.name} — organic ${organicScore} < min ${minOrganic}`);
        filteredOut.push({ name: pool.name, reason: `organic ${organicScore} < minimum ${minOrganic}` });
        return false;
      }

      // ── Standalone hard gate: minimum volume/TVL turnover ──
      const volumeWindow = Number(pool.volume_window ?? pool.volume ?? 0);
      const activeTvl = Number(pool.active_tvl ?? 0);
      const minTurnover = Number(config.screening.minTurnoverPct ?? 0);
      if (activeTvl > 0 && Number.isFinite(minTurnover) && minTurnover > 0) {
        const turnoverPct = (volumeWindow / activeTvl) * 100;
        if (turnoverPct < minTurnover) {
          log("screening", `Turnover gate: dropped ${pool.name} — turnover ${turnoverPct.toFixed(1)}% < min ${minTurnover}% (vol=$${volumeWindow}, tvl=$${activeTvl})`);
          filteredOut.push({ name: pool.name, reason: `turnover ${turnoverPct.toFixed(1)}% < minimum ${minTurnover}%` });
          return false;
        }
      }

      // ── Standalone hard gate: maximum TVL ──
      const maxTvl = Number(config.screening.maxTvl);
      if (activeTvl > 0 && Number.isFinite(maxTvl) && maxTvl > 0 && activeTvl > maxTvl) {
        log("screening", `TVL cap: dropped ${pool.name} — TVL $${activeTvl} > max $${maxTvl}`);
        filteredOut.push({ name: pool.name, reason: `TVL $${activeTvl} > max $${maxTvl}` });
        return false;
      }

      // ── Standalone hard gate: price momentum (entry timing) ──
      const velocity5m = Number(pool.gmgn_price_action?.priceChangePct ?? pool.price_change_pct);
      const maxPumpPct = Number(config.screening.maxPumpPct5m ?? 15);
      const maxDumpPct = Number(config.screening.maxDumpPct5m ?? 20);
      if (Number.isFinite(velocity5m)) {
        if (velocity5m > maxPumpPct) {
          log("screening", `Momentum gate: dropped ${pool.name} — 5m pump +${velocity5m.toFixed(1)}% > max +${maxPumpPct}% (too hot, wait for pullback)`);
          filteredOut.push({ name: pool.name, reason: `5m pump +${velocity5m.toFixed(1)}% > max +${maxPumpPct}%` });
          return false;
        }
        if (velocity5m < -maxDumpPct) {
          log("screening", `Momentum gate: dropped ${pool.name} — 5m dump ${velocity5m.toFixed(1)}% < -${maxDumpPct}% (falling knife)`);
          filteredOut.push({ name: pool.name, reason: `5m dump ${velocity5m.toFixed(1)}% < -${maxDumpPct}%` });
          return false;
        }
      }

      const dynamicFeePct = Math.max(0, feePct - Number(pool.base_fee ?? feePct));
      const deadFeeEngine = feeTvl <= 0.02 && dynamicFeePct <= 0.02;
      if (fragility.score >= 30 && deadFeeEngine && feePct <= 0.4) {
        log("screening", `Fragility veto: dropped ${pool.name} — fast/ultrafragile (${fragility.score}) with dead fee engine (fee=${feePct}%, dynamic=${dynamicFeePct}%, fee/TVL=${feeTvl}%)`);
        filteredOut.push({ name: pool.name, reason: `fragility ${fragility.score} with dead fee engine (fee ${feePct}%, dynamic ${dynamicFeePct}%, fee/TVL ${feeTvl}%)` });
        return false;
      }
      if (fragility.score >= 40 && feeTvl < Math.max(0.15, Number(config.screening.minFeeActiveTvlRatio ?? 0)) && feePct <= 0.4 && dynamicFeePct <= 0.05) {
        log("screening", `Fragility veto: dropped ${pool.name} — ultrafragile (${fragility.score}) with weak fee economics (fee=${feePct}%, dynamic=${dynamicFeePct}%, fee/TVL=${feeTvl}%)`);
        filteredOut.push({ name: pool.name, reason: `ultrafragile ${fragility.score} with weak fee economics (fee ${feePct}%, dynamic ${dynamicFeePct}%, fee/TVL ${feeTvl}%)` });
        return false;
      }
      if (fragility.score >= 20 && feeTvl < Math.max(0.1, Number(config.screening.minFeeActiveTvlRatio ?? 0) * 0.75) && feePct <= 0.3 && dynamicFeePct <= 0.02) {
        log("screening", `Fragility penalty veto: dropped ${pool.name} — fragile (${fragility.score}) and fee profile too sleepy (fee=${feePct}%, dynamic=${dynamicFeePct}%, fee/TVL=${feeTvl}%)`);
        filteredOut.push({ name: pool.name, reason: `fragile ${fragility.score} and fee profile too sleepy (fee ${feePct}%, dynamic ${dynamicFeePct}%, fee/TVL ${feeTvl}%)` });
        return false;
      }

      const tc = activeStrategy?.token_criteria;
      if (tc) {
        if (tc.min_mcap != null && pool.mcap != null && pool.mcap < tc.min_mcap) {
          log("screening", `Strategy filter: dropped ${pool.name} — mcap $${pool.mcap} < strategy min $${tc.min_mcap}`);
          filteredOut.push({ name: pool.name, reason: `mcap $${pool.mcap} < strategy min_mcap $${tc.min_mcap}` });
          return false;
        }
        if (tc.min_age_days != null && pool.token_age_hours != null) {
          const ageDays = pool.token_age_hours / 24;
          if (ageDays < tc.min_age_days) {
            log("screening", `Strategy filter: dropped ${pool.name} — age ${ageDays.toFixed(1)}d < strategy min ${tc.min_age_days}d`);
            filteredOut.push({ name: pool.name, reason: `age ${ageDays.toFixed(1)}d < strategy min_age_days ${tc.min_age_days}d` });
            return false;
          }
        }
        if (tc.requires_kol === true) {
          const hasKol = pool.kol_in_clusters || (sw?.in_pool?.length > 0);
          if (!hasKol) {
            log("screening", `Strategy filter: dropped ${pool.name} — requires KOL presence, none found`);
            filteredOut.push({ name: pool.name, reason: "strategy requires_kol: no KOL presence" });
            return false;
          }
        }
      }
      return true;
    });

    const vetoExamples = filteredOut
      .filter((entry) => /fragility veto|ultrafragile|fragile .*sleepy/i.test(entry.reason))
      .slice(0, 3)
      .map((entry) => `- ${entry.name}: ${entry.reason}`)
      .join("\n");

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      const postFunnelExamples = filteredOut.slice(0, 5)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      const postFunnelBlock = postFunnelExamples ? `Post-funnel local filters:\n${postFunnelExamples}` : "";
      const thresholds = `Thresholds: tvl>$${config.screening.minTvl} | vol>$${config.screening.minVolume} | organic>${config.screening.minOrganic}% | holders>${config.screening.minHolders} | fee/tvl>${config.screening.minFeeActiveTvlRatio}%`;
      const xHealthBlock = formatXNarrativeHealthBlock(xApiHealth);
      screenReport = funnelBlock
        ? `No candidates available.\n\n${funnelBlock}${postFunnelBlock ? `\n\n${postFunnelBlock}` : ""}${xHealthBlock ? `\n\n${xHealthBlock}` : ""}${vetoExamples ? `\n\nFragility vetoes:\n${vetoExamples}` : ""}`
        : combinedExamples
          ? `No candidates available.\nFiltered examples:\n${combinedExamples}${xHealthBlock ? `\n\n${xHealthBlock}` : ""}${vetoExamples ? `\n\nFragility vetoes:\n${vetoExamples}` : ""}`
          : `No candidates available (all filtered).\n${thresholds}${xHealthBlock ? `\n\n${xHealthBlock}` : ""}${vetoExamples ? `\n\nFragility vetoes:\n${vetoExamples}` : ""}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: funnelBlock || combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    if (passing.length <= 1 && gmgnStageCounts) {
      const funnelBlock = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
      if (funnelBlock) log("screening", `GMGN funnel (sparse):\n${funnelBlock}`);
    }

    // Paid X API budget guard: only check the top post-filter candidate.
    // x-narrative.js persists cache; set xApiCacheMinutes=10080 for 7-day reuse.
    const xCheckedEntries = [];
    const topXEntry = passing[0];
    if (topXEntry) {
      const mint = topXEntry.pool.base?.mint;
      const symbol = topXEntry.pool.base?.symbol || topXEntry.pool.name?.split("-")?.[0] || null;
      if (mint || symbol) {
        try {
          topXEntry.x = await getXNarrativeSignal({ symbol, contract: mint });
          xCheckedEntries.push(topXEntry);
          log("screening", `X narrative checked top candidate only: ${topXEntry.pool.name} → ${topXEntry.x?.narrative_confidence || "unknown"}${topXEntry.x?.cached ? " (cache)" : ""}`);
        } catch (error) {
          topXEntry.x = { narrative_confidence: "unknown", reason: error.message || "X check failed" };
          xCheckedEntries.push(topXEntry);
        }
      }
    }
    xApiHealth = summarizeXNarrativeHealth(xCheckedEntries);
    if (xApiHealth.degraded) {
      log("screening_warn", formatXNarrativeHealthLog(xApiHealth));
      const severeDegradation = xApiHealth.unknown === xApiHealth.total || xApiHealth.unknownRate >= 0.5;
      const alertCooldownMs = 60 * 60 * 1000;
      if (!silent && telegramEnabled() && severeDegradation && (Date.now() - _lastXApiAlertAt > alertCooldownMs)) {
        _lastXApiAlertAt = Date.now();
        notifyXApiDegraded({
          total: xApiHealth.total,
          unknown: xApiHealth.unknown,
          reasons: xApiHealth.topReasons,
          examples: xApiHealth.examples,
        }).catch(() => {});
      }
    }

    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    const lpStudyTargets = passing.slice(0, Math.min(3, passing.length));
    const lpStudyResults = await Promise.allSettled(
      lpStudyTargets.map(({ pool }) => studyTopLPers({ pool_address: pool.pool, limit: 4 }))
    );
    const lpStudyByPool = new Map();
    lpStudyTargets.forEach(({ pool }, idx) => {
      const result = lpStudyResults[idx];
      if (result?.status === "fulfilled") lpStudyByPool.set(pool.pool, result.value);
      else if (result?.reason) log("screening", `LPAgent study unavailable for ${pool.name}: ${result.reason.message || result.reason}`);
    });

    const funnelCounts = {
      gmgn: candidates.length,
      x_pass: 0,
      x_fail_open: 0,
      pool_pass: 0,
      discord_active: 0,
      band_A: 0,
      band_B: 0,
      reject: 0,
    };

    const scoredPassing = passing.map((entry) => {
      const { pool, sw, x } = entry;
      const lpSignal = lpStudyByPool.get(pool.pool)?.screening_signal || null;
      pool.lpagent_confidence = lpSignal?.confidence || null;
      pool.x_narrative = x || { narrative_confidence: "unknown" };
      pool.x_narrative_score = x?.x_narrative_score ?? 0;
      const banding = config.screening.screenerFunnelEnabled
        ? assignBand({
            active_tvl: pool.active_tvl,
            open_positions: pool.open_positions,
            fee_active_tvl_ratio: pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio,
            volatility: pool.volatility,
            token_age_hours: pool.token_age_hours,
            fragility_level: pool.entry_fragility_level,
            lpagent_confidence: pool.lpagent_confidence,
            discord_active: Boolean(pool.discord_signal),
            organic_score: pool.organic_score,
            smart_wallet_count: sw?.in_pool?.length ?? 0,
            base_mint: pool.base?.mint || pool.base_mint || null,
            token_loss_count: getTokenLossCount(pool.base?.mint || pool.base_mint),
          }, {
            narrative_confidence: x?.narrative_confidence,
            shill_burst_flag: x?.shill_burst_flag,
            x_unavailable_reason: x?.reason,
            lpagent_confidence: pool.lpagent_confidence,
            organic_score: pool.organic_score,
            smart_wallet_count: sw?.in_pool?.length ?? 0,
            token_loss_count: getTokenLossCount(pool.base?.mint || pool.base_mint),
          }, config.screening)
        : { band: pool.discord_signal ? "A" : "B", reasons: ["funnel disabled"], risks: [] };

      if (x?.narrative_confidence && !["unknown", "absent", "weak"].includes(String(x.narrative_confidence).toLowerCase())) funnelCounts.x_pass++;
      if ((banding.reasons || []).some((reason) => /fail-open enabled/i.test(String(reason)))) funnelCounts.x_fail_open++;
      if (["A", "B"].includes(banding.band)) funnelCounts.pool_pass++;
      if (pool.discord_signal) funnelCounts.discord_active++;
      if (banding.band === "A") funnelCounts.band_A++;
      else if (banding.band === "B") funnelCounts.band_B++;
      else funnelCounts.reject++;

      pool.screening_band = banding.band;
      pool.funnel_reasons = banding.reasons || [];
      pool.funnel_risks = banding.risks || [];
      return { ...entry, lpSignal, banding };
    });

    const visiblePassing = scoredPassing.filter(({ banding }) => ["A", "B"].includes(banding.band));
    log("screening", `funnel: gmgn=${funnelCounts.gmgn} x_pass=${funnelCounts.x_pass} x_fail_open=${funnelCounts.x_fail_open} pool_pass=${funnelCounts.pool_pass} discord_active=${funnelCounts.discord_active} → band_A=${funnelCounts.band_A} band_B=${funnelCounts.band_B} reject=${funnelCounts.reject}`);

    if (visiblePassing.length === 0) {
      const funnelSummary = buildConfidenceFunnelReport(funnelCounts, scoredPassing, xApiHealth);
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 5).map((entry) => `- ${entry.name}: ${entry.reason}`).join("\n");
      screenReport = `No candidates survived the confidence funnel.\n\n${funnelSummary}${combinedExamples ? `\n\nEarlier filters:\n${combinedExamples}` : ""}`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Confidence funnel rejected all candidates",
        reason: screenReport,
      });
      return screenReport;
    }

    if (config.screening.weakBatchSkip !== false) {
      const hasAnyQualitySignal = visiblePassing.some(({ pool, sw, n, lpSignal, x }) => {
        const organic = Number(pool.organic_score);
        const mcap = Number(pool.mcap);
        const smart = (sw?.in_pool?.length ?? 0) > 0;
        const kol = !!pool.kol_in_clusters;
        const narrative = !!n?.narrative;
        const xStrong = ["moderate", "strong"].includes(String(x?.narrative_confidence || "").toLowerCase());
        const lpStrong = lpSignal && /high|strong|moderate/i.test(String(lpSignal.confidence || ""));
        return (Number.isFinite(organic) && organic >= 40)
          || (Number.isFinite(mcap) && mcap >= 300000)
          || smart || kol || narrative || xStrong || lpStrong;
      });
      if (!hasAnyQualitySignal) {
        const leaders = visiblePassing.slice(0, 3).map(({ pool, sw, banding }) => `- ${pool.name}: band=${banding.band}, organic=${pool.organic_score ?? 0}, mcap=$${pool.mcap ?? 0}, smart=${sw?.in_pool?.length ?? 0}, x=${pool.x_narrative?.narrative_confidence ?? "?"}`).join("\n");
        const msg = `No candidates worth deploying — weak batch.\nLeaders still lacked real conviction:\n${leaders}`;
        log("screening", msg);
        appendDecision({ type: "no_deploy", actor: "SCREENER", summary: "Weak batch — skipping deploy", reason: msg });
        return msg;
      }
    }

    const visiblePools = visiblePassing.map(({ pool }) => pool.pool);
    const activeBinByPool = new Map();
    activeBinResults.forEach((result, idx) => {
      const poolAddress = passing[idx]?.pool?.pool;
      if (result?.status === "fulfilled" && poolAddress && visiblePools.includes(poolAddress)) {
        activeBinByPool.set(poolAddress, result.value?.binId ?? null);
      }
    });

    const candidateBlocks = visiblePassing.map(({ pool, sw, n, ti, mem, lpSignal, x, banding }) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinByPool.get(pool.pool);
      const okxParts = [
        pool.risk_level != null ? `risk=${pool.risk_level}` : null,
        pool.bundle_pct != null ? `bundle=${pool.bundle_pct}%` : null,
        pool.sniper_pct != null ? `sniper=${pool.sniper_pct}%` : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%` : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%` : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;
      const okxTags = [
        pool.smart_money_buy ? "smart_money_buy" : null,
        pool.kol_in_clusters ? "kol_in_clusters" : null,
        pool.dex_boost ? "dex_boost" : null,
        pool.dex_screener_paid ? "dex_screener_paid" : null,
        pool.dev_sold_all ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");
      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;
      const lpSignalLine = lpSignal
        ? `  lpagent: ${lpSignal.confidence}(${lpSignal.score})${lpSignal.reasons?.length ? ` | + ${lpSignal.reasons.join("; ")}` : ""}${lpSignal.risks?.length ? ` | - ${lpSignal.risks.join("; ")}` : ""}`
        : null;
      const funnelLine = `  funnel: band=${banding.band} | x=${x?.narrative_confidence ?? "unknown"} | reasons=${(banding.reasons || []).join("; ") || "none"}${banding.risks?.length ? ` | risks=${banding.risks.join("; ")}` : ""}`;

      stageSignals(pool.pool, {
        gmgn_score: pool.gmgn_score ?? null,
        active_tvl: pool.active_tvl ?? null,
        open_positions: pool.open_positions ?? null,
        organic_score: pool.organic_score ?? null,
        fee_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
        fee_active_tvl_ratio: pool.fee_active_tvl_ratio ?? null,
        volume: pool.volume_window ?? null,
        mcap: pool.mcap ?? null,
        holder_count: ti?.holders ?? pool.holders ?? null,
        holders: ti?.holders ?? pool.holders ?? null,
        smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
        smart_wallet_count: sw?.in_pool?.length ?? 0,
        discord_active: Boolean(pool.discord_signal),
        narrative_quality: n?.narrative ? "present" : "absent",
        narrative_confidence: x?.narrative_confidence ?? null,
        x_narrative_score: x?.x_narrative_score ?? 0,
        volatility: pool.volatility ?? null,
        fragility_level: pool.entry_fragility_level ?? null,
        fragility_score: pool.entry_fragility_score ?? null,
        lpagent_confidence: lpSignal?.confidence ?? null,
        token_age_hours: pool.token_age_hours ?? null,
        screening_band: banding.band,
        funnel_reasons: banding.reasons || [],
        funnel_risks: banding.risks || [],
        x_unavailable_reason: x?.reason ?? null,
      });

      let block;
      if (pool.gmgn) {
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  deploy_args: band=${banding.band}, amount_y<=${deployAmount}, bins_above=0`,
          formatGmgnCandidateForPrompt(pool),
          funnelLine,
          `  fragility=${pool.entry_fragility_level ?? "?"}(${pool.entry_fragility_score ?? "?"}), recommended_bins_below=${pool.recommended_bins_below ?? "?"}${pool.support_bins_below != null ? `, support_bins=${pool.support_bins_below} (${pool.support_source || "support"})` : ""}`,
          pvpLine,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          lpSignalLine,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      } else {
        const gmgnPriceLine = pool.gmgn_price_action
          ? `  gmgn_price: rsi2=${pool.gmgn_price_action.rsi2 ?? "?"}, supertrend=${pool.gmgn_price_action.supertrend?.direction || "?"}, price_vs_ath=${pool.gmgn_price_action.priceVsAthPct ?? "?"}%, 1h_change=${pool.gmgn_price_action.priceChangePct ?? "?"}%, max_vol_candle=${pool.gmgn_price_action.maxVolumeShare ?? "?"}%`
          : null;
        block = [
          `POOL: ${pool.name} (${pool.pool})`,
          `  deploy_args: band=${banding.band}, amount_y<=${deployAmount}, bins_above=0`,
`  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}, fragility=${pool.entry_fragility_level ?? "?"}(${pool.entry_fragility_score ?? "?"})${pool.support_bins_below != null ? `, support_bins=${pool.support_bins_below}(${pool.support_source || "support"})` : ""}${pool.entry_fragility_reasons?.length ? ` [${pool.entry_fragility_reasons.slice(0,2).join(";")}]` : ""}`,
          `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
          funnelLine,
          gmgnPriceLine,
          pvpLine,
          okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
          okxTags ? `  tags: ${okxTags}` : null,
          pool.price_vs_ath_pct != null ? `  ath: price_vs_ath=${pool.price_vs_ath_pct}%${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
          `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
          lpSignalLine,
          activeBin != null ? `  active_bin: ${activeBin}` : null,
          priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
          n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
          mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
        ].filter(Boolean).join("\n");
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted = false;
    let deploySucceeded = false;
    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

FUNNEL SUMMARY
${buildConfidenceFunnelReport(funnelCounts, visiblePassing, xApiHealth)}

PRE-LOADED CANDIDATES (${visiblePassing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on funnel band first, then narrative quality, smart wallets, pool metrics, and LPAgent shortlist signal when present.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   strategy = ${config.strategy.strategy} (always use this, never change it).
   pass the candidate's band exactly (band = A or B).
   bins_below: omit (or use the candidate's recommended_bins_below). The runtime caps width based on volatility AND fragility — high-vol fragile pools must be tighter, not wider. You may pass a SMALLER value to tighten further; larger values are clamped down.
   bins_above = 0. Single-side SOL only: set amount_y, keep amount_x = 0.
   do NOT pass amount_y larger than ${deployAmount}.
   IMPORTANT — pass signal_snapshot so the deploy notification explains the reasoning:
   signal_snapshot: {
     band: "<A or B>",
     funnel_reasons: ["<reason1>", "<reason2>"],
     funnel_risks: ["<risk1>", "<risk2>"],
     fragility_score: <number>,
     fragility_level: "<normal/fast/ultrafragile>",
     token_age_hours: <number>,
     volatility: <number>,
     organic_score: <number>
   }
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- If a candidate was rejected for fragility plus weak fee economics, say that plainly in WHY SKIPPED or REJECTED.
- Treat LPAgent shortlist signal as a confidence modifier, not a blind override. Penalize stale LP cohorts or weak fee capture, reward deep/healthy cohorts.
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    const funnelAppend = buildGmgnFunnelReport(gmgnStageCounts, gmgnAllFiltered, { fromStage: 2 });
    screenReport = funnelAppend ? `${content}\n\n─────────────\n${funnelAppend}` : content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    _screeningLastFinishedAt = Date.now();
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  // Use setInterval for reliable timing (cron can fire multiple times per interval)
  const mgmtMs = Math.max(1, config.schedule.managementIntervalMin) * 60 * 1000;
  const screenMs = Math.max(1, config.schedule.screeningIntervalMin) * 60 * 1000;
  let _lastMgmtStart = 0;
  let _lastScreenStart = 0;

  const mgmtTask = setInterval(async () => {
    const now = Date.now();
    log("cron", `[setInterval] Triggered management cycle`);
    if (_managementBusy) return;
    if (now - _lastMgmtStart < mgmtMs * 0.8) return; // 80% debounce
    _lastMgmtStart = now;
    timers.managementLastRun = now;
    await runManagementCycle();
  }, mgmtMs);

  const screenTask = setInterval(() => {
    const now = Date.now();
    if (_screeningBusy) return;
    if (now - _lastScreenStart < screenMs * 0.8) return; // 80% debounce
    _lastScreenStart = now;
    runScreeningCycle();
  }, screenMs);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 08:00 UTC+8 (Asia/Singapore — stable offset, no DST)
  const briefingTask = cron.schedule(`0 8 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'Asia/Singapore' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Weekly source check — Mondays 09:00 UTC+8 (Asia/Singapore). Informs meteora→gmgn flip decision.
  const weeklySourceCheckTask = cron.schedule(`0 9 * * 1`, async () => {
    try {
      await runWeeklySourceCheck();
    } catch (e) {
      log("cron_error", `Weekly source check failed: ${e.message}`);
    }
  }, { timezone: 'Asia/Singapore' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (
          !p.pnl_pct_suspicious &&
          queuePeakConfirmation(p.position, p.pnl_pct, { immediate: !shouldUsePnlRecheck() }) &&
          shouldUsePnlRecheck()
        ) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation && shouldUsePnlRecheck()) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, exit.trailing_drop_pct ?? config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position, exit.trailing_drop_pct ?? config.management.trailingDropPct, exit.current_pnl_pct, exit.confirmation_delay_ms);
            }
            continue;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (_managementBusy || sinceLastTrigger < cooldownMs) {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — ${_managementBusy ? "already running" : "cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)"}`);
          } else {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            if (!_managementBusy) runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          }
          break;
        }
        const closeRule = getDeterministicCloseRule(p, config.management);
        if (closeRule) {
          if (closeRule.emergency) {
            log("state", `[PnL poll] 🚨 EMERGENCY close: ${p.pair} — ${closeRule.reason} — bypassing cooldown + LLM`);
            _pollTriggeredAt = Date.now();
            (async () => {
              try {
                const { executeTool } = await import("./tools/executor.js");
                await executeTool("close_position", { position_address: p.position, reason: closeRule.reason, emergency: true });
              } catch (e) {
                log("cron_error", `Emergency close failed for ${p.pair}: ${e.message}`);
              }
            })();
            break;
          }
          const cooldownMs = config.schedule.managementIntervalMin * 60 * 1000;
          const sinceLastTrigger = Date.now() - _pollTriggeredAt;
          if (_managementBusy || sinceLastTrigger < cooldownMs) {
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — ${_managementBusy ? "already running" : "cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)"}`);
          } else {
            _pollTriggeredAt = Date.now();
            log("state", `[PnL poll] Deterministic close rule: ${p.pair} — Rule ${closeRule.rule}: ${closeRule.reason} — triggering management`);
            if (!_managementBusy) runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          }
          break;
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog, weeklySourceCheckTask];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getBandConfigForPosition(tracked, managementConfig) {
  const fallback = String(managementConfig.managementBands?.fallback || "B").toUpperCase();
  const band = String(tracked?.management_band || fallback).toUpperCase();
  if (band === "A") return { band: "A", ...(managementConfig.managementBands?.bandA || {}) };
  if (band === "C") return { band: "C", ...(managementConfig.managementBands?.bandC || {}) };
  return { band: "B", ...(managementConfig.managementBands?.bandB || {}) };
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const strategy = tracked?.strategy ?? null;
  const deploySource = tracked?.deploy_source ?? "auto";
  const autoCloseDisabled = !!tracked?.auto_close_disabled;
  const ageMinutes = tracked?.deployed_at
    ? (Date.now() - new Date(tracked.deployed_at).getTime()) / 60000
    : (position.age_minutes ?? 0);
  const inManualGrace = deploySource === "manual" &&
    ageMinutes < (managementConfig.manualGracePeriodMinutes ?? 60);
  const inBidAskFillGrace = strategy === "bid_ask" &&
    ageMinutes < (managementConfig.bidAskFillMinutes ?? 60);
  const bandConfig = getBandConfigForPosition(tracked, managementConfig);
  const band = bandConfig.band;

  const pnlSuspect = (() => {
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  // Rule 0 — emergency: severe loss OR steep price drop. ALWAYS fires (even when held / in grace).
  const emergencyPnlThreshold = managementConfig.emergencyStopLossPct ?? -15;
  const emergencyPriceDrop = managementConfig.emergencyPriceDropPct5m ?? -25;
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= emergencyPnlThreshold) {
    return { action: "CLOSE", rule: 0, reason: `emergency pnl ${position.pnl_pct.toFixed(1)}%`, emergency: true };
  }
  const snaps = position.snapshots || [];
  if (snaps.length >= 3) {
    const recent = snaps.slice(-3);
    const oldestPrice = Number(recent[0]?.price);
    const newestPrice = Number(recent[recent.length - 1]?.price);
    if (Number.isFinite(oldestPrice) && oldestPrice > 0 && Number.isFinite(newestPrice)) {
      const dropPct = ((newestPrice - oldestPrice) / oldestPrice) * 100;
      if (dropPct <= emergencyPriceDrop) {
        return { action: "CLOSE", rule: 0, reason: `emergency price drop ${dropPct.toFixed(1)}% in last 3 snapshots`, emergency: true };
      }
    }
  }

  // Rules 1-5 skipped entirely when user has /hold'd this position.
  if (autoCloseDisabled) return null;

  // Rule 0.5 — Lower dump velocity guard (catches RoyalPop-style fast drops before SL)
  const velocityResult = computeLowerDumpVelocityClose({
    strategy,
    managementBand: band,
    mgmtConfig: managementConfig,
    activeBin: position.active_bin,
    lowerBin: position.lower_bin,
    oorDirection: position.active_bin < position.lower_bin ? "lower" : null,
    currentPnlPct: position.pnl_pct,
    snapshots: tracked?.snapshots || [],
  });
  if (velocityResult?.action === "EMERGENCY_CLOSE") {
    return { action: "CLOSE", rule: 0.5, reason: velocityResult.reason, emergency: true, management_band: band };
  }
  if (velocityResult?.action === "LOWER_DUMP_VELOCITY") {
    return { action: "CLOSE", rule: 0.5, reason: velocityResult.reason, classification: "lower_dump_velocity", management_band: band };
  }

  // Rule 1 — stop loss. Per-strategy: bid_ask gets a wider threshold because mark-to-market drawdown
  // during the fill phase is expected. Also skipped during manual grace (user is in control).
  const effectiveSlPct = strategy === "bid_ask"
    ? (managementConfig.stopLossPctBidAsk ?? managementConfig.stopLossPct)
    : managementConfig.stopLossPct;
  if (
    !inManualGrace &&
    !pnlSuspect &&
    position.pnl_pct != null &&
    effectiveSlPct != null &&
    position.pnl_pct <= effectiveSlPct
  ) {
    return { action: "CLOSE", rule: 1, reason: `stop loss (${strategy || "?"} SL ${effectiveSlPct}%)` };
  }
  // Rule 2 — take profit (skip in manual grace; trailing TP covers gain-locking)
  if (
    !inManualGrace &&
    !pnlSuspect &&
    position.pnl_pct != null &&
    position.pnl_pct >= managementConfig.takeProfitPct
  ) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  // Scale OOR bin threshold by bin_step so it represents a consistent % price move.
  // bin_step=100 (1%/bin) → threshold unchanged. bin_step=80 → wider tolerance. bin_step=125 → tighter.
  const binStep = position.bin_step ?? 100;
  const oorBinThreshold = Math.round(managementConfig.outOfRangeBinsToClose * (100 / binStep));
  if (
    !inManualGrace &&
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + oorBinThreshold
  ) {
    const pnl = Number(position.pnl_pct ?? 0);
    const harvestMin = bandConfig.pumpedHarvestMinPnlPct ?? 1.5;
    const harvest = !pnlSuspect && position.pnl_pct != null && pnl >= harvestMin;
    return {
      action: "CLOSE",
      rule: 3,
      reason: harvest
        ? `Harvest close (Band ${band}): pumped above range with pnl ${pnl.toFixed(2)}% >= ${harvestMin}% threshold`
        : `Protective close (Band ${band}): pumped above range but pnl ${pnl.toFixed(2)}% < ${harvestMin}% threshold`,
      classification: harvest ? "pumped_harvest" : "pumped_protective",
      management_band: band,
    };
  }
  // Rule 4-below — OOR below lower bin. For bid_ask within fill grace, this is the strategy paying off
  // (price dumped through your range = you've fully filled). Skip auto-close. Use per-band config
  // lowerOorWaitMinutes (GAP-A: band-adjusted, C=15/B=30/A=45), falling back to flat config.
  if (
    !inManualGrace &&
    !inBidAskFillGrace &&
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= (bandConfig.lowerOorWaitMinutes ?? managementConfig.outOfRangeWaitMinutesLower ?? managementConfig.outOfRangeWaitMinutes ?? 20)
  ) {
    const waitLimit = bandConfig.lowerOorWaitMinutes ?? managementConfig.outOfRangeWaitMinutesLower ?? managementConfig.outOfRangeWaitMinutes ?? 20;
    return {
      action: "CLOSE",
      rule: 4,
      reason: `Lower OOR close (Band ${band}): out of range for ${position.minutes_out_of_range ?? 0}m (limit: ${waitLimit}m)`,
      classification: "lower_oor_forced",
      management_band: band,
    };
  }
  // Rule 4-above — OOR above upper bin
  if (
    !inManualGrace &&
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= (bandConfig.upperOorWaitMinutes ?? managementConfig.outOfRangeWaitMinutesUpper ?? managementConfig.outOfRangeWaitMinutes)
  ) {
    const waitLimit = bandConfig.upperOorWaitMinutes ?? managementConfig.outOfRangeWaitMinutesUpper ?? managementConfig.outOfRangeWaitMinutes;
    return {
      action: "CLOSE",
      rule: 4,
      reason: `Upper OOR close (Band ${band}): out of range for ${position.minutes_out_of_range ?? 0}m (limit: ${waitLimit}m)`,
      classification: "upper_oor_forced",
      management_band: band,
    };
  }
  // Rule 4c — Fee-decay fragility signal (GAP-C) via shared helper.
  const feeDecayResult = computeFeeDecayClose({
    managementBand: band,
    mgmtConfig: managementConfig,
    ageMinutes,
    deployFeeTvl: tracked?.fee_tvl_ratio ?? tracked?.initial_fee_tvl_24h ?? null,
    currentFeeTvl: position.fee_per_tvl_24h ?? null,
    snapshots: tracked?.snapshots || [],
    inManualGrace,
  });
  if (feeDecayResult?.action === "FEE_DECAY") {
    return { ...feeDecayResult, rule: 4.3, classification: "fee_decay_fragility", management_band: band };
  }

  // Rule 5 — Low yield (only after position has had time to accumulate fees)
  if (
    !inManualGrace &&
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= (managementConfig.minAgeBeforeYieldCheck ?? 60)
  ) {
    // Confirm with recent snapshots: only close if fees are truly stagnant (< $0.10 growth over last 3 cycles)
    const snaps = position.snapshots || [];
    const feesStagnant = snaps.length < 3 || (() => {
      const recent = snaps.slice(-3);
      const feeGrowth = (recent[recent.length - 1].unclaimed_fees_usd ?? 0) - (recent[0].unclaimed_fees_usd ?? 0);
      return feeGrowth < 0.10;
    })();
    if (feesStagnant) {
      return { action: "CLOSE", rule: 5, reason: "low yield" };
    }
  }
  return null;
}

function buildConfidenceFunnelReport(counts = {}, candidates = [], xApiHealth = null) {
  const lines = [
    `confidence funnel: gmgn=${counts.gmgn ?? 0} | x_pass=${counts.x_pass ?? 0} | x_fail_open=${counts.x_fail_open ?? 0} | pool_pass=${counts.pool_pass ?? 0} | discord=${counts.discord_active ?? 0} | band_A=${counts.band_A ?? 0} | band_B=${counts.band_B ?? 0} | reject=${counts.reject ?? 0}`,
  ];
  const xHealthLine = formatXNarrativeHealthBlock(xApiHealth);
  if (xHealthLine) lines.push(xHealthLine);
  const rejected = candidates
    .filter((entry) => !["A", "B"].includes(entry?.banding?.band))
    .slice(0, 4)
    .map((entry) => `- ${entry.pool?.name}: ${(entry.banding?.reasons || []).join("; ") || "rejected"}`);
  if (rejected.length) lines.push("rejected examples:", ...rejected);
  return lines.join("\n");
}

function summarizeXNarrativeHealth(entries = []) {
  const results = entries
    .map((entry) => ({
      name: entry?.pool?.name || entry?.pool?.pool || "token",
      confidence: String(entry?.x?.narrative_confidence || "unknown").toLowerCase(),
      reason: String(entry?.x?.reason || "").trim(),
    }));
  const total = results.length;
  const unknownEntries = results.filter((item) => item.confidence === "unknown");
  const unknown = unknownEntries.length;
  const reasonCounts = new Map();
  for (const item of unknownEntries) {
    const reason = item.reason || "unspecified failure";
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  const topReasons = [...reasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason} (${count})`);
  const examples = unknownEntries.slice(0, 3).map((item) => item.name);
  return {
    total,
    unknown,
    unknownRate: total > 0 ? unknown / total : 0,
    degraded: unknown > 0,
    topReasons,
    examples,
  };
}

function formatXNarrativeHealthBlock(health) {
  if (!health?.degraded) return "";
  const reasonText = health.topReasons?.length ? ` | reasons=${health.topReasons.join(", ")}` : "";
  const exampleText = health.examples?.length ? ` | examples=${health.examples.join(", ")}` : "";
  return `x_api_health: unknown=${health.unknown}/${health.total}${reasonText}${exampleText}`;
}

function formatXNarrativeHealthLog(health) {
  return `X narrative degraded during screening: unknown=${health.unknown}/${health.total}${health.topReasons?.length ? ` | reasons=${health.topReasons.join(", ")}` : ""}${health.examples?.length ? ` | examples=${health.examples.join(", ")}` : ""}`;
}

function buildGmgnFunnelReport(stageCounts, allFiltered = [], { fromStage = 1 } = {}) {
  if (!stageCounts) return null;
  const sc = stageCounts;
  const funnel = `GMGN funnel: ranked=${sc.ranked ?? "?"} → S1=${sc.s1 ?? "?"} → S2=${sc.s2 ?? "?"} → S3=${sc.s3 ?? "?"} → S4=${sc.s4 ?? "?"} → final=${sc.s5 ?? "?"}`;
  const byStage = {};
  for (const f of allFiltered) {
    const numericStage = Number(f.stage);
    const hasNumericStage = Number.isFinite(numericStage);
    if (hasNumericStage && numericStage < fromStage) continue;

    // GMGN stages have numeric stage IDs. Local Meridian filters added after the
    // GMGN funnel (cooldowns, ATH, Meteora fee hard gate, blacklists, etc.) often
    // have no stage field. Label them explicitly instead of rendering "sundefined".
    const key = hasNumericStage ? `s${numericStage}` : "local";
    if (!byStage[key]) byStage[key] = [];
    byStage[key].push(`${f.name}: ${f.reason}`);
  }
  const stageLabels = {
    s2: "S2 info",
    s3: "S3 pool",
    s4: "S4 indicators",
    s5: "S5 pick",
    local: "Local filters",
  };
  const stageOrder = ["s2", "s3", "s4", "s5", "local"];
  const details = stageOrder
    .filter((key) => byStage[key]?.length)
    .map((key) => `${stageLabels[key] || key}:\n${byStage[key].map(r => `  • ${r}`).join("\n")}`)
    .join("\n");
  return details ? `${funnel}\n\n${details}` : funnel;
}

function estimateBinsToSupport(pool = {}) {
  const binStep = Number(pool.bin_step ?? pool.dlmm_bin_step ?? pool.binStep);
  const activePrice = Number(pool.price ?? pool.pool_price);
  if (!Number.isFinite(binStep) || binStep <= 0 || !Number.isFinite(activePrice) || activePrice <= 0) return null;

  const intervals = pool.indicator_confirmation?.intervals || [];
  const m15 = intervals.find((entry) => entry?.interval === "15_MINUTE") || intervals[0];
  const signal = m15?.signal || m15?.latest?.signal || null;
  const supportPrice = Number(signal?.supertrendValue ?? signal?.lowerBand ?? signal?.fib618 ?? signal?.fib50);
  if (!Number.isFinite(supportPrice) || supportPrice <= 0 || supportPrice >= activePrice) return null;

  const stepRatio = 1 + binStep / 10000;
  if (stepRatio <= 1) return null;
  const bins = Math.ceil(Math.log(activePrice / supportPrice) / Math.log(stepRatio));
  if (!Number.isFinite(bins) || bins < 0) return null;
  return {
    bins,
    supportPrice,
    activePrice,
    interval: m15?.interval || null,
    source: signal?.supertrendValue != null ? "supertrend" : signal?.lowerBand != null ? "lower_band" : signal?.fib618 != null ? "fib618" : "fib50",
  };
}

function computeCandidateFragility(pool = {}, ti = null) {
  let score = 0;
  const reasons = [];

  const mcap = Number(pool.mcap);
  if (Number.isFinite(mcap)) {
    if (mcap < 300000) { score += 20; reasons.push("microcap"); }
    else if (mcap < 750000) { score += 12; reasons.push("smallcap"); }
    else if (mcap < 1500000) { score += 6; reasons.push("mid-small cap"); }
  }

  const ageHours = Number(pool.token_age_hours);
  if (Number.isFinite(ageHours)) {
    if (ageHours < 6) { score += 18; reasons.push("very young token"); }
    else if (ageHours < 24) { score += 10; reasons.push("young token"); }
    else if (ageHours < 72) { score += 5; reasons.push("early token"); }
  }

  const tvl = Number(pool.active_tvl ?? pool.tvl);
  if (Number.isFinite(tvl)) {
    if (tvl < 25000) { score += 15; reasons.push("thin TVL"); }
    else if (tvl < 75000) { score += 8; reasons.push("moderate TVL"); }
  }

  const bots = Number(pool.gmgn_bot_holders_pct ?? ti?.audit?.bot_holders_pct);
  if (Number.isFinite(bots)) {
    if (bots > 35) { score += 12; reasons.push("high bots"); }
    else if (bots > 25) { score += 6; reasons.push("elevated bots"); }
  }

  const bundler = Number(pool.gmgn_token_info_bundler_pct ?? pool.gmgn_bundler_pct);
  if (Number.isFinite(bundler)) {
    if (bundler > 25) { score += 8; reasons.push("high bundler/fresh wallet activity"); }
    else if (bundler > 15) { score += 4; reasons.push("moderate bundler activity"); }
  }

  const top10 = Number(pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct ?? ti?.audit?.top_holders_pct);
  if (Number.isFinite(top10)) {
    if (top10 > 35) { score += 10; reasons.push("concentrated holders"); }
    else if (top10 > 25) { score += 5; reasons.push("some holder concentration"); }
  }

  const organic = Number(pool.organic_score);
  if (Number.isFinite(organic)) {
    if (organic < 40) { score += 8; reasons.push("weak organic flow"); }
    else if (organic < 60) { score += 4; reasons.push("middling organic flow"); }
  }

  const volatility = Number(pool.volatility);
  if (Number.isFinite(volatility) && volatility >= 5) {
    score += 10;
    reasons.push("high realized volatility");
  }

  const binStep = Number(pool.bin_step);
  if (Number.isFinite(binStep) && binStep >= 120) {
    score += 5;
    reasons.push("wide bin step");
  }

  const velocity5m = Number(pool.gmgn_price_action?.priceChangePct ?? pool.price_change_pct);
  if (Number.isFinite(velocity5m)) {
    const absVelocity = Math.abs(velocity5m);
    if (absVelocity >= 12) { score += 12; reasons.push("violent 5m velocity"); }
    else if (absVelocity >= 7) { score += 7; reasons.push("fast 5m velocity"); }
  }

  const maxVolumeShare = Number(pool.gmgn_price_action?.maxVolumeShare);
  if (Number.isFinite(maxVolumeShare)) {
    if (maxVolumeShare >= 35) { score += 8; reasons.push("candle expansion / crowding"); }
    else if (maxVolumeShare >= 20) { score += 4; reasons.push("volume concentration"); }
  }

  const level = score >= 40 ? "ultrafragile" : score >= 20 ? "fast" : "normal";
  return { score, level, reasons };
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const smartWalletCount = Math.max(sw?.in_pool?.length ?? 0, Number(pool.gmgn_smart_wallets ?? 0) || 0);
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);
  if (pool.is_wash) return "wash trading was flagged";
  if (pool.is_rugpull && smartWalletCount === 0) return "rugpull risk was flagged and no smart wallets offset it";
  if (pool.is_pvp && smartWalletCount === 0) return "PVP symbol conflict and no smart-wallet confirmation";
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }
  if (!hasNarrative && smartWalletCount === 0) return "only candidate has no narrative and no smart-wallet confirmation";
  return null;
}

// ═════════════════════════════════════
//  INTERACTIVE REPL
// ═════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;
let _pendingInput = null; // { key, page, menuMsgId }

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "No cached candidates yet. Run /screen first.";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return `${i + 1}. ${pool.name} | fee/aTVL ${feeTvl}% | vol $${vol} | in-range ${active}% | organic ${organic}`;
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `Latest candidates (${_latestCandidates.length}) — updated ${age}\n\n${lines.join("\n")}`;
}

function formatWalletStatus(wallet, positions) {
  const solTrend = getSolTrend(168);
  const deployAmount = computeDeployAmount(wallet.sol, solTrend?.changePct ?? null);
  const hive = isHiveMindEnabled() ? "on" : "off";
  return [
    `Wallet: ${wallet.sol} SOL ($${wallet.sol_usd})`,
    `SOL price: $${wallet.sol_price}`,
    `Open positions: ${positions.total_positions}/${config.risk.maxPositions}`,
    `Next deploy amount: ${deployAmount} SOL`,
    `Dry run: ${process.env.DRY_RUN === "true" ? "yes" : "no"}`,
    `HiveMind: ${hive}`,
  ].join("\n");
}

function formatConfigSnapshot() {
  return [
    "Config snapshot",
    "",
    `Screening source: ${config.screening.source}`,
    `Strategy: ${config.strategy.strategy} | bins: [${config.strategy.minBinsBelow}–${config.strategy.maxBinsBelow}] (volatility-scaled)`,
    `Deploy: ${config.management.deployAmountSol} SOL | gasReserve: ${config.management.gasReserve} | maxPositions: ${config.risk.maxPositions}`,
    `Stop loss: ${config.management.stopLossPct}% | take profit: ${config.management.takeProfitPct}%`,
    `Trailing: ${config.management.trailingTakeProfit ? "on" : "off"} | trigger ${config.management.trailingTriggerPct}% | drop ${config.management.trailingDropPct}%`,
    `OOR: ${config.management.outOfRangeWaitMinutes}m | cooldown ${config.management.oorCooldownTriggerCount}x / ${config.management.oorCooldownHours}h`,
    `Repeat deploy cooldown: ${config.management.repeatDeployCooldownEnabled ? "on" : "off"} | ${config.management.repeatDeployCooldownTriggerCount}x / ${config.management.repeatDeployCooldownHours}h | min fee earned ${config.management.repeatDeployCooldownMinFeeEarnedPct}% | ${config.management.repeatDeployCooldownScope}`,
    `Yield floor: ${config.management.minFeePerTvl24h}% | min age ${config.management.minAgeBeforeYieldCheck}m`,
    `Screening: ${config.screening.category} / ${config.screening.timeframe} | TVL ${config.screening.minTvl}-${config.screening.maxTvl}`,
    `GMGN interval: ${config.gmgn.interval} | OrderBy: ${config.gmgn.orderBy} | Dir: ${config.gmgn.direction}`,
    `Intervals: manage ${config.schedule.managementIntervalMin}m | screen ${config.schedule.screeningIntervalMin}m`,
    `HiveMind: ${isHiveMindEnabled() ? "enabled" : "disabled"}${config.hiveMind.agentId ? ` | ${config.hiveMind.agentId}` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    screeningSource: config.screening.source,
    gmgnRequireKol: config.gmgn.requireKol,
    gmgnInterval: config.gmgn.interval,
    gmgnIndicatorFilter: config.gmgn.indicatorFilter,
    gmgnMinVolume: config.gmgn.minVolume,
    gmgnMinTokenAgeHours: config.gmgn.minTokenAgeHours,
    gmgnMaxTokenAgeHours: config.gmgn.maxTokenAgeHours,
    gmgnMaxBundlerRate: config.gmgn.maxBundlerRate,
    gmgnPreferredKolNames: config.gmgn.preferredKolNames,
    gmgnPreferredKolMinHoldPct: config.gmgn.preferredKolMinHoldPct,
    gmgnDumpKolNames: config.gmgn.dumpKolNames,
    gmgnDumpKolMinHoldPct: config.gmgn.dumpKolMinHoldPct,
    gmgnIndicatorInterval: config.gmgn.indicatorInterval,
    gmgnRequireBullishSt: config.gmgn.indicatorRules?.requireBullishSupertrend,
    gmgnRejectAtBottom: config.gmgn.indicatorRules?.rejectAlreadyAtBottom,
    gmgnRequireAboveSt: config.gmgn.indicatorRules?.requireAboveSupertrend,
    gmgnMinRsi: config.gmgn.indicatorRules?.minRsi,
    gmgnMaxRsi: config.gmgn.indicatorRules?.maxRsi,
    gmgnMinKolCount: config.gmgn.minKolCount,
    gmgnMinTotalFeeSol: config.gmgn.minTotalFeeSol,
    gmgnMinHolders: config.gmgn.minHolders,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function inputButton(key, label, { digits = 0 } = {}) {
  const value = settingValue(key);
  const shown = value == null ? "off" : Number.isFinite(Number(value)) ? String(parseFloat(Number(value).toFixed(digits))) : String(value);
  return [settingButton(`${label}: ${shown} ✏`, `cfg:input:${key}`)];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Screening: ${config.screening.source} | GMGN KOL ${config.gmgn.requireKol ? "required" : "preferred"}`,
    `Strategy: ${config.strategy.strategy} | deploy ${config.management.deployAmountSol} SOL | max pos ${config.risk.maxPositions}`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Strategy", "cfg:page:strategy"),
    ],
    [
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
      settingButton("GMGN", "cfg:page:gmgn"),
      settingButton("KOL", "cfg:page:kol"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      inputButton("deployAmountSol", "Deploy SOL", { digits: 2 }),
      inputButton("gasReserve", "Gas reserve", { digits: 2 }),
      inputButton("maxPositions", "Max positions"),
      inputButton("maxDeployAmount", "Max SOL"),
      inputButton("takeProfitPct", "TP %"),
      inputButton("stopLossPct", "SL %"),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      inputButton("trailingTriggerPct", "Trail trigger", { digits: 1 }),
      inputButton("trailingDropPct", "Trail drop", { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      inputButton("repeatDeployCooldownTriggerCount", "Repeat count"),
      inputButton("repeatDeployCooldownHours", "Repeat hrs"),
      inputButton("repeatDeployCooldownMinFeeEarnedPct", "Min fee earned %", { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [
        settingButton("Source: Meteora", "cfg:set:screeningSource:meteora"),
        settingButton("Source: GMGN", "cfg:set:screeningSource:gmgn"),
        settingButton("Source: Hybrid", "cfg:set:screeningSource:hybrid"),
      ],
      [toggleButton("gmgnRequireKol", "GMGN require KOL")],
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton("5m", "cfg:set:gmgnInterval:5m"),
        settingButton("1h", "cfg:set:gmgnInterval:1h"),
        settingButton("6h", "cfg:set:gmgnInterval:6h"),
        settingButton("24h", "cfg:set:gmgnInterval:24h"),
      ],
      [
        inputButton("gmgnMinVolume", "Min volume")[0],
        inputButton("gmgnMinTokenAgeHours", "Min token age (h)")[0],
      ],
      [
        inputButton("gmgnMaxTokenAgeHours", "Max token age (h)")[0],
        inputButton("gmgnMaxBundlerRate", "Max bundler %")[0],
      ],
      [settingButton("KOL settings", "cfg:page:kol")],
      inputButton("managementIntervalMin", "Manage interval (min)"),
      inputButton("screeningIntervalMin", "Screen interval (min)"),
    ];
  } else if (page === "strategy") {
    rows = [
      [
        settingButton("spot", "cfg:set:strategy:spot"),
        settingButton("bid_ask", "cfg:set:strategy:bid_ask"),
      ],
      inputButton("minBinsBelow", "Min bins"),
      inputButton("maxBinsBelow", "Max bins"),
    ];
  } else if (page === "gmgn") {
    rows = [
      [toggleButton("gmgnIndicatorFilter", "Indicator filter"), toggleButton("gmgnRequireKol", "Require KOL")],
      [
        settingButton("TF: 5m", "cfg:set:gmgnIndicatorInterval:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:gmgnIndicatorInterval:15_MINUTE"),
        settingButton("TF: 1h", "cfg:set:gmgnIndicatorInterval:1h"),
      ],
      [toggleButton("gmgnRequireBullishSt", "Bullish ST"), toggleButton("gmgnRejectAtBottom", "Reject at bottom"), toggleButton("gmgnRequireAboveSt", "Above ST")],
      inputButton("gmgnMinRsi", "Min RSI"),
      inputButton("gmgnMaxRsi", "Max RSI"),
      inputButton("gmgnMinKolCount", "Min KOL"),
      inputButton("gmgnMinTotalFeeSol", "Min fee SOL"),
      inputButton("gmgnMinHolders", "Min holders"),
      [settingButton("KOL settings", "cfg:page:kol")],
    ];
  } else if (page === "kol") {
    rows = [
      inputButton("gmgnPreferredKolNames", "Preferred KOL (comma-sep)"),
      inputButton("gmgnPreferredKolMinHoldPct", "Preferred KOL min hold %"),
      inputButton("gmgnDumpKolNames", "Dump KOL (comma-sep)"),
      inputButton("gmgnDumpKolMinHoldPct", "Dump KOL min hold %"),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      inputButton("rsiLength", "RSI length"),
    ];
  } else {
    rows = [
      [
        settingButton("Source: Meteora", "cfg:set:screeningSource:meteora"),
        settingButton("Source: GMGN", "cfg:set:screeningSource:gmgn"),
        settingButton("Source: Hybrid", "cfg:set:screeningSource:hybrid"),
      ],
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  if (key === "gmgnPreferredKolNames" || key === "gmgnDumpKolNames") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "input") {
    const inputKey = parts[2];
    const currentVal = settingValue(inputKey);
    const inputPage = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(inputKey) ? "kol"
      : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(inputKey) ? "screen"
      : inputKey.startsWith("gmgn") && inputKey !== "gmgnRequireKol" ? "gmgn"
      : inputKey.startsWith("indicator") || inputKey === "chartIndicatorsEnabled" || inputKey === "rsiLength" || inputKey === "requireAllIntervals" ? "indicators"
      : ["minBinsBelow", "maxBinsBelow"].includes(inputKey) ? "strategy"
      : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "gmgnRequireKol"].includes(inputKey) ? "screen"
      : "risk";
    _pendingInput = { key: inputKey, page: inputPage, menuMsgId: msg.messageId };
    await answerCallbackQuery(msg.callbackQueryId);
    await sendMessage(`Enter new value for ${inputKey} (current: ${currentVal ?? "off"}):\nSend a number, or "off" to clear.`);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = ["gmgnPreferredKolNames", "gmgnPreferredKolMinHoldPct", "gmgnDumpKolNames", "gmgnDumpKolMinHoldPct"].includes(key) ? "kol"
    : ["gmgnMinVolume", "gmgnMaxBundlerRate", "gmgnMinTokenAgeHours", "gmgnMaxTokenAgeHours"].includes(key) ? "screen"
    : key.startsWith("gmgn") && key !== "gmgnRequireKol"
      ? "gmgn"
      : key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
        ? "indicators"
        : ["minBinsBelow", "maxBinsBelow"].includes(key)
          ? "strategy"
          : ["useDiscordSignals", "blockPvpSymbols", "managementIntervalMin", "screeningIntervalMin", "screeningSource", "gmgnRequireKol"].includes(key)
            ? "screen"
            : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  return [
    "Telegram commands",
    "",
    "/help — show commands",
    "/status — wallet + positions snapshot",
    "/wallet — wallet, deploy amount, HiveMind status",
    "/positions — list open positions",
    "/pool <n> — detailed info for one open position",
    "/close <n> — close one position by index",
    "/closeall — close all open positions",
    "/set <n> <note> — set note/instruction on position",
    "/config — show important runtime config",
    "/settings — button menu for common config",
    "/keys — list all settable config keys",
    "/setcfg <key> <value> — update persisted config",
    "/screen — refresh deterministic candidate list",
    "/candidates — show latest cached candidates",
    "/deploy <n> — deploy candidate by cached index",
    "/briefing — morning briefing",
    "/hive — HiveMind sync status",
    "/hive pull — manual HiveMind pull now",
    "/pause — stop cron cycles",
    "/resume — start cron cycles again",
    "/stop — shut down agent",
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      const source = pool.gmgn ? ` | GMGN smart ${pool.gmgn_smart_wallets ?? "?"}, KOL ${pool.gmgn_kol_wallets ?? "?"}, total fee ${pool.gmgn_total_fee_sol ?? "?"} SOL` : ` | organic ${pool.organic_score ?? "?"}`;
      return `${i + 1}. ${pool.name} | ${pool.pool}\n   fee/aTVL ${feeTvl}% | vol $${vol}${source}`;
    });
    return `Top candidates (${candidates.length})\n\n${lines.join("\n")}`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `- ${entry.name}: ${entry.reason}`)
    .join("\n");
  return examples
    ? `No candidates available.\nFiltered examples:\n${examples}`
    : "No candidates available right now.";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  const solTrend = getSolTrend(168);
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol, solTrend?.changePct ?? null);
  const binsBelow = computeBinsBelow(candidate.volatility);
  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    band: candidate.screening_band ?? candidate.band ?? null,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.active_tvl ?? candidate.tvl ?? null,
    mcap: candidate.mcap ?? null,
    token_age_hours: candidate.token_age_hours ?? null,
    top10_pct: candidate.gmgn_token_info_top10_pct ?? candidate.gmgn_top10_holder_pct ?? null,
    bot_holders_pct: candidate.gmgn_bot_holders_pct ?? null,
    bundler_pct: candidate.gmgn_token_info_bundler_pct ?? candidate.gmgn_bundler_pct ?? null,
    velocity_5m_pct: candidate.gmgn_price_action?.priceChangePct ?? candidate.price_change_pct ?? null,
    acceleration_1m_pct: candidate.gmgn_price_action?.rsi2 != null ? (50 - Number(candidate.gmgn_price_action.rsi2)) / 10 : null,
    max_volume_share_pct: candidate.gmgn_price_action?.maxVolumeShare ?? null,
    narrative_confidence: candidate.x_narrative?.narrative_confidence ?? null,
    x_narrative_score: candidate.x_narrative?.x_narrative_score ?? null,
    fragility_level: candidate.entry_fragility_level ?? null,
    fragility_score: candidate.entry_fragility_score ?? null,
    lpagent_confidence: candidate.lpagent_confidence ?? null,
    smart_wallets_present: candidate.smart_wallet_count > 0,
    smart_wallet_count: candidate.smart_wallet_count ?? 0,
    discord_active: Boolean(candidate.discord_signal),
    gmgn_score: candidate.gmgn_score ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;

  if (_pendingInput && !msg.isCallback && !text.startsWith("/")) {
    const { key, page, menuMsgId } = _pendingInput;
    _pendingInput = null;
    let value;
    if (text.toLowerCase() === "off" || text.toLowerCase() === "null") {
      value = null;
    } else {
      value = Number(text);
      if (!Number.isFinite(value)) {
        await sendMessage(`Invalid value "${text}" — must be a number or "off".`);
        return;
      }
    }
    const result = await executeTool("update_config", { changes: { [key]: value }, reason: "Telegram input field" });
    if (!result?.success) {
      await sendMessage(`Failed to update ${key}.`);
      return;
    }
    await showSettingsMenu({ messageId: menuMsgId, page });
    return;
  }
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendMessage(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n\nUse /positions for the numbered list.`
        : "";
      await sendMessage(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendMessage(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/keys") {
    const msg = [
      "Settable config keys (use /setcfg key value or tell the bot):",
      "",
      "SCREENING",
      "minFeeActiveTvlRatio, minTvl, maxTvl, minVolume, minOrganic, minQuoteOrganic",
      "minHolders, minMcap, maxMcap, minBinStep, maxBinStep, timeframe, category",
      "minTokenFeesSol, maxBundlePct, maxBotHoldersPct, maxTop10Pct, maxVolatility",
      "minTokenAgeHours, maxTokenAgeHours, athFilterPct, blockedLaunchpads",
      "avoidPvpSymbols, blockPvpSymbols, excludeHighSupplyConcentration",
      "",
      "MANAGEMENT",
      "deployAmountSol, gasReserve, positionSizePct, minSolToOpen",
      "stopLossPct, takeProfitPct, trailingTakeProfit, trailingTriggerPct, trailingDropPct",
      "outOfRangeWaitMinutes, outOfRangeBinsToClose, oorCooldownHours, oorCooldownTriggerCount",
      "minFeePerTvl24h, minAgeBeforeYieldCheck, minClaimAmount, autoSwapAfterClaim",
      "spotAddEnabled, spotAddMinAgeMinutes, spotAddFeeSpikeMultiplier, spotAddSizePct",
      "tokenCooldownAfterLosses, tokenGlobalCooldownHours",
      "",
      "RISK",
      "maxPositions, maxDeployAmount",
      "",
      "SCHEDULE",
      "managementIntervalMin, screeningIntervalMin",
      "",
      "MODELS",
      "managementModel, screeningModel, generalModel, temperature, maxTokens",
      "",
      "STRATEGY",
      "strategy (bid_ask/spot/curve), binsBelow",
      "",
      "SYSTEM",
      "dryRun",
    ].join("\n");
    await sendMessage(msg).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage([
        `${idx + 1}. ${pos.pair}`,
        `Pool: ${pos.pool}`,
        `Position: ${pos.position}`,
        `Range: ${pos.lower_bin} → ${pos.upper_bin} | active ${pos.active_bin}`,
        `PnL: ${pos.pnl_pct ?? "?"}% | fees: ${config.management.solMode ? "◎" : "$"}${pos.unclaimed_fees_usd ?? "?"}`,
        `Value: ${config.management.solMode ? "◎" : "$"}${pos.total_value_usd ?? "?"}`,
        `Age: ${pos.age_minutes ?? "?"}m | ${pos.in_range ? "IN RANGE" : `OOR ${pos.minutes_out_of_range ?? 0}m`}`,
        pos.instruction ? `Note: ${pos.instruction}` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendMessage("No open positions."); return; }
      await sendMessage(`Closing ${positions.length} position(s)...`);
      const results = [];
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          results.push(`${pos.pair}: ${result.success ? "closed" : `failed (${result.error || "unknown"})`}`);
        } catch (error) {
          results.push(`${pos.pair}: failed (${error.message})`);
        }
      }
      await sendMessage(`Close-all finished.\n\n${results.join("\n")}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendMessage(`Config update failed.\nUnknown: ${(result?.unknown || []).join(", ") || "none"}`).catch(() => {});
        return;
      }
      await sendMessage(`✅ Updated ${key} = ${JSON.stringify(value)}`).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendMessage(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendMessage(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      const { candidate, result, deployAmount, binsBelow } = await deployLatestCandidate(idx);
      const coverage = result.range_coverage
        ? `Range: ${fmtPct(result.range_coverage.downside_pct)} downside | ${fmtPct(result.range_coverage.upside_pct)} upside`
        : `Strategy: ${config.strategy.strategy} | binsBelow: ${binsBelow}`;
      await sendMessage([
        `✅ Deployed ${candidate.name}`,
        `Pool: ${candidate.pool}`,
        `Amount: ${deployAmount} SOL`,
        coverage,
        `Position: ${result.position || "n/a"}`,
        result.txs?.length ? `Tx: ${result.txs[0]}` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendMessage("⏸ Paused autonomous cycles. Telegram control still works. Use /resume to start again.").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendMessage("▶️ Autonomous cycles resumed.").catch(() => {});
    } else {
      await sendMessage("Autonomous cycles are already running.").catch(() => {});
    }
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendMessage(`HiveMind: disabled\nAgent ID: ${agentId}\nSet hiveMindApiKey to connect.`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendMessage([
        "HiveMind: enabled",
        `Agent ID: ${agentId}`,
        `URL: ${config.hiveMind.url}`,
        `Pull mode: ${pullMode}`,
        `Register: ${registerResult ? "ok" : "warn"}`,
        `Shared lessons: ${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}`,
        `Presets: ${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}`,
        isManualPull ? "Manual pull: completed" : null,
      ].join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      deploySource: "manual", // Telegram is always user-initiated, regardless of role
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      const startupStep3 = process.env.DRY_RUN === "true"
        ? `3. Ignore wallet SOL threshold in dry run: get_top_candidates then simulate deploy ${DEPLOY} SOL.`
        : `3. If SOL >= ${config.management.minSolToOpen}: get_top_candidates then deploy ${DEPLOY} SOL.`;
      await agentLoop(`
STARTUP CHECK
1. get_wallet_balance. 2. get_my_positions. ${startupStep3} 4. Report.
      `, config.llm.maxSteps, [], "SCREENER");
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
