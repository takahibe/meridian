// management-rules.js — deterministic close-rule helpers
// Called by both state.js (updatePnlAndCheckExits) and index.js (getDeterministicCloseRule)

/**
 * Band-aware fee-decay close rule.
 * Returns { action, reason, ... } or null.
 */
export function computeFeeDecayClose({
  managementBand,
  mgmtConfig,
  ageMinutes,
  deployFeeTvl,
  currentFeeTvl,
  snapshots,
  inManualGrace,
}) {
  if (inManualGrace) return null;

  const bandKey = managementBand || "B";
  const feeDecayMinAge = bandKey === "A"
    ? (mgmtConfig.feeDecayMinAgeMinutesBandA ?? mgmtConfig.feeDecayMinAgeMinutes ?? 60)
    : bandKey === "C"
    ? (mgmtConfig.feeDecayMinAgeMinutesBandC ?? mgmtConfig.feeDecayMinAgeMinutes ?? 30)
    : (mgmtConfig.feeDecayMinAgeMinutesBandB ?? mgmtConfig.feeDecayMinAgeMinutes ?? 45);

  if ((ageMinutes ?? 0) < feeDecayMinAge) return null;
  if (deployFeeTvl == null || deployFeeTvl <= 0 || currentFeeTvl == null) {
    return { action: null, skip: true, reason: "deploy fee/TVL missing" };
  }

  const decayPct = ((deployFeeTvl - currentFeeTvl) / deployFeeTvl) * 100;
  const immediatePct = mgmtConfig.feeDecayImmediatePct ?? 70;

  // Immediate close on severe decay regardless of fee growth
  if (decayPct >= immediatePct) {
    return {
      action: "FEE_DECAY",
      reason: `Fee-decay immediate (Band ${bandKey}): decay ${decayPct.toFixed(0)}% >= ${immediatePct}% (deploy: ${deployFeeTvl.toFixed(2)}% → current: ${currentFeeTvl.toFixed(2)}%)`,
    };
  }

  const feeDecayClosePct = bandKey === "A"
    ? (mgmtConfig.feeDecayClosePctBandA ?? 65)
    : bandKey === "C"
    ? (mgmtConfig.feeDecayClosePctBandC ?? 45)
    : (mgmtConfig.feeDecayClosePctBandB ?? 50);

  if (decayPct >= feeDecayClosePct) {
    // Confirm with fee growth: suppress close if fees are still growing
    const stagnationThreshold = mgmtConfig.feeDecayStagnantFeeGrowthUsd ?? 0.10;
    const snaps = snapshots || [];
    const feesStagnant = snaps.length < 3 || (() => {
      const recent = snaps.slice(-3);
      const feeGrowth = (recent[recent.length - 1].unclaimed_fees_usd ?? 0) - (recent[0].unclaimed_fees_usd ?? 0);
      return feeGrowth < stagnationThreshold;
    })();
    if (feesStagnant) {
      return {
        action: "FEE_DECAY",
        reason: `Fee-decay fragility (Band ${bandKey}): decay ${decayPct.toFixed(0)}% >= ${feeDecayClosePct}%, fees stagnant (deploy: ${deployFeeTvl.toFixed(2)}% → current: ${currentFeeTvl.toFixed(2)}%)`,
      };
    }
  }

  return null;
}

/**
 * Lower-dump velocity guard — detects rapid downward bin movement.
 * Returns { action, reason, emergency? } or null.
 */
export function computeLowerDumpVelocityClose({
  strategy,
  managementBand,
  mgmtConfig,
  activeBin,
  lowerBin,
  oorDirection,
  currentPnlPct,
  snapshots,
}) {
  if (mgmtConfig.lowerDumpVelocityEnabled === false) return null;
  if (strategy !== "bid_ask") return null;
  if (oorDirection !== "lower") return null;
  if (!Number.isFinite(activeBin) || !Number.isFinite(lowerBin) || activeBin >= lowerBin) return null;

  const lookbackSnaps = mgmtConfig.lowerDumpLookbackSnapshots ?? 3;
  // Use last-N snapshots — simple, robust, no age_minutes filtering
  const posSnaps = (snapshots || []).slice(-lookbackSnaps);

  if (posSnaps.length < 2) return null;

  const oldestBin = Number(posSnaps[0].active_bin);
  const newestBin = Number(posSnaps[posSnaps.length - 1].active_bin);
  if (!Number.isFinite(oldestBin) || !Number.isFinite(newestBin)) return null;

  const binDrop = oldestBin - newestBin; // positive = price moved down
  const emergencyThreshold = mgmtConfig.lowerDumpBinVelocityEmergency ?? 30;
  const closeThreshold = mgmtConfig.lowerDumpBinVelocityClose ?? 20;
  const pnlClosePct = mgmtConfig.lowerDumpPnlClosePct ?? -5;

  if (binDrop >= emergencyThreshold) {
    return {
      action: "EMERGENCY_CLOSE",
      reason: `Lower dump emergency (Band ${managementBand}): active_bin dropped ${binDrop} bins in ${posSnaps.length} snapshots (threshold: ${emergencyThreshold})`,
      emergency: true,
    };
  }
  if (binDrop >= closeThreshold && currentPnlPct != null && currentPnlPct <= pnlClosePct) {
    return {
      action: "LOWER_DUMP_VELOCITY",
      reason: `Lower dump velocity (Band ${managementBand}): active_bin dropped ${binDrop} bins with PnL ${currentPnlPct.toFixed(2)}% <= ${pnlClosePct}%`,
    };
  }

  return null;
}

/**
 * Fee-aware upper-OOR extension — grants extra wait time if fees are still growing.
 * Returns { waitLimit, extended, extensionCount?, feeGrowth?, reason? }.
 */
export function computeUpperOorFeeExtension({
  managementBand,
  mgmtConfig,
  currentPnlPct,
  minutesOOR,
  waitLimit,
  snapshots,
  extensionsUsed,
}) {
  if (mgmtConfig.upperOorFeeAwareEnabled === false) return { waitLimit, extended: false };
  if (currentPnlPct == null || currentPnlPct < 0) return { waitLimit, extended: false };
  if (minutesOOR < waitLimit) return { waitLimit, extended: false };

  const maxExtensions = mgmtConfig.upperOorFeeMaxExtensions ?? 1;
  if (extensionsUsed >= maxExtensions) return { waitLimit, extended: false };

  const feeGrowthMin = mgmtConfig.upperOorFeeGrowthMinUsd ?? 0.10;
  const extendMin = mgmtConfig.upperOorFeeExtendMinutes ?? 5;

  // Check recent fee growth from snapshots
  const oorSnaps = (snapshots || []).slice(-3);
  const feeGrowth = oorSnaps.length >= 2
    ? (oorSnaps[oorSnaps.length - 1].unclaimed_fees_usd ?? 0) - (oorSnaps[0].unclaimed_fees_usd ?? 0)
    : 0;

  if (feeGrowth >= feeGrowthMin) {
    return {
      waitLimit: waitLimit + extendMin,
      extended: true,
      extensionCount: extensionsUsed + 1,
      feeGrowth,
      reason: `Upper-OOR fee extension ${extensionsUsed + 1}/${maxExtensions}: +${extendMin}m (fee growth $${feeGrowth.toFixed(2)} >= $${feeGrowthMin})`,
    };
  }

  return { waitLimit, extended: false };
}
