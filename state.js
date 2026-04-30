/**
 * Persistent agent state — stored in state.json.
 *
 * Tracks position metadata that isn't available on-chain:
 * - When a position was deployed
 * - Strategy and bin config used
 * - When it first went out of range
 * - Actions taken (claims, rebalances)
 */

import fs from "fs";
import { log } from "./logger.js";

function resolveManagementBand(volatility, managementBands = {}) {
  const fallback = String(managementBands.fallback || "B").toUpperCase();
  const numericVol = Number(volatility);
  if (!Number.isFinite(numericVol)) return fallback;
  const bandA = managementBands.bandA || {};
  const bandB = managementBands.bandB || {};
  if (numericVol <= (bandA.maxVolatility ?? 1.8)) return "A";
  if (numericVol <= (bandB.maxVolatility ?? 3.0)) return "B";
  return "C";
}

function getBandConfig(bandKey, managementBands = {}) {
  const normalized = String(bandKey || managementBands.fallback || "B").toUpperCase();
  if (normalized === "A") return { key: "A", ...(managementBands.bandA || {}) };
  if (normalized === "C") return { key: "C", ...(managementBands.bandC || {}) };
  return { key: "B", ...(managementBands.bandB || {}) };
}

const STATE_FILE = "./state.json";

const MAX_RECENT_EVENTS = 20;
const MAX_INSTRUCTION_LENGTH = 280;

function sanitizeStoredText(text, maxLen = MAX_INSTRUCTION_LENGTH) {
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
  if (!fs.existsSync(STATE_FILE)) {
    return { positions: {}, recentEvents: [], pendingSweeps: [], lastUpdated: null };
  }
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(data.pendingSweeps)) data.pendingSweeps = [];
    return data;
  } catch (err) {
    log("state_error", `Failed to read state.json: ${err.message}`);
    return { positions: {}, pendingSweeps: [], lastUpdated: null };
  }
}

function save(state) {
  try {
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    log("state_error", `Failed to write state.json: ${err.message}`);
  }
}

// ─── Pending Sweeps (auto-swap-failed tokens awaiting retry) ───

export function addPendingSweep({ mint, label, pool }) {
  if (!mint) return;
  const state = load();
  if (!Array.isArray(state.pendingSweeps)) state.pendingSweeps = [];
  const existing = state.pendingSweeps.find((e) => e.mint === mint);
  if (existing) {
    existing.attempts = (existing.attempts || 0);
    existing.last_seen = new Date().toISOString();
    if (label) existing.label = label;
    if (pool) existing.pool = pool;
  } else {
    state.pendingSweeps.push({
      mint,
      label: label || mint.slice(0, 8),
      pool: pool || null,
      queued_at: new Date().toISOString(),
      last_attempt_at: null,
      attempts: 0,
    });
  }
  save(state);
  log("state", `Queued pending sweep: ${label || mint.slice(0, 8)}`);
}

export function getPendingSweeps() {
  const state = load();
  return Array.isArray(state.pendingSweeps) ? state.pendingSweeps : [];
}

export function markSweepAttempt(mint) {
  const state = load();
  const entry = state.pendingSweeps?.find((e) => e.mint === mint);
  if (entry) {
    entry.attempts = (entry.attempts || 0) + 1;
    entry.last_attempt_at = new Date().toISOString();
    save(state);
  }
}

export function clearPendingSweep(mint) {
  const state = load();
  if (!Array.isArray(state.pendingSweeps)) return;
  const before = state.pendingSweeps.length;
  state.pendingSweeps = state.pendingSweeps.filter((e) => e.mint !== mint);
  if (state.pendingSweeps.length !== before) {
    save(state);
    log("state", `Cleared pending sweep: ${mint.slice(0, 8)}`);
  }
}

// ─── Position Registry ─────────────────────────────────────────

/**
 * Record a newly deployed position.
 */
