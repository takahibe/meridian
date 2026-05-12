# Meridian v2 Enhancement Plan
## 4 Features from LP Army Intelligence

**Date:** 2026-05-05  
**Status:** DRAFT — Awaiting architect review before execution  
**Scope:** Fibonacci Integration, Bear Market Mode, Curve Strategy Toggle, Event Farming  

---

## 1. Executive Summary

This plan proposes 4 enhancements to Meridian based on analysis of 356 strategies from lparmy.com (largest Meteora LP community). Each feature addresses a documented gap between what top LPers manually do and what Meridian currently automates.

**Current Meridian baseline:**
- Strategy: bid_ask (hardcoded)
- Bin width: vol-scaled `computeBinsBelow()` with sqrt curve
- Screening: GMGN/Meteora hybrid, organic score gating
- Risk: 3 fragility bands (A/B/C) with auto-tuned thresholds
- Win rate: 85.3% over 191 positions

**Proposed additions:**
1. **Fibonacci Integration** — Auto-calculate fib-based bin ranges from recent price action
2. **Bear Market Mode** — Auto-detect bear regimes → switch to Spot-only + wider ranges
3. **Curve Strategy Toggle** — Add bell-shaped Curve as secondary strategy for ranging markets
4. **Event Farming** — Detect LGEs/new launches → deploy with DAMM-style tight ranges

---

## 2. Feature 1: Fibonacci Integration

### Problem
LP Army's top 3 creators (NAOJ, SATSMONKES, Logical TA) all use Fibonacci retracement levels to set bin boundaries. Meridian's current `computeBinsBelow()` uses a volatility-only sqrt curve with no awareness of recent price structure.

### Proposed Solution
Add a `fibBinRange` module that calculates fib levels from recent pool price action and blends them with the existing vol-based range.

### Implementation

**New file:** `tools/fib-range.js`

```
export function computeFibBinRange(pool, volatility, activeBin) {
  // Fetch recent 24h OHLC from GMGN or Meteora API
  // Calculate fib retracement levels: 0.236, 0.382, 0.5, 0.618, 0.786
  // Map fib levels to bin IDs using pool.bin_step
  // Return { minBin, maxBin, fibLevels[], confidence }
}
```

**Changes to `tools/bin-policy.js`:**
- Import `computeFibBinRange`
- Add `useFibRanges: boolean` to config (default: false initially)
- In `computeBinsBelow()`, if `useFibRanges` and fib data available:
  - Calculate both vol-based and fib-based ranges
  - Use the **tighter** of the two (conservative) or **weighted blend** based on fib confidence
  - `finalBins = fibConfidence > 0.7 ? fibRange : volRange`

**Changes to `prompt.js` (screener):**
- Add to screener instructions: "If fib_range_available, prefer fib-aligned bin boundaries for tighter entry"

**Changes to `user-config.json`:**
```json
{
  "strategy": {
    "useFibRanges": false,
    "fibConfidenceThreshold": 0.7,
    "fibLookbackHours": 24,
    "fibBlendWeight": 0.5
  }
}
```

### Data Sources
- GMGN price history API (existing integration)
- Meteora pool OHLC endpoint (if available)
- Fallback: Jupiter Price API for recent ticks

### Risks
- **API latency:** Adding price history fetch may slow screening by 1-2s
- **Low liquidity pools:** Fib levels on thin pools are noisy → confidence gate handles this
- **Backwards compatibility:** Default `false` → no change to current behavior until user enables

### Validation
- A/B test: 2 weeks with fib on for 50% of deploys, compare range_efficiency and peak_pnl
- Darwin should auto-learn whether fib improves or hurts performance

---

## 3. Feature 2: Bear Market Mode

### Problem
25% of LP Army strategies are bear-market specific. Meridian currently uses the same parameters regardless of SOL macro trend. During SOL downtrends:
- Meme volumes collapse → fee/TVL ratios drop
- bid_ask positions go OOR faster on dumps
- Spot (single-sided) becomes safer but Meridian doesn't auto-switch

### Proposed Solution
Add a `marketRegime` detector that classifies SOL trend and auto-adjusts strategy + risk parameters.

### Implementation

**New file:** `tools/market-regime.js`

```
export async function detectMarketRegime() {
  // Fetch SOL/USD 4h candles (Jupiter or CoinGecko)
  // Calculate:
  //   - 20-period EMA slope
  //   - RSI(14) on 4h
  //   - Volume trend vs 7d avg
  // Classify:
  //   'bull'    → EMA rising, RSI > 55, vol above avg
  //   'neutral' → EMA flat, RSI 45-55
  //   'bear'    → EMA falling, RSI < 45, vol declining
  return { regime, confidence, solPrice, slopePct };
}
```

