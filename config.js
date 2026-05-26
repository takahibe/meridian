import fs from "fs";
import { paths } from "./paths.js";

const USER_CONFIG_PATH = paths.userConfigPath;
const GMGN_CONFIG_PATH = paths.gmgnConfigPath;
const DEFAULT_HIVEMIND_URL = "https://api.agentmeridian.xyz";
const DEFAULT_AGENT_MERIDIAN_API_URL = "https://api.agentmeridian.xyz/api";
const DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY = "bWVyaWRpYW4taXMtdGhlLWJlc3QtYWdlbnRz";
const DEFAULT_HIVEMIND_API_KEY = DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY;

function readJsonIfExists(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : {};
}

const u = readJsonIfExists(USER_CONFIG_PATH);
const gmgnUserConfig = readJsonIfExists(GMGN_CONFIG_PATH);

export const MIN_SAFE_BINS_BELOW = 35;

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
if (u.dryRun !== undefined) process.env.DRY_RUN ||= String(u.dryRun);
if (u.publicApiKey) process.env.PUBLIC_API_KEY ||= u.publicApiKey;
if (u.agentMeridianApiUrl) process.env.AGENT_MERIDIAN_API_URL ||= u.agentMeridianApiUrl;
if (gmgnUserConfig.apiKey || u.gmgnApiKey) {
  process.env.GMGN_API_KEY ||= gmgnUserConfig.apiKey || u.gmgnApiKey;
}

const indicatorUserConfig = u.chartIndicators ?? {};