export function trackPosition({
  position,
  pool,
  pool_name,
  strategy,
  bin_range = {},
  amount_sol,
  amount_x = 0,
  active_bin,
  bin_step,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  signal_snapshot = null,
  deploy_source = "auto",
  management_config = null,
}) {
  const state = load();
  const managementBand = resolveManagementBand(volatility, management_config?.managementBands);
  const bandConfig = getBandConfig(managementBand, management_config?.managementBands);

  state.positions[position] = {
    position,
    pool,
    pool_name,
    strategy,
    bin_range,
    amount_sol,
    amount_x,
    active_bin_at_deploy: active_bin,
    bin_step,
    volatility,
    management_band: managementBand,
    management_band_config: bandConfig,
    fee_tvl_ratio,
    initial_fee_tvl_24h: fee_tvl_ratio,
    organic_score,
    initial_value_usd,
    signal_snapshot: signal_snapshot || null,
    deployed_at: new Date().toISOString(),
    deploy_source: deploy_source === "manual" ? "manual" : "auto",
    auto_close_disabled: false,
    stop_loss_warned_at: null,
    out_of_range_since: null,
    last_claim_at: null,
    total_fees_claimed_usd: 0,
    rebalance_count: 0,
    closed: false,
    closed_at: null,
    notes: [],
    peak_pnl_pct: 0,
    pending_peak_pnl_pct: null,
    pending_peak_started_at: null,
    pending_trailing_current_pnl_pct: null,
    pending_trailing_peak_pnl_pct: null,
    pending_trailing_drop_pct: null,
    pending_trailing_started_at: null,
    confirmed_trailing_exit_reason: null,
    confirmed_trailing_exit_until: null,
    trailing_active: false,
  };
  pushEvent(state, { action: "deploy", position, pool_name: pool_name || pool, management_band: managementBand });
  save(state);
  const rangeWidthBins = Number.isFinite(bin_range?.min) && Number.isFinite(bin_range?.max)
    ? Math.abs(bin_range.max - bin_range.min) + 1
    : null;
  log("state", `Tracked new position: ${position} in pool ${pool} | vol=${volatility ?? "?"} | band=${managementBand} | range_width_bins=${rangeWidthBins ?? "?"}`);
}

/**
 * Mark a position as out of range (sets timestamp on first detection).
 */
export function markOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (!pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    save(state);
    log("state", `Position ${position_address} marked out of range`);
  }
}

/**
 * Mark a position as back in range (clears OOR timestamp).
 */
export function markInRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  if (pos.out_of_range_since) {
    pos.out_of_range_since = null;
    save(state);
    log("state", `Position ${position_address} back in range`);
  }
}

/**
 * How many minutes has a position been out of range?
 * Returns 0 if currently in range.
 */
export function minutesOutOfRange(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || !pos.out_of_range_since) return 0;
  const ms = Date.now() - new Date(pos.out_of_range_since).getTime();
  return Math.floor(ms / 60000);
}

/**
 * Mark that a spot position has been added to a pool (prevents double-adding).
 */
export function markSpotAdded(pool_address) {
  if (!pool_address) return;
  const state = load();
  if (!state.spotAdds) state.spotAdds = {};
  state.spotAdds[pool_address] = new Date().toISOString();
  save(state);
  log("state", `Spot add recorded for pool ${pool_address.slice(0, 8)}`);
}

/**
 * Returns true if a spot position has already been added to this pool.
 */
export function hasSpotBeenAdded(pool_address) {
  if (!pool_address) return false;
  const state = load();
  return !!state.spotAdds?.[pool_address];
}

/**
 * Clear spot-add record for a pool (called when bid_ask position closes, resetting the cycle).
 */
export function clearSpotAdd(pool_address) {
  if (!pool_address) return;
  const state = load();
  if (state.spotAdds?.[pool_address]) {
    delete state.spotAdds[pool_address];
    save(state);
  }
}

/**
 * Record a fee claim event.
 */
export function recordClaim(position_address, fees_usd) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.last_claim_at = new Date().toISOString();
  pos.total_fees_claimed_usd = (pos.total_fees_claimed_usd || 0) + (fees_usd || 0);
  pos.notes.push(`Claimed ~$${fees_usd?.toFixed(2) || "?"} fees at ${pos.last_claim_at}`);
  save(state);
}

/**
 * Append to the recent events log (shown in every prompt).
 */
