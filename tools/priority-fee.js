/**
 * Priority fee + compute budget helpers for Meridian.
 *
 * Solana transactions without compute budget instructions get the default
 * 200K CU limit and zero priority fee. During congestion this means deploys
 * (which need ~1.2M CU) fail, and closes get dropped by validators.
 *
 * This module:
 * 1. Queries getRecentPrioritizationFees for network-aware pricing
 * 2. Provides preset CU limits per operation type
 * 3. Wraps transactions with ComputeBudgetProgram instructions
 */

import {
  ComputeBudgetProgram,
  Transaction,
} from "@solana/web3.js";
import { config } from "../config.js";
import { log } from "../logger.js";

// ─── CU Presets ────────────────────────────────────────────────
// Measured from Meteora DLMM operations + 10% buffer.
const CU_PRESETS = {
  deploy:     1_400_000,  // bin array init + add liquidity (wide range)
  close:        800_000,  // remove liquidity + close position
  claim:        400_000,  // claim fees only
  swap:         400_000,  // Jupiter swap
  default:      400_000,
};

// ─── Priority Fee Cache ────────────────────────────────────────
// Cache recent fees for 10s to avoid hammering the RPC.
let _feeCache = null;
let _feeCacheAt = 0;
const FEE_CACHE_TTL_MS = 10_000;

/**
 * Query Solana for recent prioritization fees and compute a reasonable price.
 * Returns microlamports per CU.
 */
export async function getPriorityFeePerCu(connection) {
  const now = Date.now();
  if (_feeCache && (now - _feeCacheAt) < FEE_CACHE_TTL_MS) {
    return _feeCache;
  }

  try {
    const recentFees = await connection.getRecentPrioritizationFees();
    const nonZero = recentFees
      .map(f => f.prioritizationFee)
      .filter(f => f > 0)
      .sort((a, b) => a - b);

    let feePerCu;
    if (nonZero.length === 0) {
      // Network is quiet — use floor
      feePerCu = getFloorFee();
    } else {
      // Use p50 (median) of recent non-zero fees, clamped to [floor, cap]
      const median = nonZero[Math.floor(nonZero.length / 2)];
      const floor = getFloorFee();
      const cap = getCapFee();
      feePerCu = Math.max(floor, Math.min(cap, median));
    }

    _feeCache = feePerCu;
    _feeCacheAt = now;
    return feePerCu;
  } catch (e) {
    log("priority_fee_warn", `getRecentPrioritizationFees failed: ${e.message} — using floor`);
    return getFloorFee();
  }
}

function getFloorFee() {
  return Number(config.execution?.priorityFeeFloor ?? 100);   // 100 μL/CU ≈ 0.0001 SOL for 1M CU
}

function getCapFee() {
  return Number(config.execution?.priorityFeeCap ?? 100_000); // 100K μL/CU ≈ 0.1 SOL for 1M CU — hard cap
}

/**
 * Get CU limit for an operation type.
 */
export function getCuLimit(operation) {
  const overrides = config.execution?.cuLimits || {};
  return overrides[operation] ?? CU_PRESETS[operation] ?? CU_PRESETS.default;
}

/**
 * Build compute budget instructions to prepend to a transaction.
 *
 * @param {Connection} connection
 * @param {string} operation - 'deploy' | 'close' | 'claim' | 'swap'
 * @param {number} [cuLimit] - Override CU limit (uses preset if omitted)
 * @returns {Promise<TransactionInstruction[]>}
 */
export async function buildComputeBudgetIx(connection, operation, cuLimit) {
  const cu = cuLimit ?? getCuLimit(operation);
  const feePerCu = await getPriorityFeePerCu(connection);

  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: cu });
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: feePerCu });

  const totalFeeLamports = Math.round(cu * feePerCu / 1_000_000);
  log("priority_fee", `${operation}: ${cu} CU × ${feePerCu} μL/CU = ~${totalFeeLamports} lamports priority`);

  return [limitIx, priceIx];
}

/**
 * Wrap an existing transaction with compute budget instructions.
 * Creates a new Transaction with budget Ix prepended.
 *
 * @param {Transaction} tx - Original transaction (unsigned)
 * @param {TransactionInstruction[]} budgetIx - From buildComputeBudgetIx
 * @returns {Transaction}
 */
export function prependComputeBudget(tx, budgetIx) {
  const wrapped = new Transaction();
  // Add compute budget instructions first
  for (const ix of budgetIx) {
    wrapped.add(ix);
  }
  // Copy original instructions
  for (const ix of tx.instructions) {
    wrapped.add(ix);
  }
  // Preserve fee payer and recent blockhash if set
  if (tx.feePayer) wrapped.feePayer = tx.feePayer;
  if (tx.recentBlockhash) wrapped.recentBlockhash = tx.recentBlockhash;
  return wrapped;
}
