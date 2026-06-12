// Inner runner for the pct-guard tests in deploy-metrics.test.js — must run under
// node --experimental-test-module-mocks (mock.module is flag-gated in Node 22).
// Mocks the Meteora SDK + every file-writing module the deploy path touches so
// deployPosition (dry-run) and executeTool's safety checks run with zero
// network/chain access, then reports what each guard did.
import { mock } from "node:test";

process.env.DRY_RUN = "true";
process.env.RPC_URL = process.env.RPC_URL || "http://127.0.0.1:1";

const local = (p) => new URL(p, import.meta.url).href;

// Fake bin math: price(bin) = (1 + binStep/10000)^bin — same shape as the SDK,
// so downside_pct=1 on binStep=100 converts to ~1-2 bins below (the bypass case).
const binBase = (binStep) => 1 + binStep / 10000;
const fakePool = {
  lbPair: {
    tokenXMint: { toString: () => "FakeBaseMint1111111111111111111111111111111" },
    binStep: 100,
    parameters: { baseFactor: 0 },
  },
  getActiveBin: async () => ({ binId: 1000 }),
};
class FakeDLMM {
  static async create() { return fakePool; }
  static getBinIdFromPrice(price, binStep, min) {
    const id = Math.log(price) / Math.log(binBase(binStep));
    return min ? Math.floor(id) : Math.ceil(id);
  }
}
mock.module("@meteora-ag/dlmm", {
  defaultExport: FakeDLMM,
  namedExports: {
    StrategyType: { Spot: 0, Curve: 1, BidAsk: 2 },
    getPriceOfBinByBinId: (binId, binStep) => ({ toString: () => String(binBase(binStep) ** binId) }),
  },
});
mock.module(local("../logger.js"), { namedExports: { log: () => {}, logAction: () => {} } });
mock.module(local("../telegram.js"), {
  namedExports: { notifyDeploy: async () => {}, notifyClose: async () => {}, notifySwap: async () => {} },
});
mock.module(local("../data-collector.js"), {
  namedExports: { recordDeployObservation: () => {}, recordShadowLabel: () => {} },
});
mock.module(local("../signal-tracker.js"), { namedExports: { getAndClearStagedSignals: () => null, peekStagedSignals: () => null, peekSelectedPool: () => null } });
mock.module(local("../decision-log.js"), {
  namedExports: { appendDecision: () => {}, getRecentDecisions: () => [] },
});
mock.module(local("../pool-memory.js"), {
  namedExports: {
    getPoolMemory: () => ({}),
    addPoolNote: async () => {},
    isBaseMintOnCooldown: () => false,
    isPoolOnCooldown: () => false,
    recallForPool: () => null,
    isTokenOnGlobalCooldown: () => false,
    getTokenLossCount: () => 0,
  },
});

const { MIN_SAFE_BINS_BELOW, config } = await import(local("../config.js"));
const { deployPosition } = await import(local("../tools/dlmm.js"));
const { executeTool } = await import(local("../tools/executor.js"));

// 1) dlmm.js floor: downside_pct=1 converts to ~1-2 bins — the floor must re-apply
const dryRun = await deployPosition({
  pool_address: "So11111111111111111111111111111111111111112",
  strategy: "bid_ask",
  amount_sol: 0.5,
  downside_pct: 1,
});

// 2) executor.js gate: auto deploys must reject pct-range args outright
const autoDownside = await executeTool("deploy_position", {
  pool_address: "poolA", amount_sol: 0.5, bin_step: config.screening.minBinStep, downside_pct: 10, deploy_source: "auto",
});
const autoUpside = await executeTool("deploy_position", {
  pool_address: "poolA", amount_sol: 0.5, bin_step: config.screening.minBinStep, upside_pct: 10,
});

// 3) manual escape hatch: pct args pass the gate and reach the NEXT check
// (out-of-range bin_step), proving manual deploys are not pct-blocked.
const manualDownside = await executeTool("deploy_position", {
  pool_address: "poolA", amount_sol: 0.5, bin_step: config.screening.maxBinStep + 1, downside_pct: 10, deploy_source: "manual",
});

// Machine-readable summary for the outer test (last stdout line)
console.log(JSON.stringify({
  minSafeBinsBelow: MIN_SAFE_BINS_BELOW,
  dryRunBinsBelow: dryRun?.would_deploy?.bins_below ?? null,
  autoDownsideReason: autoDownside?.blocked ? autoDownside.reason : null,
  autoUpsideReason: autoUpside?.blocked ? autoUpside.reason : null,
  manualDownsideReason: manualDownside?.blocked ? manualDownside.reason : null,
}));
// dlmm.js keeps module-level cache-clearing setIntervals alive — exit explicitly
process.exit(0);