function nonEmptyString(...values) {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function gmgnValue(key, legacyKey, fallback) {
  return gmgnUserConfig[key] ?? u[legacyKey] ?? fallback;
}

function gmgnArray(key, legacyKey, fallback) {
  if (Array.isArray(gmgnUserConfig[key])) return gmgnUserConfig[key];
  if (Array.isArray(u[legacyKey])) return u[legacyKey];
  return fallback;
}

function toChartInterval(value, fallback = "5_MINUTE") {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase();
  if (["1m", "1_minute", "1minute"].includes(normalized)) return "1_MINUTE";
  if (["5m", "5_minute", "5minute"].includes(normalized)) return "5_MINUTE";
  if (["15m", "15_minute", "15minute"].includes(normalized)) return "15_MINUTE";
  if (["1h", "1_hour", "1hour"].includes(normalized)) return "1H";
  return raw || fallback;
}

const screeningTimeframe = u.screeningTimeframe ?? u.timeframe ?? "1h";
const entryTimeframe = u.entryTimeframe ?? u.entrySignalTimeframe ?? "5m";

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    source:            u.screeningSource    ?? "meteora", // meteora | gmgn | hybrid
    excludeHighSupplyConcentration: u.excludeHighSupplyConcentration ?? true,
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl !== undefined ? u.maxTvl : 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:          u.minOrganic          ?? 60,
    minQuoteOrganic:     u.minQuoteOrganic     ?? 60,
    minTurnoverPct:      u.minTurnoverPct      ?? 20,  // volume/TVL ratio minimum %
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         screeningTimeframe,
    entryTimeframe,
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    useDiscordSignals: u.useDiscordSignals ?? true,
    discordSignalMode: u.discordSignalMode ?? "merge", // merge | only
    avoidPvpSymbols:   u.avoidPvpSymbols   ?? true, // avoid exact-symbol rivals with real active pools
    blockPvpSymbols:   u.blockPvpSymbols   ?? true, // hard-filter PVP rivals before the LLM sees them
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 40,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration
    allowedLaunchpads: u.allowedLaunchpads ?? [],  // allow-list launchpads, [] = no allow-list
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? 2, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? 240, // null = no maximum
    athFilterPct:        u.athFilterPct        ?? -10,
    maxPumpPct5m:        u.maxPumpPct5m        ?? 15,   // reject if 5m pump > this %
    maxDumpPct5m:        u.maxDumpPct5m        ?? 20,   // reject if 5m dump > this % (falling knife)
    maxVolatility:      u.maxVolatility      ?? 5.0,  // evolved by lessons system
    minVolatility:    u.minVolatility    ?? 1.0,   // hard floor — below this, fees are too thin
    maxVolatilityHard: u.maxVolatilityHard ?? 3.5,   // hard ceiling — distinct from soft maxVolatility
    rejectNullVolatility: u.rejectNullVolatility ?? true,  // block GMGN candidates lacking poolDetail.volatility
    screenerFunnelEnabled: u.screenerFunnelEnabled ?? true,
    xNarrativeMinConfidence: u.xNarrativeMinConfidence ?? "moderate",
    xNarrativeFailOpenOnUnavailable: u.xNarrativeFailOpenOnUnavailable ?? true,
    xApiCacheMinutes: u.xApiCacheMinutes ?? 5,
    xApiTimeoutMs: u.xApiTimeoutMs ?? 4000,
    xApiMaxResults: u.xApiMaxResults ?? 10,
    xNarrativeFreshHours: u.xNarrativeFreshHours ?? 24,
    minPoolTvl: u.minPoolTvl ?? 15000,
    minPoolOpenPositions: u.minPoolOpenPositions ?? 1,
  },

  gmgn: {
    apiKey: nonEmptyString(gmgnUserConfig.apiKey, u.gmgnApiKey, process.env.GMGN_API_KEY),
    baseUrl: nonEmptyString(gmgnUserConfig.baseUrl, u.gmgnBaseUrl, "https://openapi.gmgn.ai"),
    interval: gmgnUserConfig.interval ?? u.gmgnInterval ?? screeningTimeframe,
    poolDetailTimeframe: gmgnUserConfig.poolDetailTimeframe ?? u.gmgnPoolDetailTimeframe ?? screeningTimeframe,
    entryTimeframe: gmgnUserConfig.entryTimeframe ?? u.gmgnEntryTimeframe ?? entryTimeframe,
    orderBy: gmgnValue("orderBy", "gmgnOrderBy", "default"),
    direction: gmgnValue("direction", "gmgnDirection", "desc"),
    limit: gmgnValue("limit", "gmgnLimit", 100),
    enrichLimit: gmgnValue("enrichLimit", "gmgnEnrichLimit", 20),
    requestDelayMs: gmgnValue("requestDelayMs", "gmgnRequestDelayMs", 800),
    maxRetries: gmgnValue("maxRetries", "gmgnMaxRetries", 2),
    banCooldownMinutes: gmgnValue("banCooldownMinutes", "gmgnBanCooldownMinutes", 240),
    holdersLimit: gmgnValue("holdersLimit", "gmgnHoldersLimit", 100),
    klineResolution: gmgnValue("klineResolution", "gmgnKlineResolution", "5m"),
    klineLookbackMinutes: gmgnValue("klineLookbackMinutes", "gmgnKlineLookbackMinutes", 60),
    filters: gmgnArray("filters", "gmgnFilters", ["renounced", "frozen", "not_wash_trading"]),
    platforms: gmgnArray("platforms", "gmgnPlatforms", ["Pump.fun", "meteora_virtual_curve", "pool_meteora"]),
    minMcap: gmgnValue("minMcap", "gmgnMinMcap", u.minMcap ?? 150_000),
    maxMcap: gmgnValue("maxMcap", "gmgnMaxMcap", u.maxMcap ?? 10_000_000),
    minTvl: gmgnValue("minTvl", "gmgnMinTvl", u.minTvl ?? 10_000),
    minVolume: gmgnValue("minVolume", "gmgnMinVolume", 1000),
    minHolders: gmgnValue("minHolders", "gmgnMinHolders", u.minHolders ?? 500),
    minTokenAgeHours: gmgnValue("minTokenAgeHours", "gmgnMinTokenAgeHours", u.minTokenAgeHours ?? 2),
    maxTokenAgeHours: gmgnValue("maxTokenAgeHours", "gmgnMaxTokenAgeHours", 24 * 7),
    minSmartDegenCount: gmgnValue("minSmartDegenCount", "gmgnMinSmartDegenCount", 1),
    requireKol: gmgnValue("requireKol", "gmgnRequireKol", true),
    minKolCount: gmgnValue("minKolCount", "gmgnMinKolCount", 1),
    maxRugRatio: gmgnValue("maxRugRatio", "gmgnMaxRugRatio", 0.3),
    maxTop10HolderRate: gmgnValue("maxTop10HolderRate", "gmgnMaxTop10HolderRate", 0.5),
    maxBundlerRate: gmgnValue("maxBundlerRate", "gmgnMaxBundlerRate", 0.5),
    maxRatTraderRate: gmgnValue("maxRatTraderRate", "gmgnMaxRatTraderRate", 0.2),
    maxFreshWalletRate: gmgnValue("maxFreshWalletRate", "gmgnMaxFreshWalletRate", 0.2),
    maxDevTeamHoldRate: gmgnValue("maxDevTeamHoldRate", "gmgnMaxDevTeamHoldRate", 0.02),
    preferredKolMinHoldPct: gmgnValue("preferredKolMinHoldPct", "gmgnPreferredKolMinHoldPct", 1),
    dumpKolMinHoldPct: gmgnValue("dumpKolMinHoldPct", "gmgnDumpKolMinHoldPct", 0.5),
    maxBotDegenRate: gmgnValue("maxBotDegenRate", "gmgnMaxBotDegenRate", 0.4),
    maxSniperCount: gmgnValue("maxSniperCount", "gmgnMaxSniperCount", 20),
    maxSniperHoldRate: gmgnValue("maxSniperHoldRate", "gmgnMaxSniperHoldRate", 0.3),
    minTotalFeeSol: gmgnValue("minTotalFeeSol", "gmgnMinTotalFeeSol", 30),
    athFilterPct: gmgnValue("athFilterPct", "gmgnAthFilterPct", null),
    preferredKolNames: gmgnArray("preferredKolNames", "gmgnPreferredKolNames", []),
    dumpKolNames: gmgnArray("dumpKolNames", "gmgnDumpKolNames", []),
    indicatorFilter: gmgnValue("indicatorFilter", "gmgnIndicatorFilter", true),
    indicatorInterval: gmgnUserConfig.indicatorInterval ?? u.gmgnIndicatorInterval ?? toChartInterval(entryTimeframe),
    indicatorRules: (() => {
      const r = gmgnUserConfig.indicatorRules || {};
      return {
        requireBullishSupertrend: r.requireBullishSupertrend ?? true,
        rejectAlreadyAtBottom:    r.rejectAlreadyAtBottom    ?? true,
        requireAboveSupertrend:   r.requireAboveSupertrend   ?? false,
        minRsi:                   r.minRsi                   ?? null,
        maxRsi:                   r.maxRsi                   ?? null,
        requireBbPosition:        r.requireBbPosition        ?? null,
      };
    })(),
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? true,
    closeSlippageBps:      u.closeSlippageBps      ?? 500,   // relay zap-out slippage tolerance (500 = 5%)
    autoSwapSlippageBps:   u.autoSwapSlippageBps   ?? 1500,  // post-close base→SOL slippage (1500 = 15%, wide to preserve SOL during dumps)
    autoSwapRetries:       u.autoSwapRetries       ?? 3,     // retry attempts on auto-swap failure
    emergencyStopLossPct:  u.emergencyStopLossPct  ?? -15,   // pnl_pct threshold for bypass-LLM emergency close
    emergencyCloseSlippageBps: u.emergencyCloseSlippageBps ?? 1500, // wider relay slippage for emergency close
    emergencyPriceDropPct5m: u.emergencyPriceDropPct5m ?? -25, // price drop in last ~5min (snapshots) that triggers emergency
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    outOfRangeWaitMinutesUpper: u.outOfRangeWaitMinutesUpper ?? u.outOfRangeWaitMinutes ?? 30,
    outOfRangeWaitMinutesLower: u.outOfRangeWaitMinutesLower ?? u.outOfRangeWaitMinutes ?? 30,
    // Per-strategy stop-loss + grace windows (Layer B fix for bid_ask drawdown sensitivity)
    stopLossPctBidAsk:        u.stopLossPctBidAsk        ?? -15,  // bid_ask SL — wider, drawdown is expected during fill
    bidAskFillMinutes:        u.bidAskFillMinutes        ?? 60,   // skip OOR-below close for bid_ask within this window after deploy
    manualGracePeriodMinutes: u.manualGracePeriodMinutes ?? 60,   // skip Rules 1-5 for manual deploys within this window (Rule 0 still fires)
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    upperOorReentryCooldownMinutes: u.upperOorReentryCooldownMinutes ?? 60, // single upper-OOR close → short token cooldown to block pump-chase re-entry
    repeatDeployCooldownEnabled: u.repeatDeployCooldownEnabled ?? true,
    repeatDeployCooldownTriggerCount: u.repeatDeployCooldownTriggerCount ?? 3,
    repeatDeployCooldownHours: u.repeatDeployCooldownHours ?? 12,
    repeatDeployCooldownScope: u.repeatDeployCooldownScope ?? "token", // pool | token | both
    repeatDeployCooldownMinFeeEarnedPct: u.repeatDeployCooldownMinFeeEarnedPct ?? u.repeatDeployCooldownMinFeeYieldPct ?? 0,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -50,
    takeProfitPct:         u.takeProfitPct         ?? u.takeProfitFeePct ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 60, // minutes before low yield can trigger close
    // Fee-decay: band-aware thresholds for earlier, smarter fragility closes
    feeDecayWarnPct:              u.feeDecayWarnPct              ?? 35,
    feeDecayClosePctBandA:        u.feeDecayClosePctBandA        ?? 65,
    feeDecayClosePctBandB:        u.feeDecayClosePctBandB        ?? 50,
    feeDecayClosePctBandC:        u.feeDecayClosePctBandC        ?? 45,
    feeDecayImmediatePct:         u.feeDecayImmediatePct         ?? 70,
    feeDecayMinAgeMinutes:        u.feeDecayMinAgeMinutes        ?? 45,
    feeDecayMinAgeMinutesBandA:   u.feeDecayMinAgeMinutesBandA   ?? 60,
    feeDecayMinAgeMinutesBandB:   u.feeDecayMinAgeMinutesBandB   ?? 45,
    feeDecayMinAgeMinutesBandC:   u.feeDecayMinAgeMinutesBandC   ?? 30,
    feeDecayStagnantFeeGrowthUsd: u.feeDecayStagnantFeeGrowthUsd ?? 0.10,
    // Lower-dump velocity guard: catch RoyalPop-style fast drops before SL
    lowerDumpVelocityEnabled:      u.lowerDumpVelocityEnabled      ?? true,
    lowerDumpBinVelocityClose:     u.lowerDumpBinVelocityClose     ?? 20,
    lowerDumpBinVelocityEmergency: u.lowerDumpBinVelocityEmergency ?? 30,
    lowerDumpPnlClosePct:          u.lowerDumpPnlClosePct          ?? -5,
    lowerDumpLookbackSnapshots:    u.lowerDumpLookbackSnapshots    ?? 3,
    // Upper-OOR fee-aware extension (Phase 2)
    upperOorFeeAwareEnabled:      u.upperOorFeeAwareEnabled      ?? true,
    upperOorFeeGrowthMinUsd:      u.upperOorFeeGrowthMinUsd      ?? 0.10,
    upperOorFeeExtendMinutes:     u.upperOorFeeExtendMinutes     ?? 5,
    upperOorFeeMaxExtensions:     u.upperOorFeeMaxExtensions     ?? 1,
    tokenCooldownAfterLosses: u.tokenCooldownAfterLosses ?? 3,  // cross-pool losses before global token cooldown
    tokenGlobalCooldownHours: u.tokenGlobalCooldownHours ?? 24, // hours for global token cooldown
    // Spot-add strategy: add a spot position to confirmed bid_ask pools
    spotAddEnabled:            u.spotAddEnabled            ?? true,
    spotAddMinAgeMinutes:      u.spotAddMinAgeMinutes      ?? 15,   // min age before spot add is considered
    spotAddFeeSpikeMultiplier: u.spotAddFeeSpikeMultiplier ?? 2.0,  // fee/TVL must be Nx deploy-time value
    spotAddSizePct:            u.spotAddSizePct            ?? 0.5,  // fraction of original deploy amount
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    deployAmountSolMin:    u.deployAmountSolMin    ?? 0.35,  // weak SOL floor
    deployAmountSolMax:    u.deployAmountSolMax    ?? 0.75,  // strong SOL ceil
    bandDeployEnabled:     u.bandDeployEnabled     ?? false,
    bandBSizeMultiplier:   u.bandBSizeMultiplier   ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    // Bid/ask bounce profit-lock: if price filled near the lower edge, then
    // rebounds back through mid-range while PnL is green, harvest before a
    // roundtrip. This approximates "lower BB -> middle BB with RSI>50" using
    // DLMM bin structure; indicator confirmation can be layered later.
    lowerBounceProfitLockEnabled: u.lowerBounceProfitLockEnabled ?? true,
    lowerBounceTouchPct: u.lowerBounceTouchPct ?? 0.15,       // lower 15% of range = touched bottom
    lowerBounceReboundPct: u.lowerBounceReboundPct ?? 0.50,   // middle of range = bounce confirmed
    lowerBounceMinPnlPct: u.lowerBounceMinPnlPct ?? 2.5,      // don't scalp dust; lock real green
    managementBands: {
      bandA: {
        maxVolatility: 1.8,
        trailingTriggerPct: u.managementBandATrailingTriggerPct ?? 4.0,
        trailingDropPct: u.managementBandATrailingDropPct ?? 1.75,
        upperOorWaitMinutes: u.managementBandAUpperOorWaitMinutes ?? 9,
        lowerOorWaitMinutes: u.managementBandALowerOorWaitMinutes ?? 45,
        pumpedHarvestMinPnlPct: u.managementBandAPumpedHarvestMinPnlPct ?? 2.0,
      },
      bandB: {
        maxVolatility: 3.0,
        trailingTriggerPct: u.managementBandBTrailingTriggerPct ?? 2.5,
        trailingDropPct: u.managementBandBTrailingDropPct ?? 1.25,
        upperOorWaitMinutes: u.managementBandBUpperOorWaitMinutes ?? 5,
        lowerOorWaitMinutes: u.managementBandBLowerOorWaitMinutes ?? 30,
        pumpedHarvestMinPnlPct: u.managementBandBPumpedHarvestMinPnlPct ?? 1.5,
      },
      bandC: {
        trailingTriggerPct: u.managementBandCTrailingTriggerPct ?? 1.75,
        trailingDropPct: u.managementBandCTrailingDropPct ?? 0.85,
        upperOorWaitMinutes: u.managementBandCUpperOorWaitMinutes ?? 2,
        lowerOorWaitMinutes: u.managementBandCLowerOorWaitMinutes ?? 15,
        pumpedHarvestMinPnlPct: u.managementBandCPumpedHarvestMinPnlPct ?? 1.0,
      },
      fallback: u.managementBandFallback ?? "B",
    },
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    strategy:       u.strategy       ?? "bid_ask",
    minBinsBelow:   u.minBinsBelow   ?? 35,
    maxBinsBelow:   u.maxBinsBelow   ?? 69,
    defaultBinsBelow: u.defaultBinsBelow ?? 35,
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 2,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "openrouter/hunter-alpha",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "openrouter/healer-alpha",
  },

  // ─── Darwinian Signal Weighting ───────
  darwin: {
    enabled:        u.darwinEnabled     ?? true,
    windowDays:     u.darwinWindowDays  ?? 60,
    recalcEvery:    u.darwinRecalcEvery ?? 5,    // recalc every N closes
    boostFactor:    u.darwinBoost       ?? 1.05,
    decayFactor:    u.darwinDecay       ?? 0.95,
    weightFloor:    u.darwinFloor       ?? 0.3,
    weightCeiling:  u.darwinCeiling     ?? 2.5,
    minSamples:     u.darwinMinSamples  ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },

  // ─── HiveMind ─────────────────────────
  hiveMind: {
    url: nonEmptyString(u.hiveMindUrl, DEFAULT_HIVEMIND_URL),
    apiKey: nonEmptyString(u.hiveMindApiKey, process.env.HIVEMIND_API_KEY, DEFAULT_HIVEMIND_API_KEY),
    agentId: u.agentId ?? null,
    pullMode: u.hiveMindPullMode ?? "auto",
  },

  api: {
    url: nonEmptyString(u.agentMeridianApiUrl, process.env.AGENT_MERIDIAN_API_URL, DEFAULT_AGENT_MERIDIAN_API_URL),
    publicApiKey: nonEmptyString(u.publicApiKey, process.env.PUBLIC_API_KEY, DEFAULT_AGENT_MERIDIAN_PUBLIC_KEY),
    lpAgentRelayEnabled: u.lpAgentRelayEnabled ?? false,
  },

  // ─── HiveMind Publish Mode ────────────────
  // "production" = normal publish; "experimental" = tag with profile+runId; "off" = no publish
  hiveMindPublishMode: u.hiveMindPublishMode
    ?? (process.env.MERIDIAN_PROFILE === "autoresearch" ? "off" : "production"),

  // ─── Autoresearch ─────────────────────────
  autoresearch: {
    enabled:             u.autoresearch?.enabled             ?? false,
    runId:               process.env.MERIDIAN_RESEARCH_RUN_ID ?? u.autoresearch?.runId ?? null,
    capitalBudgetPct:    u.autoresearch?.capitalBudgetPct    ?? 0.02,
    maxWalletSol:        u.autoresearch?.maxWalletSol        ?? null,
    dailyLossLimitSol:   u.autoresearch?.dailyLossLimitSol   ?? null,
    promptNotes:         u.autoresearch?.promptNotes         ?? null,
    candidateConfigPath: u.autoresearch?.candidateConfigPath ?? null,
    dataCollectorEnabled: u.autoresearch?.dataCollectorEnabled ?? true,
    shadowLabelsEnabled:  u.autoresearch?.shadowLabelsEnabled  ?? true,
    factorVariables: Array.isArray(u.autoresearch?.factorVariables)
      ? u.autoresearch.factorVariables
      : [
          "fee_active_tvl_ratio",
          "turnover_pct",
          "volatility",
          "fragility_score",
          "price_vs_ath_pct",
          "recent_pnl_drift_pct",
          "recent_active_bin_drift",
          "recent_oor_count",
          "top_cluster_trend",
          "bot_holders_pct",
          "smart_wallet_count",
          "lpagent_confidence",
        ],
  },

  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? "",
    referralAccount:
      process.env.JUPITER_REFERRAL_ACCOUNT ??
      "9MzhDUnq3KxecyPzvhguQMMPbooXQ3VAoCMPDnoijwey",
    referralFeeBps: Number(
      process.env.JUPITER_REFERRAL_FEE_BPS ?? 50,
    ),
  },

  indicators: {
    enabled: indicatorUserConfig.enabled ?? false,
    entryPreset: indicatorUserConfig.entryPreset ?? "supertrend_break",
    exitPreset: indicatorUserConfig.exitPreset ?? "supertrend_break",
    rsiLength: indicatorUserConfig.rsiLength ?? 2,
    intervals: Array.isArray(indicatorUserConfig.intervals)
      ? indicatorUserConfig.intervals
      : ["5_MINUTE"],
    candles: indicatorUserConfig.candles ?? 298,
    rsiOversold: indicatorUserConfig.rsiOversold ?? 30,
    rsiOverbought: indicatorUserConfig.rsiOverbought ?? 80,
    requireAllIntervals: indicatorUserConfig.requireAllIntervals ?? false,
  },

  // ─── Execution (Layer 5) ─────────────────────────
  execution: {
    priorityFeeFloor: u.priorityFeeFloor ?? 100,        // min μL/CU (100 ≈ 0.0001 SOL per 1M CU)
    priorityFeeCap:   u.priorityFeeCap ?? 100_000,      // max μL/CU (hard cap to prevent runaway fees)
    cuLimits: {
      deploy: u.cuLimitDeploy ?? 1_400_000,
      close:  u.cuLimitClose ?? 800_000,
      claim:  u.cuLimitClaim ?? 400_000,
      swap:   u.cuLimitSwap ?? 400_000,
    },
  },
};

