// tools/meteora-discovery-shadow.js
// Read-only Meteora Pool Discovery shadow probe for autoresearch.
// It records Yunus-style Pool Discovery candidates without changing deploy source,
// staged signals, or live screening decisions.

import fs from "fs";
import path from "path";
import { config } from "../config.js";
import { paths } from "../paths.js";
import { log } from "../logger.js";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const DEFAULTS = Object.freeze({
  pageSize: 50,
  minOrganic: 60,
  minMcap: 200_000,
  minHolders: 791,
  minVolume: 2_000,
  minActiveTvl: 2_000,
  minFeeActiveTvlRatio: 0.2,
  minOpenPositions: 20,
  minVolatility: 2,
  maxVolatility: 4,
  quoteSymbols: ["SOL"],
  requireDlmm: true,
  requireSafeguard: true,
  recordTopN: 20,
});

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round(value, digits = 4) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  const m = 10 ** digits;
  return Math.round(n * m) / m;
}

function appendJsonl(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

function shadowConfig() {
  return {
    ...DEFAULTS,
    ...(config.autoresearch?.meteoraDiscoveryShadow || {}),
  };
}

function isEnabled() {
  return process.env.MERIDIAN_PROFILE === "autoresearch"
    && config.autoresearch?.enabled === true
    && config.autoresearch?.meteoraDiscoveryShadowEnabled === true;
}

export function buildMeteoraDiscoveryShadowFilters(options = {}) {
  const o = { ...DEFAULTS, ...options };
  return [
    o.requireSafeguard ? "base_token_has_critical_warnings=false" : null,
    o.requireSafeguard ? "quote_token_has_critical_warnings=false" : null,
    o.requireSafeguard ? "base_token_has_high_supply_concentration=false" : null,
    o.requireSafeguard ? "base_token_has_high_single_ownership=false" : null,
    o.requireDlmm ? "pool_type=dlmm" : null,
    `base_token_market_cap>=${o.minMcap}`,
    `base_token_holders>=${o.minHolders}`,
    `volume>=${o.minVolume}`,
    `tvl>=${o.minActiveTvl}`,
    `base_token_organic_score>=${o.minOrganic}`,
    `fee_active_tvl_ratio>=${o.minFeeActiveTvlRatio}`,
  ].filter(Boolean).join("&&");
}

function trendDirection(series = []) {
  const xs = Array.isArray(series) ? series.map(Number).filter(Number.isFinite) : [];
  if (xs.length < 2) return "unknown";
  const first = xs[0];
  const last = xs.at(-1);
  if (!Number.isFinite(first) || first === 0 || !Number.isFinite(last)) return "unknown";
  const pct = ((last - first) / Math.abs(first)) * 100;
  if (pct >= 2) return "rising";
  if (pct <= -2) return "falling";
  return "flat";
}

function quoteIsSol(raw = {}, quoteSymbols = DEFAULTS.quoteSymbols) {
  const symbol = String(raw.token_y?.symbol || "").toUpperCase();
  const mint = raw.token_y?.address;
  const allowed = new Set((quoteSymbols || []).map((s) => String(s).toUpperCase()));
  return allowed.has(symbol) || mint === SOL_MINT;
}

function noCriticalWarnings(token = {}) {
  const warnings = Array.isArray(token?.warnings) ? token.warnings : [];
  return !warnings.some((w) => String(w?.severity || "").toLowerCase() === "critical");
}

export function normalizeMeteoraDiscoveryPool(raw = {}, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const feeActiveTvlRatio = raw.fee_active_tvl_ratio > 0
    ? finiteOrNull(raw.fee_active_tvl_ratio)
    : (finiteOrNull(raw.active_tvl) > 0 && finiteOrNull(raw.fee) != null
      ? (finiteOrNull(raw.fee) / finiteOrNull(raw.active_tvl)) * 100
      : null);
  const priceTrendDirection = trendDirection(raw.price_trend);
  const activeTvl = finiteOrNull(raw.active_tvl ?? raw.tvl);
  const openPositions = finiteOrNull(raw.open_positions);
  const volatility = finiteOrNull(raw.volatility);
  const base = raw.token_x || {};
  const quote = raw.token_y || {};
  const safeguardApprox = noCriticalWarnings(base)
    && noCriticalWarnings(quote)
    && base.has_high_supply_concentration !== true
    && base.has_high_single_ownership !== true;

  const checks = {
    sol_quote: quoteIsSol(raw, o.quoteSymbols),
    dlmm: raw.pool_type === "dlmm",
    safeguard: safeguardApprox,
    organic: finiteOrNull(base.organic_score) >= o.minOrganic,
    mcap: finiteOrNull(base.market_cap) >= o.minMcap,
    holders: finiteOrNull(raw.base_token_holders) >= o.minHolders,
    volume: finiteOrNull(raw.volume) >= o.minVolume,
    active_tvl: activeTvl >= o.minActiveTvl,
    fee_active_tvl: feeActiveTvlRatio >= o.minFeeActiveTvlRatio,
    open_positions: openPositions >= o.minOpenPositions,
    volatility_medium: volatility >= o.minVolatility && volatility <= o.maxVolatility,
    price_trend_rising: priceTrendDirection === "rising",
  };

  const passed = Object.values(checks).filter(Boolean).length;
  const total = Object.keys(checks).length;

  return {
    pool: raw.pool_address ?? null,
    name: raw.name ?? null,
    source: "meteora_discovery_shadow",
    base_symbol: base.symbol ?? null,
    base_mint: base.address ?? null,
    quote_symbol: quote.symbol ?? null,
    quote_mint: quote.address ?? null,
    pool_type: raw.pool_type ?? null,
    bin_step: finiteOrNull(raw.dlmm_params?.bin_step),
    active_tvl: round(activeTvl, 2),
    tvl: round(raw.tvl, 2),
    volume: round(raw.volume, 2),
    fee: round(raw.fee, 4),
    fee_active_tvl_ratio: round(feeActiveTvlRatio, 4),
    volatility: round(volatility, 4),
    holders: finiteOrNull(raw.base_token_holders),
    mcap: round(base.market_cap, 2),
    organic_score: round(base.organic_score, 2),
    open_positions: openPositions,
    active_positions: finiteOrNull(raw.active_positions),
    active_positions_pct: round(raw.active_positions_pct, 2),
    price_change_pct: round(raw.pool_price_change_pct, 2),
    price_trend_direction: priceTrendDirection,
    token_age_hours: base.created_at ? Math.floor((Date.now() - Number(base.created_at)) / 3_600_000) : null,
    warning_types: Array.isArray(base.warnings) ? base.warnings.map((w) => w?.type).filter(Boolean) : [],
    checks,
    yunus_score: passed,
    yunus_score_max: total,
    yunus_match: checks.sol_quote && checks.dlmm && checks.safeguard && checks.organic && checks.mcap
      && checks.holders && checks.volume && checks.active_tvl && checks.fee_active_tvl
      && checks.open_positions && checks.volatility_medium,
  };
}

export function summarizeMeteoraDiscoveryShadow(pools = [], mainCandidates = []) {
  const byPool = new Set(mainCandidates.map((p) => p?.pool).filter(Boolean));
  const byMint = new Set(mainCandidates.map((p) => p?.base?.mint || p?.base_mint).filter(Boolean));
  const overlapPools = pools.filter((p) => byPool.has(p.pool));
  const overlapMints = pools.filter((p) => p.base_mint && byMint.has(p.base_mint));
  return {
    returned: pools.length,
    sol_quote: pools.filter((p) => p.checks?.sol_quote).length,
    yunus_match: pools.filter((p) => p.yunus_match).length,
    medium_volatility: pools.filter((p) => p.checks?.volatility_medium).length,
    min_open_positions: pools.filter((p) => p.checks?.open_positions).length,
    rising_price_trend: pools.filter((p) => p.checks?.price_trend_rising).length,
    overlap_with_main_by_pool: overlapPools.length,
    overlap_with_main_by_mint: overlapMints.length,
    top_names: pools.slice(0, 5).map((p) => p.name),
  };
}

export async function runMeteoraDiscoveryShadowProbe({ cycleId = null, mainSource = null, mainCandidates = [] } = {}) {
  if (!isEnabled()) return null;

  const o = shadowConfig();
  const filters = buildMeteoraDiscoveryShadowFilters(o);
  const params = new URLSearchParams({
    page_size: String(o.pageSize),
    filter_by: filters,
    timeframe: o.timeframe || config.screening.timeframe || "1h",
    category: o.category || config.screening.category || "trending",
  });
  const url = `${POOL_DISCOVERY_BASE}/pools?${params.toString()}`;
  const started = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora discovery shadow API ${res.status} ${res.statusText}`);
  const data = await res.json();
  const rawPools = Array.isArray(data?.data) ? data.data : [];
  const normalized = rawPools
    .map((pool) => normalizeMeteoraDiscoveryPool(pool, o))
    .sort((a, b) => {
      if (Number(b.yunus_match) !== Number(a.yunus_match)) return Number(b.yunus_match) - Number(a.yunus_match);
      if ((b.yunus_score ?? 0) !== (a.yunus_score ?? 0)) return (b.yunus_score ?? 0) - (a.yunus_score ?? 0);
      return (b.fee_active_tvl_ratio ?? 0) - (a.fee_active_tvl_ratio ?? 0);
    });
  const summary = summarizeMeteoraDiscoveryShadow(normalized, mainCandidates);
  const topN = Math.max(1, Number(o.recordTopN ?? DEFAULTS.recordTopN));

  const record = {
    ts: new Date().toISOString(),
    event: "meteora_discovery_shadow",
    profile: process.env.MERIDIAN_PROFILE || "production",
    run_id: config.autoresearch?.runId ?? null,
    cycle_id: cycleId,
    main_source: mainSource,
    shadow_only: true,
    api_total: data?.total ?? null,
    page_size: data?.page_size ?? o.pageSize,
    timeframe: o.timeframe || config.screening.timeframe || "1h",
    category: o.category || config.screening.category || "trending",
    thresholds: {
      minOrganic: o.minOrganic,
      minMcap: o.minMcap,
      minHolders: o.minHolders,
      minVolume: o.minVolume,
      minActiveTvl: o.minActiveTvl,
      minFeeActiveTvlRatio: o.minFeeActiveTvlRatio,
      minOpenPositions: o.minOpenPositions,
      minVolatility: o.minVolatility,
      maxVolatility: o.maxVolatility,
      quoteSymbols: o.quoteSymbols,
    },
    summary,
    candidates: normalized.slice(0, topN),
    elapsed_ms: Date.now() - started,
  };
  appendJsonl(paths.researchEventsPath, record);
  log(
    "autoresearch",
    `[meteora-shadow] total=${record.api_total ?? "?"} returned=${summary.returned} yunus_match=${summary.yunus_match} sol=${summary.sol_quote} overlap_pool=${summary.overlap_with_main_by_pool} top=${summary.top_names.join(", ") || "none"}`,
  );
  return record;
}
