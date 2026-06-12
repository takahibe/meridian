// Inner runner for the staged-signal tests in deploy-safety-staged.test.js — must
// run under node --experimental-test-module-mocks (mock.module is flag-gated in
// Node 22). Mocks tools/dlmm.js and every notifying/file-writing module so
// executeTool's safety checks run with zero network/chain access, while the REAL
// signal-tracker.js stages code-computed signals the executor must enforce.
import { mock } from "node:test";

process.env.DRY_RUN = "true";
process.env.RPC_URL = process.env.RPC_URL || "http://127.0.0.1:1";

const local = (p) => new URL(p, import.meta.url).href;

mock.module(local("../logger.js"), { namedExports: { log: () => {}, logAction: () => {} } });
mock.module(local("../telegram.js"), {
  namedExports: { notifyDeploy: async () => {}, notifyClose: async () => {}, notifySwap: async () => {} },
});
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
// Mock the whole DLMM layer: getMyPositions would hit the chain inside the safety
// checks, and deployPosition returning a marker proves a deploy PASSED every gate.
mock.module(local("../tools/dlmm.js"), {
  namedExports: {
    getActiveBin: async () => ({}),
    deployPosition: async () => ({ success: true, mock_deployed: true, position: "pos_mock" }),
    getMyPositions: async () => ({ total_positions: 0, positions: [] }),
    getWalletPositions: async () => ({ positions: [] }),
    getPositionPnl: async () => ({}),
    claimFees: async () => ({}),
    closePosition: async () => ({}),
    searchPools: async () => ({}),
  },
});

const { config } = await import(local("../config.js"));
const { stageSignals, stageSelectedPool } = await import(local("../signal-tracker.js"));
const { executeTool } = await import(local("../tools/executor.js"));

// Pin the thresholds the gates read so the assertions are deterministic
config.screening.minBinStep = 80;
config.screening.maxBinStep = 125;
config.screening.maxVolatilityHard = 5;
config.management.deployAmountSol = 0.5;
config.management.deployAmountSolMin = 0.35;
config.risk.maxDeployAmount = 50;
config.risk.maxPositions = 3;
config.strategy.minBinsBelow = 35;
config.screening.screenerVetoOnly = true;

function stage(pool, overrides = {}) {
  // The screening cycle stages signals AND marks the pool as the code-selected
  // candidate — mirror both here so the other gates are tested under veto-only mode.
  stageSelectedPool(pool);
  stageSignals(pool, {
    base_mint: `mint_${pool}`,
    bin_step: 100,
    max_deploy_sol: 0.5,
    volatility: 2,
    fragility_score: 10,
    fragility_level: "stable",
    screening_band: "A",
    ...overrides,
  });
}

function deploy(extra) {
  return executeTool("deploy_position", {
    amount_y: 0.5,
    strategy: "bid_ask",
    bins_below: 50,
    bins_above: 0,
    ...extra,
  });
}

// 1) Omitted volatility: staged value (above hard max) must still reject
stage("poolVol", { volatility: 9 });
const volOmitted = await deploy({ pool_address: "poolVol" });

// 2) LLM claims band A, staged truth is B: 0.4 SOL passes the B reduced minimum
//    (claimed-A-only would have rejected it as below the 0.5 SOL band-A minimum)
stage("poolBandB", { screening_band: "B", max_deploy_sol: 1 });
const bandStagedB = await deploy({ pool_address: "poolBandB", band: "A", amount_y: 0.4 });

// 3) LLM claims band B to shrink the minimum, staged truth is A: must reject
stage("poolBandA", { screening_band: "A", max_deploy_sol: 1 });
const bandStagedA = await deploy({ pool_address: "poolBandA", band: "B", amount_y: 0.4 });

// 4) amount_y above the staged per-cycle computed deploy size: must reject
stage("poolSize", { max_deploy_sol: 0.6 });
const overMaxDeploy = await deploy({ pool_address: "poolSize", amount_y: 1 });

// 5) Auto deploy into a pool that was never staged: must reject
const unstaged = await deploy({ pool_address: "poolGhost" });

// 6) Omitted bin_step: staged value (out of range) must still reject
stage("poolStep", { bin_step: 300 });
const stepOmitted = await deploy({ pool_address: "poolStep" });

// 7) Manual deploy: unstaged pool, omitted volatility, claimed band — all allowed
const manual = await deploy({ pool_address: "poolGhost2", deploy_source: "manual", band: "A" });

// 8) Staged-but-NOT-selected pool: veto-only mode must reject — the screener may
//    only deploy the code-selected candidate, not a runner-up it likes better
stage("poolSelected");
stageSignals("poolRunnerUp", {
  base_mint: "mint_poolRunnerUp",
  bin_step: 100,
  max_deploy_sol: 0.5,
  volatility: 2,
  fragility_score: 10,
  fragility_level: "stable",
  screening_band: "A",
});
const notSelected = await deploy({ pool_address: "poolRunnerUp" });

// 9) Rollback: screenerVetoOnly=false restores multi-candidate behavior — the
//    same staged runner-up deploys fine when the flag is off
config.screening.screenerVetoOnly = false;
const vetoOff = await deploy({ pool_address: "poolRunnerUp" });
config.screening.screenerVetoOnly = true;

// Machine-readable summary for the outer test (last stdout line)
console.log(JSON.stringify({
  volOmittedReason: volOmitted?.blocked ? volOmitted.reason : null,
  bandStagedBDeployed: bandStagedB?.mock_deployed === true,
  bandStagedBReason: bandStagedB?.blocked ? bandStagedB.reason : null,
  bandStagedAReason: bandStagedA?.blocked ? bandStagedA.reason : null,
  overMaxDeployReason: overMaxDeploy?.blocked ? overMaxDeploy.reason : null,
  unstagedReason: unstaged?.blocked ? unstaged.reason : null,
  stepOmittedReason: stepOmitted?.blocked ? stepOmitted.reason : null,
  manualDeployed: manual?.mock_deployed === true,
  manualReason: manual?.blocked ? manual.reason : null,
  notSelectedReason: notSelected?.blocked ? notSelected.reason : null,
  vetoOffDeployed: vetoOff?.mock_deployed === true,
  vetoOffReason: vetoOff?.blocked ? vetoOff.reason : null,
}));
process.exit(0);