**Changes to `config.js`:**
```json
{
  "marketRegime": {
    "enabled": true,
    "checkIntervalMin": 60,
    "bearModeTrigger": "bear",
    "bullModeTrigger": "bull"
  },
  "bearModeOverrides": {
    "defaultStrategy": "spot",
    "maxPositions": 2,
    "stopLossPct": -4,
    "trailingTriggerPct": 1.5,
    "trailingDropPct": 0.5,
    "minFeeActiveTvlRatio": 0.08,
    "maxVolatility": 2.0
  }
}
```

**Changes to `index.js` (screening cycle):**
- At start of each screening cycle, call `detectMarketRegime()`
- If regime changes → log to Telegram, apply overrides for next deploy
- If bear: switch screener default strategy to "spot", tighten SL, raise fee/TVL gate
- If bull: restore normal bid_ask params

**Changes to `prompt.js`:**
- Inject regime into screener prompt: "Current regime: BEAR. Prefer spot strategy, wider ranges, faster exits."

### Risks
- **False regime signals:** Choppy markets may flip between bull/bear frequently → add hysteresis (must persist for 3 checks = 3h before switching)
- **Missed opportunities:** Bear mode may be too conservative and miss early recovery pumps → keep maxPositions=2 (not 0) so some exposure remains

### Validation
- Backtest: Compare bear-mode SL vs normal SL during April 2025 SOL correction
- Forward test: Run bear mode for 2 weeks, compare drawdowns vs baseline

---

## 4. Feature 3: Curve Strategy Toggle

### Problem
LP Army data shows Curve (bell-shaped) outperforms bid_ask in sideways/ranging markets. Meridian only supports bid_ask. Adding Curve as a secondary strategy would improve fee capture when prices oscillate.

### Proposed Solution
Add `curve` as a deployable strategy shape. The screener or regime detector picks the optimal shape per market condition.

### Implementation

**Changes to `tools/dlmm.js`:**
- Current deploy function hardcodes bid_ask shape (liquidity concentrated below active bin)
- Add `strategy` parameter support to `deploy_position` tool
- For `curve`: distribute liquidity in a bell curve around active bin using Meteora SDK's `StrategyType.Spot` or custom bin distribution

**Changes to `tools/definitions.js`:**
- Update `deploy_position` schema:
```
strategy: {
  type: "string",
  enum: ["bid_ask", "spot", "curve"],
  default: "bid_ask",
  description: "LP strategy shape. bid_ask=two-sided, spot=single-sided SOL, curve=bell-shaped"
}
```

**Changes to `tools/bin-policy.js`:**
- `computeBinsBelow()` already returns bins_below. For Curve, we need both bins_below AND bins_above (symmetric)
- Add `computeCurveRange(volatility)` → returns `{ binsBelow, binsAbove }` where binsAbove = binsBelow

**Changes to `prompt.js`:**
- Add to screener instructions: "Use 'curve' when RSI 40-60 (ranging market) and volatility < 2.0. Use 'bid_ask' for trending. Use 'spot' for bear/accumulation."

**Changes to `config.js`:**
```json
{
  "strategy": {
    "available": ["bid_ask", "spot", "curve"],
    "default": "bid_ask",
    "curveEnabled": false
  }
}
```

### Risks
- **Meteora SDK support:** Need to verify Meteora JS SDK supports non-bid_ask shapes natively. If not, may need to manually distribute across bins.
- **IL complexity:** Curve has higher IL in trending markets → strong regime detection required before auto-deploying curve
- **Testing burden:** 3 strategies × 3 fragility bands = 9 parameter combinations

### Validation
- Manual test: Deploy 1 curve position in known ranging pool, compare vs bid_ask over 24h
- A/B test: Alternate bid_ask/curve on similar pools for 1 week

---

## 5. Feature 4: Event Farming (LGE / New Launch Detection)

### Problem
LP Army has a category called "LGE" (Liquidity Generation Event) — high-APY strategies around token launches. Meridian currently filters OUT very young tokens (<24h) and treats new launches as risky. But early launches have the highest fee/TVL ratios.

### Proposed Solution
Add an `eventFarming` mode that detects LGEs/new launches and deploys with tight ranges + aggressive exits to capture early fee spikes.

### Implementation

**New file:** `tools/event-detector.js`

```
export async function detectLGEs() {
  // Scan GMGN for pools < 2h old with:
  //   - fee/TVL > 0.5 (extremely high)
  //   - volume > $50K in first hour
  //   - top10 < 40% (not a pure bundler rug)
  //   - smart wallets > 5 (some organic interest)
  // Return array of LGE candidates with risk score
}
```

**Changes to `config.js`:**
```json
{
  "eventFarming": {
    "enabled": false,
    "maxDailyEvents": 2,
    "maxDeployPerEvent": 0.25,
    "tightRangeBins": 15,
    "maxHoldMinutes": 30,
    "minFeeTvlRatio": 0.3,
    "exitTriggerPnl": 3.0
  }
}
```

