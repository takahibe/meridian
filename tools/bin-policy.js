// Centralized bin-width policy. Imported by both index.js (screening) and
// tools/dlmm.js (deploy) so the LLM-supplied `bins_below` can be clamped
// against the same recommendation that screening computed.

import { config } from "../config.js";

export function computeBinsBelow(volatility, fragility = null) {
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  const v = Math.max(0, Number(volatility) || 0);
  // Sub-linear curve: vol=5 → ~1.0, vol=25 saturates at top end.
  // Without this, vol/5 made every meme pool clamp instantly to max width.
  const t = Math.min(1, Math.sqrt(v / 5) * 0.7);
  let bins = lo + t * (hi - lo);
  // Fragile pools deserve narrower ranges (faster, more capital-efficient,
  // less downside catch-net) — invert the old behavior.
  const level = fragility?.level ?? "normal";
  if (level === "ultrafragile") bins = lo + (bins - lo) * 0.35;
  else if (level === "fast")    bins = lo + (bins - lo) * 0.6;
  return Math.max(lo, Math.min(hi, Math.round(bins)));
}

const recommended = new Map();

export function setRecommendedBins(poolAddress, entry) {
  if (!poolAddress) return;
  recommended.set(poolAddress, { ...entry, ts: Date.now() });
}

export function getRecommendedBins(poolAddress) {
  if (!poolAddress) return null;
  const entry = recommended.get(poolAddress);
  if (!entry) return null;
  // 30-minute TTL — beyond that, fall back to volatility-only at deploy time.
  if (Date.now() - entry.ts > 30 * 60 * 1000) {
    recommended.delete(poolAddress);
    return null;
  }
  return entry;
}