function pushEvent(state, event) {
  if (!state.recentEvents) state.recentEvents = [];
  state.recentEvents.push({ ts: new Date().toISOString(), ...event });
  if (state.recentEvents.length > MAX_RECENT_EVENTS) {
    state.recentEvents = state.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

/**
 * Mark a position as closed.
 */
export function recordClose(position_address, reason) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return;
  pos.closed = true;
  pos.closed_at = new Date().toISOString();
  pos.notes.push(`Closed at ${pos.closed_at}: ${reason}`);
  pushEvent(state, { action: "close", position: position_address, pool_name: pos.pool_name || pos.pool, reason });
  save(state);
  log("state", `Position ${position_address} marked closed: ${reason}`);
}

/**
 * Record a rebalance (close + redeploy).
 */
export function recordRebalance(old_position, new_position) {
  const state = load();
  const old = state.positions[old_position];
  if (old) {
    old.closed = true;
    old.closed_at = new Date().toISOString();
    old.notes.push(`Rebalanced into ${new_position} at ${old.closed_at}`);
  }
  const newPos = state.positions[new_position];
  if (newPos) {
    newPos.rebalance_count = (old?.rebalance_count || 0) + 1;
    newPos.notes.push(`Rebalanced from ${old_position}`);
  }
  save(state);
}

/**
 * Toggle the auto_close_disabled flag for a position.
 * When true, deterministic Rules 1-5 skip this position; only Rule 0 (emergency) still fires.
 */
export function setAutoCloseDisabled(position_address, disabled) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.auto_close_disabled = !!disabled;
  save(state);
  log("state", `Position ${position_address} auto_close_disabled = ${pos.auto_close_disabled}`);
  return true;
}

/**
 * Mark the time we sent a pre-close stop-loss warning for a position.
 * Used to debounce the warning so we don't spam Telegram every cron tick.
 */
export function markStopLossWarned(position_address) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.stop_loss_warned_at = new Date().toISOString();
  save(state);
  return true;
}

/**
 * Set a persistent instruction for a position (e.g. "hold until 5% profit").
 * Overwrites any previous instruction. Pass null to clear.
 */
export function setPositionInstruction(position_address, instruction) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos) return false;
  pos.instruction = sanitizeStoredText(instruction);
  save(state);
  log("state", `Position ${position_address} instruction set: ${pos.instruction}`);
  return true;
}

export function queuePeakConfirmation(position_address, candidatePnlPct, options = {}) {
  if (candidatePnlPct == null) return false;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const currentPeak = pos.peak_pnl_pct ?? 0;
  if (candidatePnlPct <= currentPeak) return false;

  if (options.immediate) {
    pos.peak_pnl_pct = candidatePnlPct;
    pos.pending_peak_pnl_pct = null;
    pos.pending_peak_started_at = null;
    save(state);
    log("state", `Position ${position_address} peak PnL accepted at ${candidatePnlPct.toFixed(2)}% from relay poll`);
    return true;
  }

  const changed =
    pos.pending_peak_pnl_pct == null ||
    candidatePnlPct > pos.pending_peak_pnl_pct;

  if (!changed) return false;

  pos.pending_peak_pnl_pct = candidatePnlPct;
  pos.pending_peak_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} peak candidate ${candidatePnlPct.toFixed(2)}% queued for 15s confirmation`);
  return true;
}

export function resolvePendingPeak(position_address, currentPnlPct, toleranceRatio = 0.85) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_peak_pnl_pct == null) return { confirmed: false, pending: false };

  const pendingPeak = pos.pending_peak_pnl_pct;
  pos.pending_peak_pnl_pct = null;
  pos.pending_peak_started_at = null;

  if (currentPnlPct != null && currentPnlPct >= pendingPeak * toleranceRatio) {
    pos.peak_pnl_pct = Math.max(pos.peak_pnl_pct ?? 0, pendingPeak, currentPnlPct);
    save(state);
    log("state", `Position ${position_address} peak PnL confirmed at ${pos.peak_pnl_pct.toFixed(2)}% after recheck`);
    return { confirmed: true, peak: pos.peak_pnl_pct };
  }

  save(state);
  log("state", `Position ${position_address} rejected pending peak ${pendingPeak.toFixed(2)}% after 15s recheck (current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true, pendingPeak };
}

export function queueTrailingDropConfirmation(position_address, peakPnlPct, currentPnlPct, trailingDropPct) {
  if (peakPnlPct == null || currentPnlPct == null || trailingDropPct == null) return false;
  const dropFromPeak = peakPnlPct - currentPnlPct;
  if (dropFromPeak < trailingDropPct) return false;

  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return false;

  const changed =
    pos.pending_trailing_current_pnl_pct == null ||
    currentPnlPct < pos.pending_trailing_current_pnl_pct ||
    dropFromPeak > (pos.pending_trailing_drop_pct ?? -Infinity);

  if (!changed) return false;

  pos.pending_trailing_peak_pnl_pct = peakPnlPct;
  pos.pending_trailing_current_pnl_pct = currentPnlPct;
  pos.pending_trailing_drop_pct = dropFromPeak;
  pos.pending_trailing_started_at = new Date().toISOString();
  save(state);
  log("state", `Position ${position_address} trailing drop candidate queued: peak ${peakPnlPct.toFixed(2)}% -> current ${currentPnlPct.toFixed(2)}%`);
  return true;
}