**Changes to `index.js` (screening cycle):**
- Add optional `eventScreening()` call before normal screening
- If LGE detected AND eventFarming enabled:
  - Deploy with 0.25 SOL (half normal size)
  - Set bins_below = 15 (very tight)
  - Set auto_close timer for 30 min max
  - Set trailing TP trigger at +3% (aggressive harvest)
  - Mark position with `isEventPosition: true`

**Changes to `state.js`:**
- Track `eventPositions` separately
- Event positions bypass normal management cycle → managed by dedicated `manageEventPositions()` that runs every 5 min

**Changes to `telegram.js`:**
- Special notification format for event deploys/close
- "🚀 EVENT FARM \n [pool] \n Deployed: 0.25 SOL \n Auto-close in 30 min"

### Risks
- **Extremely high risk:** New launches are where most rugs happen
- **Compute cost:** Checking every 5 min adds RPC load → only enable when wallet > 5 SOL
- **Tax / accounting:** High-frequency short holds may complicate PnL tracking

### Validation
- Start with `enabled: false` → manually test 5 event deploys with 0.1 SOL
- Only enable auto after >60% win rate on manual event farming

---

## 6. Integration & Rollout Plan

### Phase 1: Foundation (Week 1)
1. Implement `tools/market-regime.js` — SOL trend detection
2. Implement `tools/fib-range.js` — Fib calculation skeleton
3. Add config keys to `user-config.json` (all disabled by default)
4. Update `prompt.js` with new strategy guidance

### Phase 2: Bear Mode + Fib (Week 2)
1. Wire bear mode into screening cycle
2. Wire fib ranges into `bin-policy.js`
3. A/B test both features independently
4. Darwin auto-learning for bear mode parameters

### Phase 3: Curve (Week 3-4)
1. Implement Curve shape in `dlmm.js`
2. Test on 3 manual positions
3. Add to available strategies if tests pass
4. Regime-aware auto-selection (bull=bid_ask, range=curve, bear=spot)

### Phase 4: Event Farming (Week 5-6)
1. Implement `event-detector.js`
2. Manual-only mode (Telegram notification + approve button)
3. After 10 manual successes, enable auto mode

### Rollout Rules
- All features default to **disabled**
- Each feature has its own `enabled` flag in config
- Telegram commands to toggle: `/toggle_fib`, `/toggle_bear_mode`, `/toggle_curve`, `/toggle_events`
- Darwin tracks per-feature performance separately

---

## 7. Files to Modify

| File | Changes |
|------|---------|
| `tools/fib-range.js` | **NEW** — Fibonacci bin calculation |
| `tools/market-regime.js` | **NEW** — SOL trend detection |
| `tools/event-detector.js` | **NEW** — LGE/new launch scanner |
| `tools/bin-policy.js` | Integrate fib ranges, add curve symmetry |
| `tools/dlmm.js` | Support curve strategy shape |
| `tools/definitions.js` | Update deploy_position schema |
| `tools/executor.js` | Add new tools to toolMap |
| `config.js` | Add all new config keys |
| `prompt.js` | Update screener strategy guidance |
| `index.js` | Wire regime check, event screening, strategy selection |
| `state.js` | Track event positions separately |
| `telegram.js` | Add toggle commands, event notifications |
| `user-config.json` | Add new feature flags (all false) |

---

## 8. Risks & Tradeoffs

| Risk | Mitigation |
|------|-----------|
| Feature bloat — 4 features adds complexity | All gated by config flags, default off |
| Meteora SDK doesn't support Curve natively | Test first; fallback to manual bin distribution |
| False bear signals causing missed pumps | 3-hour hysteresis before regime switch |
| Event farming rugs | Max 0.25 SOL, 30min hold, manual approval first |
| Fib levels noisy on thin pools | Confidence gate ≥ 0.7 |
| Darwin can't learn per-feature if all change at once | Roll out one feature at a time |

---

## 9. Open Questions for Review

1. **Curve SDK support:** Does Meteora JS SDK natively support bell-shaped position creation, or do we need to manually set per-bin liquidity weights?
2. **SOL price source:** Should we use Jupiter Price API, CoinGecko, or Helius for regime detection? (Jupiter = fastest, CoinGecko = most reliable)
3. **Event farming approval:** Should Phase 1 event farming require Telegram manual approval, or can it auto-deploy with very small size (0.1 SOL)?
4. **Fib vs vol blending:** Should we use the tighter of fib/vol (conservative) or weighted average (balanced)?
5. **Priority:** Which feature delivers most value per effort? (My estimate: Bear Mode ≫ Fib ≫ Curve ≫ Event Farming)

---

## 10. Success Metrics

| Feature | Metric | Target |
|---------|--------|--------|
| Fib Integration | Range efficiency on fib-deployed positions | >90% |
| Bear Mode | Max drawdown during SOL correction | < -10% (vs current -15%) |
| Curve | Peak PnL in ranging markets | > bid_ask in same regime |
| Event Farming | Win rate on event positions | >60% |
| Overall | Maintain 85%+ win rate | No regression |

---

**Ready for architect review. No code changes made yet.**
