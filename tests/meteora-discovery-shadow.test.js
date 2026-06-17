import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMeteoraDiscoveryShadowFilters,
  normalizeMeteoraDiscoveryPool,
  summarizeMeteoraDiscoveryShadow,
} from "../tools/meteora-discovery-shadow.js";

const samplePool = {
  pool_address: "Pool111",
  name: "TEST-SOL",
  pool_type: "dlmm",
  tvl: 5000,
  active_tvl: 4500,
  volume: 3000,
  fee: 18,
  fee_active_tvl_ratio: 0.4,
  volatility: 3.1,
  active_positions: 18,
  active_positions_pct: 60,
  open_positions: 25,
  base_token_holders: 900,
  dlmm_params: { bin_step: 100 },
  pool_price_change_pct: 8,
  price_trend: [1, 1.01, 1.04],
  token_x: {
    symbol: "TEST",
    address: "Mint111",
    organic_score: 75,
    market_cap: 250000,
    warnings: [],
    has_high_supply_concentration: false,
    has_high_single_ownership: false,
    created_at: Date.now() - 36 * 3600_000,
  },
  token_y: {
    symbol: "SOL",
    address: "So11111111111111111111111111111111111111112",
    warnings: [],
  },
};

test("buildMeteoraDiscoveryShadowFilters emits Yunus-style Pool Discovery filters", () => {
  const filters = buildMeteoraDiscoveryShadowFilters();
  assert.match(filters, /pool_type=dlmm/);
  assert.match(filters, /base_token_market_cap>=200000/);
  assert.match(filters, /base_token_holders>=791/);
  assert.match(filters, /volume>=2000/);
  assert.match(filters, /tvl>=2000/);
  assert.match(filters, /fee_active_tvl_ratio>=0.2/);
  assert.match(filters, /base_token_has_high_supply_concentration=false/);
});

test("normalizeMeteoraDiscoveryPool marks a clean SOL pool as a Yunus match", () => {
  const normalized = normalizeMeteoraDiscoveryPool(samplePool);
  assert.equal(normalized.yunus_match, true);
  assert.equal(normalized.quote_symbol, "SOL");
  assert.equal(normalized.price_trend_direction, "rising");
  assert.equal(normalized.checks.open_positions, true);
  assert.equal(normalized.checks.volatility_medium, true);
});

test("normalizeMeteoraDiscoveryPool rejects non-SOL or low-social-proof pools from match", () => {
  const normalized = normalizeMeteoraDiscoveryPool({
    ...samplePool,
    token_y: { symbol: "USDC", address: "USDC" },
    open_positions: 5,
  });
  assert.equal(normalized.yunus_match, false);
  assert.equal(normalized.checks.sol_quote, false);
  assert.equal(normalized.checks.open_positions, false);
});

test("summarizeMeteoraDiscoveryShadow reports overlap with main candidates", () => {
  const normalized = normalizeMeteoraDiscoveryPool(samplePool);
  const summary = summarizeMeteoraDiscoveryShadow([normalized], [{ pool: "Pool111", base: { mint: "Mint111" } }]);
  assert.equal(summary.returned, 1);
  assert.equal(summary.yunus_match, 1);
  assert.equal(summary.overlap_with_main_by_pool, 1);
  assert.equal(summary.overlap_with_main_by_mint, 1);
});