export function resolvePendingTrailingDrop(position_address, currentPnlPct, trailingDropPct, tolerancePct = 1.0) {
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed || pos.pending_trailing_current_pnl_pct == null || pos.pending_trailing_peak_pnl_pct == null) {
    return { confirmed: false, pending: false };
  }

  const pendingCurrent = pos.pending_trailing_current_pnl_pct;
  const pendingPeak = pos.pending_trailing_peak_pnl_pct;
  const pendingDrop = pos.pending_trailing_drop_pct ?? (pendingPeak - pendingCurrent);

  pos.pending_trailing_current_pnl_pct = null;
  pos.pending_trailing_peak_pnl_pct = null;
  pos.pending_trailing_drop_pct = null;
  pos.pending_trailing_started_at = null;

  const stillNearCrash = currentPnlPct != null && currentPnlPct <= pendingCurrent + tolerancePct;
  const stillDroppedEnough = currentPnlPct != null && (pendingPeak - currentPnlPct) >= trailingDropPct;

  if (stillNearCrash && stillDroppedEnough) {
    const band = pos.management_band || "B";
    const reason = `Trailing TP (Band ${band}): peak ${pendingPeak.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (drop ${(pendingPeak - currentPnlPct).toFixed(2)}% >= ${trailingDropPct}%)`;
    pos.confirmed_trailing_exit_reason = reason;
    pos.confirmed_trailing_exit_until = new Date(Date.now() + 30_000).toISOString();
    save(state);
    log("state", `Position ${position_address} trailing drop confirmed after recheck: pending drop ${pendingDrop.toFixed(2)}%, current ${currentPnlPct.toFixed(2)}%`);
    return { confirmed: true, reason };
  }

  save(state);
  log("state", `Position ${position_address} rejected trailing drop after 15s recheck (pending current: ${pendingCurrent.toFixed(2)}%, current: ${currentPnlPct ?? "?"}%)`);
  return { confirmed: false, rejected: true };
}

/**
 * Get all tracked positions (optionally filter open-only).
 */
export function getTrackedPositions(openOnly = false) {
  const state = load();
  const all = Object.values(state.positions);
  return openOnly ? all.filter((p) => !p.closed) : all;
}

/**
 * Get a single tracked position.
 */
export function getTrackedPosition(position_address) {
  const state = load();
  return state.positions[position_address] || null;
}

/**
 * Summarize state for the agent system prompt.
 */
export function getStateSummary() {
  const state = load();
  const open = Object.values(state.positions).filter((p) => !p.closed);
  const closed = Object.values(state.positions).filter((p) => p.closed);
  const totalFeesClaimed = Object.values(state.positions)
    .reduce((sum, p) => sum + (p.total_fees_claimed_usd || 0), 0);

  return {
    open_positions: open.length,
    closed_positions: closed.length,
    total_fees_claimed_usd: Math.round(totalFeesClaimed * 100) / 100,
    positions: open.map((p) => ({
      position: p.position,
      pool: p.pool,
      strategy: p.strategy,
      deployed_at: p.deployed_at,
      volatility: p.volatility ?? null,
      management_band: p.management_band ?? null,
      out_of_range_since: p.out_of_range_since,
      minutes_out_of_range: minutesOutOfRange(p.position),
      total_fees_claimed_usd: p.total_fees_claimed_usd,
      initial_fee_tvl_24h: p.initial_fee_tvl_24h,
      rebalance_count: p.rebalance_count,
      instruction: p.instruction || null,
    })),
    last_updated: state.lastUpdated,
    recent_events: (state.recentEvents || []).slice(-10),
  };
}

/**
 * Check all exit conditions for a position (trailing TP, stop loss, OOR, low yield).
 * Updates peak_pnl_pct, trailing_active, and OOR state.
 * @param {string} position_address
 * @param {object} positionData - fields from getMyPositions: pnl_pct, in_range, fee_per_tvl_24h
 * @param {object} mgmtConfig
 * Returns { action, reason } or null if no exit needed.
 */
