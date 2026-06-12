import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Why these tests exist: the deploy safety checks used to read only LLM-echoed
// args — an omitted volatility/bin_step/fragility silently SKIPPED those gates,
// a forged band shrank the minimum size, and the per-cycle computed deploy
// amount was prompt-only. The executor now resolves ground truth from the
// signals staged by code during screening (signal-tracker.js), so the LLM can
// no longer skip or weaken a gate by omitting/forging args. The runner needs
// --experimental-test-module-mocks, so it runs in a child process (same
// pattern as deploy-metrics.test.js).
const runner = fileURLToPath(new URL("./deploy-safety-staged-runner.mjs", import.meta.url));
let _summary = null;
function summary() {
  if (!_summary) {
    const res = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--no-warnings", runner], {
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(res.status, 0, `runner failed\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    _summary = JSON.parse(res.stdout.trim().split("\n").pop());
  }
  return _summary;
}

test("omitted volatility no longer skips the gate — staged volatility rejects", () => {
  const s = summary();
  assert.match(s.volOmittedReason ?? "", /volatility 9/, "staged volatility above hard max must reject even when the arg is omitted");
});

test("claimed band A is overridden by staged band B", () => {
  const s = summary();
  assert.equal(s.bandStagedBReason, null, `staged band B must allow the reduced minimum, got: ${s.bandStagedBReason}`);
  assert.ok(s.bandStagedBDeployed, "0.4 SOL deploy must pass with staged band B despite the LLM claiming band A");
});

test("claimed band B cannot shrink the minimum when staged band is A", () => {
  const s = summary();
  assert.match(s.bandStagedAReason ?? "", /below the minimum deploy amount/, "staged band A must enforce the full-size minimum despite a claimed band B");
});

test("amount_y above the staged per-cycle deploy size is rejected", () => {
  const s = summary();
  assert.match(s.overMaxDeployReason ?? "", /1 exceeds this cycle's computed deploy amount \(0\.6 SOL\)/, "reason must name both the requested and the staged amount");
});

test("auto deploy into an unstaged pool is rejected", () => {
  const s = summary();
  assert.match(s.unstagedReason ?? "", /not in the current screened candidate set/, "auto deploys must come from the staged candidate set");
});

test("omitted bin_step no longer skips the gate — staged bin_step rejects", () => {
  const s = summary();
  assert.match(s.stepOmittedReason ?? "", /bin_step 300/, "staged bin_step out of range must reject even when the arg is omitted");
});

test("manual deploys are unaffected by staged-signal gating", () => {
  const s = summary();
  assert.equal(s.manualReason, null, `manual deploy must not be blocked, got: ${s.manualReason}`);
  assert.ok(s.manualDeployed, "manual deploy on an unstaged pool with omitted signals must still execute");
});

test("veto-only: a staged but not code-selected pool is rejected", () => {
  const s = summary();
  assert.match(s.notSelectedReason ?? "", /code-selected candidate/, "screener must not substitute a runner-up for the code's deterministic pick");
});

test("screenerVetoOnly=false rolls back to multi-candidate behavior", () => {
  const s = summary();
  assert.equal(s.vetoOffReason, null, `flag-off deploy must not be blocked, got: ${s.vetoOffReason}`);
  assert.ok(s.vetoOffDeployed, "with veto-only off, a staged non-selected pool must deploy like before");
});

test("unstaged pool cannot borrow staged signals via a shared base mint", () => {
  // Pool-exact staging lookup: in rollback mode a different DLMM pool of the
  // same token must not inherit the staged pool's bin_step/band/volatility and
  // slip past the staging gate.
  const s = summary();
  assert.match(s.mintBorrowReason ?? "", /not in the current screened candidate set/,
    "same-mint different-pool deploy must be rejected as unstaged");
});
