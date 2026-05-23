/**
 * SOL Price Tracker — stores recent price history for trend detection.
 * Used by computeDeployAmount to scale position size with market conditions.
 *
 * Data stored in /root/meridian/price-history.json
 * Format: [{ ts: number, price: number }, ...]  (max 7 days retained)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { paths } from "../paths.js";
import { log } from "../logger.js";

const HISTORY_PATH = paths.priceHistoryPath;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Load price history from disk.
 */
function loadHistory() {
  try {
    if (!existsSync(HISTORY_PATH)) return [];
    const data = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Save price history to disk, pruning entries older than 7 days.
 */
function saveHistory(entries) {
  const cutoff = Date.now() - MAX_AGE_MS;
  const fresh = entries.filter((e) => e.ts >= cutoff);
  try {
    writeFileSync(HISTORY_PATH, JSON.stringify(fresh, null, 2));
  } catch (err) {
    log("price_tracker", `Failed to save history: ${err.message}`);
  }
}

/**
 * Record a SOL price snapshot. Call once per screening cycle.
 * @param {number} price — current SOL/USD price
 */
export function recordSolPrice(price) {
  if (!price || price <= 0) return;
  const history = loadHistory();
  const now = Date.now();

  // Don't record more than once per 5 minutes
  const last = history[history.length - 1];
  if (last && now - last.ts < 5 * 60 * 1000) return;

  history.push({ ts: now, price });
  saveHistory(history);
}

/**
 * Calculate SOL price change over a lookback window.
 * @param {number} lookbackHours — how far back to look (default 168 = 7 days)
 * @returns {{ changePct: number, currentPrice: number, refPrice: number, dataPoints: number }}
 *   changePct: percentage change (e.g., -12.5 means -12.5%)
 *   Returns null if insufficient data.
 */
export function getSolTrend(lookbackHours = 168) {
  const history = loadHistory();
  if (history.length < 2) return null;

  const now = Date.now();
  const cutoff = now - lookbackHours * 60 * 60 * 1000;
  const windowEntries = history.filter((e) => e.ts >= cutoff);

  if (windowEntries.length < 2) return null;

  const currentPrice = windowEntries[windowEntries.length - 1].price;
  const refPrice = windowEntries[0].price;
  const changePct = ((currentPrice - refPrice) / refPrice) * 100;

  return {
    changePct: parseFloat(changePct.toFixed(2)),
    currentPrice,
    refPrice,
    dataPoints: windowEntries.length,
    windowHours: lookbackHours,
  };
}

/**
 * Get a compact trend summary string for logging.
 */
export function getSolTrendSummary() {
  const trend = getSolTrend(168); // 7 days
  if (!trend) return "SOL trend: insufficient data";
  const arrow = trend.changePct >= 0 ? "▲" : "▼";
  return `SOL ${arrow} ${Math.abs(trend.changePct).toFixed(1)}% (7d) | $${trend.currentPrice} ← $${trend.refPrice} | ${trend.dataPoints} pts`;
}