export function updatePnlAndCheckExits(position_address, positionData, mgmtConfig) {
  const { pnl_pct: currentPnlPct, pnl_pct_suspicious, in_range, fee_per_tvl_24h, active_bin, lower_bin, upper_bin } = positionData;
  const state = load();
  const pos = state.positions[position_address];
  if (!pos || pos.closed) return null;

  if (pos.confirmed_trailing_exit_until) {
    if (new Date(pos.confirmed_trailing_exit_until).getTime() > Date.now() && pos.confirmed_trailing_exit_reason) {
      const reason = pos.confirmed_trailing_exit_reason;
      pos.confirmed_trailing_exit_reason = null;
      pos.confirmed_trailing_exit_until = null;
      save(state);
      return { action: "TRAILING_TP", reason, confirmed_recheck: true };
    }
    pos.confirmed_trailing_exit_reason = null;
    pos.confirmed_trailing_exit_until = null;
  }

  // /hold flag: hands-off completely — only the index.js Rule 0 emergency can still fire.
  if (pos.auto_close_disabled) return null;

  // Manual deploys get a grace window where SL / OOR / low-yield don't fire (trailing TP still does).
  const ageMinutes = pos.deployed_at ? (Date.now() - new Date(pos.deployed_at).getTime()) / 60000 : 0;
  const manualGraceMin = mgmtConfig.manualGracePeriodMinutes ?? 60;
  const inManualGrace = pos.deploy_source === "manual" && ageMinutes < manualGraceMin;

  let changed = false;

  const managementBand = pos.management_band || resolveManagementBand(pos.volatility, mgmtConfig.managementBands);
  const bandConfig = getBandConfig(managementBand, mgmtConfig.managementBands);
  if (pos.management_band !== managementBand) {
    pos.management_band = managementBand;
    changed = true;
  }
  pos.management_band_config = bandConfig;

  const trailingTriggerPct = bandConfig.trailingTriggerPct ?? mgmtConfig.trailingTriggerPct;
  const trailingDropPct = bandConfig.trailingDropPct ?? mgmtConfig.trailingDropPct;

  // Activate trailing TP once trigger threshold is reached
  if (mgmtConfig.trailingTakeProfit && !pos.trailing_active && (pos.peak_pnl_pct ?? 0) >= trailingTriggerPct) {
    pos.trailing_active = true;
    changed = true;
    log("state", `Position ${position_address} trailing TP activated (Band ${managementBand}, confirmed peak: ${pos.peak_pnl_pct}%)`);
  }

  // Detect OOR direction: "upper" = price moved above range (ideal exit for bid-ask cycle),
  // "lower" = price dumped below range (bag risk, wait for bounce).
  let oorDirection = null;
  if (in_range === false && Number.isFinite(active_bin)) {
    if (Number.isFinite(upper_bin) && active_bin > upper_bin) oorDirection = "upper";
    else if (Number.isFinite(lower_bin) && active_bin < lower_bin) oorDirection = "lower";
  }

  // Update OOR state
  if (in_range === false && !pos.out_of_range_since) {
    pos.out_of_range_since = new Date().toISOString();
    pos.out_of_range_direction = oorDirection;
    changed = true;
    log("state", `Position ${position_address} marked out of range (${oorDirection || "unknown"})`);
  } else if (in_range === true && pos.out_of_range_since) {
    pos.out_of_range_since = null;
    pos.out_of_range_direction = null;
    changed = true;
    log("state", `Position ${position_address} back in range`);
  } else if (in_range === false && oorDirection && pos.out_of_range_direction !== oorDirection) {
    pos.out_of_range_direction = oorDirection;
    changed = true;
  }

  if (changed) save(state);

  // ── Stop loss (per-strategy threshold) ────────────────────────
  // bid_ask is "buy the dip" — drawdown during fill is expected. Use a wider SL.
  const effectiveSlPct = pos.strategy === "bid_ask"
    ? (mgmtConfig.stopLossPctBidAsk ?? mgmtConfig.stopLossPct)
    : mgmtConfig.stopLossPct;
  if (
    !inManualGrace &&
    !pnl_pct_suspicious &&
    currentPnlPct != null &&
    effectiveSlPct != null &&
    currentPnlPct <= effectiveSlPct
  ) {
    return {
      action: "STOP_LOSS",
      reason: `Stop loss: PnL ${currentPnlPct.toFixed(2)}% <= ${effectiveSlPct}% (${pos.strategy})`,
    };
  }

  // ── Trailing TP ────────────────────────────────────────────────
  if (!pnl_pct_suspicious && pos.trailing_active) {
    const dropFromPeak = pos.peak_pnl_pct - currentPnlPct;
    if (dropFromPeak >= trailingDropPct) {
      return {
        action: "TRAILING_TP",
        reason: `Trailing TP (Band ${managementBand}): peak ${pos.peak_pnl_pct.toFixed(2)}% → current ${currentPnlPct.toFixed(2)}% (drop ${dropFromPeak.toFixed(2)}% >= ${trailingDropPct}%)`,
        needs_confirmation: true,
        peak_pnl_pct: pos.peak_pnl_pct,
        current_pnl_pct: currentPnlPct,
        drop_from_peak_pct: dropFromPeak,
        trailing_drop_pct: trailingDropPct,
        management_band: managementBand,
      };
    }
  }

  // ── Out of range too long ──────────────────────────────────────
  // bid_ask "fully filled" state = active_bin below lower_bin. That's the strategy paying off, not a panic
  // signal. Within bidAskFillMinutes after deploy, do not auto-close on OOR-below for bid_ask.
  if (!inManualGrace && pos.out_of_range_since) {
    const minutesOOR = Math.floor((Date.now() - new Date(pos.out_of_range_since).getTime()) / 60000);
    const dir = pos.out_of_range_direction;
    const bidAskFillMin = mgmtConfig.bidAskFillMinutes ?? 60;
    const inBidAskFillGrace = pos.strategy === "bid_ask" && dir === "lower" && ageMinutes < bidAskFillMin;
    if (!inBidAskFillGrace) {
      const waitLimit = dir === "upper"
        ? (bandConfig.upperOorWaitMinutes ?? mgmtConfig.outOfRangeWaitMinutesUpper ?? mgmtConfig.outOfRangeWaitMinutes)
        : dir === "lower"
        ? (mgmtConfig.outOfRangeWaitMinutesLower ?? mgmtConfig.outOfRangeWaitMinutes)
        : mgmtConfig.outOfRangeWaitMinutes;
      if (minutesOOR >= waitLimit) {
        return {
          action: "OUT_OF_RANGE",
          reason: dir === "upper"
            ? `Upper OOR close (Band ${managementBand}): out of range for ${minutesOOR}m (limit: ${waitLimit}m)`
            : `Out of range (${dir || "unknown"}) for ${minutesOOR}m (limit: ${waitLimit}m)`,
          management_band: managementBand,
        };
      }
    }
  }

  // ── Low yield (only after position has had time to accumulate fees) ───
  const { age_minutes } = positionData;
  const minAgeForYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? 60;
  if (
    !inManualGrace &&
    fee_per_tvl_24h != null &&
    mgmtConfig.minFeePerTvl24h != null &&
    fee_per_tvl_24h < mgmtConfig.minFeePerTvl24h &&
    (age_minutes == null || age_minutes >= minAgeForYieldCheck)
  ) {
    return {
      action: "LOW_YIELD",
      reason: `Low yield: fee/TVL ${fee_per_tvl_24h.toFixed(2)}% < min ${mgmtConfig.minFeePerTvl24h}% (age: ${age_minutes ?? "?"}m)`,
    };
  }

  return null;
}

