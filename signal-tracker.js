/**
 * signal-tracker.js — Captures screening signals at deploy time for Darwinian weighting.
 *
 * During screening, signals are "staged" for each candidate pool.
 * When deploy_position fires, the staged signals are retrieved and stored
 * in state.json alongside the position, so we know exactly what signals
 * were present when the decision was made.
 *
 * This enables post-hoc analysis: which signals actually predicted wins?
 */

import { log } from "./logger.js";

// In-memory staging area — cleared after retrieval or after 10 minutes
const _staged = new Map();
const _stagedByBaseMint = new Map();
const STAGE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function normalizeKey(value) {
  return value ? String(value).trim() : null;
}

function cleanupStale() {
  const now = Date.now();
  for (const [addr, data] of _staged) {
    if (now - data.staged_at > STAGE_TTL_MS) {
      _staged.delete(addr);
      if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === addr) {
        _stagedByBaseMint.delete(data.base_mint);
      }
    }
  }
}

/**
 * Stage signals for a pool during screening.
 * Called after candidate data is loaded, before the LLM decides.
 * @param {string} poolAddress
 * @param {object} signals — { organic_score, fee_tvl_ratio, volume, mcap, holder_count, smart_wallets_present, narrative_quality, study_win_rate, hive_consensus, volatility }
 */
export function stageSignals(poolAddress, signals) {
  cleanupStale();
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;

  const baseMint = normalizeKey(signals?.base_mint || signals?.baseMint);
  _staged.set(poolKey, {
    ...signals,
    base_mint: baseMint || signals?.base_mint || null,
    staged_at: Date.now(),
  });
  if (baseMint) {
    _stagedByBaseMint.set(baseMint, poolKey);
  }
}

/**
 * Retrieve and clear staged signals for a pool.
 * Called from deployPosition after the position is created.
 * @param {string} poolAddress
 * @returns {object|null} Signal snapshot or null if not staged
 */
export function getAndClearStagedSignals(poolAddress, baseMint = null) {
  cleanupStale();

  let poolKey = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : null;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? _stagedByBaseMint.get(baseKey) : null;
    data = poolKey ? _staged.get(poolKey) : null;
  }

  if (!data) return null;
  _staged.delete(poolKey);
  if (data.base_mint && _stagedByBaseMint.get(data.base_mint) === poolKey) {
    _stagedByBaseMint.delete(data.base_mint);
  }
  const { staged_at, ...signals } = data;
  log("signals", `Retrieved staged signals for ${poolKey.slice(0, 8)}: ${Object.keys(signals).filter(k => signals[k] != null).length} signals`);
  return signals;
}

/**
 * Peek at staged signals for a pool WITHOUT clearing them.
 * Used by executor safety checks as code-computed ground truth — the deploy
 * path still consumes via getAndClearStagedSignals, so peeking must not
 * interfere with that.
 * @param {string} poolAddress
 * @returns {object|null} Signal snapshot or null if not staged
 */
export function peekStagedSignals(poolAddress, baseMint = null) {
  cleanupStale();

  let poolKey = normalizeKey(poolAddress);
  let data = poolKey ? _staged.get(poolKey) : null;

  if (!data && baseMint) {
    const baseKey = normalizeKey(baseMint);
    poolKey = baseKey ? _stagedByBaseMint.get(baseKey) : null;
    data = poolKey ? _staged.get(poolKey) : null;
  }

  if (!data) return null;
  const { staged_at, ...signals } = data;
  return signals;
}

// Per-cycle code-selected candidate (scoreCandidate order) — the screener LLM
// may only confirm or veto this pool, never substitute another one.
let _selectedPool = null;

/**
 * Stage the code-selected candidate for the current screening cycle.
 * Overwrites the previous cycle's selection; same TTL as staged signals.
 * @param {string} poolAddress
 */
export function stageSelectedPool(poolAddress) {
  const poolKey = normalizeKey(poolAddress);
  if (!poolKey) return;
  _selectedPool = { pool: poolKey, staged_at: Date.now() };
}

/**
 * Peek at the current cycle's code-selected pool WITHOUT clearing it.
 * @returns {string|null} Pool address or null if none staged / expired
 */
export function peekSelectedPool() {
  if (!_selectedPool) return null;
  if (Date.now() - _selectedPool.staged_at > STAGE_TTL_MS) {
    _selectedPool = null;
    return null;
  }
  return _selectedPool.pool;
}

/**
 * Get all currently staged pool addresses (for debugging).
 */
export function getStagedPools() {
  cleanupStale();
  return [..._staged.keys()];
}