if (config.screening.screenerFunnelEnabled && !process.env.X_BEARER_TOKEN) {
  const xMode = config.screening.xNarrativeFailOpenOnUnavailable !== false
    ? "fail-open is enabled; X will be marked unavailable and later pool-quality gates still apply"
    : "fail-open is disabled; X narrative gating may reject candidates";
  console.warn(`[config] screenerFunnelEnabled=true but X_BEARER_TOKEN is unset — ${xMode}.`);
}

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding) AND SOL market trend.
 *
 * SOL trend scaling (7d price change):
 *   Weak  (< -10%): floor = deployAmountSolMin (0.35), ceil = deployAmountSol
 *   Neutral:         floor = deployAmountSol (0.50),  ceil = deployAmountSol
 *   Strong (> +15%): floor = deployAmountSol (0.50),  ceil = deployAmountSolMax (0.75)
 *
 * Formula: clamp(deployable × positionSizePct, floor, ceil)
 *
 * @param {number} walletSol — current SOL balance
 * @param {number|null} solTrendPct — 7d SOL price change % (null = neutral)
 */
export function computeDeployAmount(walletSol, solTrendPct = null) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const baseFloor = config.management.deployAmountSol;      // 0.50 (neutral)
  const minFloor  = config.management.deployAmountSolMin;   // 0.35 (weak SOL)
  const maxCeil   = config.management.deployAmountSolMax;   // 0.75 (strong SOL)
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;

  // Determine floor and ceil based on SOL trend
  let floor = baseFloor;
  let ceil  = baseFloor; // default: fixed at base (neutral)

  if (solTrendPct != null && minFloor != null && solTrendPct < -10) {
    // SOL is weak — lower the floor to keep smaller positions active
    floor = minFloor;
    ceil  = baseFloor;
  } else if (solTrendPct != null && maxCeil != null && solTrendPct > 15) {
    // SOL is strong — allow scaling up
    floor = baseFloor;
    ceil  = maxCeil;
  }

  const result = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  try {
    const fresh = readJsonIfExists(USER_CONFIG_PATH);
    const s = config.screening;
    if (fresh.screeningSource != null) s.source = fresh.screeningSource;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.useDiscordSignals !== undefined) s.useDiscordSignals = fresh.useDiscordSignals;
    if (fresh.discordSignalMode != null) s.discordSignalMode = fresh.discordSignalMode;
    if (fresh.excludeHighSupplyConcentration !== undefined) s.excludeHighSupplyConcentration = fresh.excludeHighSupplyConcentration;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minQuoteOrganic != null) s.minQuoteOrganic = fresh.minQuoteOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         !== undefined) s.maxTvl   = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.screeningTimeframe != null) s.timeframe = fresh.screeningTimeframe;
    else if (fresh.timeframe != null) s.timeframe = fresh.timeframe;
    if (fresh.entryTimeframe != null) s.entryTimeframe = fresh.entryTimeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.maxVolatility     != null) s.maxVolatility     = fresh.maxVolatility;
    if (fresh.minVolatility    != null) s.minVolatility    = fresh.minVolatility;
    if (fresh.maxVolatilityHard!= null) s.maxVolatilityHard= fresh.maxVolatilityHard;
    if (fresh.rejectNullVolatility !== undefined) s.rejectNullVolatility = fresh.rejectNullVolatility;
    if (fresh.screenerFunnelEnabled !== undefined) s.screenerFunnelEnabled = fresh.screenerFunnelEnabled;
    if (fresh.xNarrativeMinConfidence != null) s.xNarrativeMinConfidence = fresh.xNarrativeMinConfidence;
    if (fresh.xNarrativeFailOpenOnUnavailable !== undefined) s.xNarrativeFailOpenOnUnavailable = fresh.xNarrativeFailOpenOnUnavailable;
    if (fresh.xApiCacheMinutes != null) s.xApiCacheMinutes = fresh.xApiCacheMinutes;
    if (fresh.xApiTimeoutMs != null) s.xApiTimeoutMs = fresh.xApiTimeoutMs;
    if (fresh.xApiMaxResults != null) s.xApiMaxResults = fresh.xApiMaxResults;
    if (fresh.xNarrativeFreshHours != null) s.xNarrativeFreshHours = fresh.xNarrativeFreshHours;
    if (fresh.minPoolTvl != null) s.minPoolTvl = fresh.minPoolTvl;
    if (fresh.minPoolOpenPositions != null) s.minPoolOpenPositions = fresh.minPoolOpenPositions;
    if (fresh.maxBundlePct      != null) s.maxBundlePct     = fresh.maxBundlePct;
    if (fresh.avoidPvpSymbols   !== undefined) s.avoidPvpSymbols = fresh.avoidPvpSymbols;
    if (fresh.blockPvpSymbols   !== undefined) s.blockPvpSymbols = fresh.blockPvpSymbols;
    if (fresh.maxBotHoldersPct  != null) s.maxBotHoldersPct = fresh.maxBotHoldersPct;
    if (fresh.allowedLaunchpads !== undefined) s.allowedLaunchpads = fresh.allowedLaunchpads;
    if (fresh.blockedLaunchpads !== undefined) s.blockedLaunchpads = fresh.blockedLaunchpads;
    const m = config.management;
    if (fresh.bandDeployEnabled !== undefined) m.bandDeployEnabled = fresh.bandDeployEnabled;
    if (fresh.bandBSizeMultiplier != null) m.bandBSizeMultiplier = fresh.bandBSizeMultiplier;
  } catch { /* ignore */ }
  try {
    const freshGmgn = readJsonIfExists(GMGN_CONFIG_PATH);
    const g = config.gmgn;
    for (const [key, value] of Object.entries(freshGmgn)) {
      if (key in g && key !== "apiKey") g[key] = value;
    }
    if (freshGmgn.apiKey) g.apiKey = freshGmgn.apiKey;
  } catch { /* ignore */ }
}