// ─── Briefing Tracking ─────────────────────────────────────────

/**
 * Get the date (YYYY-MM-DD UTC) when the last briefing was sent.
 */
export function getLastBriefingDate() {
  const state = load();
  return state._lastBriefingDate || null;
}

/**
 * Record that the briefing was sent today.
 */
export function setLastBriefingDate() {
  const state = load();
  state._lastBriefingDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  save(state);
}

/**
 * Reconcile local state with actual on-chain positions.
 * Marks any local open positions as closed if they are not in the on-chain list.
 */
const SYNC_GRACE_MS = 5 * 60_000; // don't auto-close positions deployed < 5 min ago

export function syncOpenPositions(active_addresses) {
  const state = load();
  const activeSet = new Set(active_addresses);
  let changed = false;

  for (const posId in state.positions) {
    const pos = state.positions[posId];
    if (pos.closed || activeSet.has(posId)) continue;

    // Grace period: newly deployed positions may not be indexed yet
    const deployedAt = pos.deployed_at ? new Date(pos.deployed_at).getTime() : 0;
    if (Date.now() - deployedAt < SYNC_GRACE_MS) {
      log("state", `Position ${posId} not on-chain yet — within grace period, skipping auto-close`);
      continue;
    }

    pos.closed = true;
    pos.closed_at = new Date().toISOString();
    pos.notes.push(`Auto-closed during state sync (not found on-chain)`);
    changed = true;
    log("state", `Position ${posId} auto-closed (missing from on-chain data)`);
  }

  if (changed) save(state);
}
