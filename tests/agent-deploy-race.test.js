import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Why this test exists: tool calls in one assistant message run concurrently
// (Promise.all in agent.js), so the firedOnce duplicate check for deploy_position
// must check-and-set synchronously. If the add drifts back below an await, two
// parallel deploy_position calls both pass the check and BOTH deploy real money.
// The runner needs --experimental-test-module-mocks, so it runs in a child process.
const runner = fileURLToPath(new URL("./agent-deploy-race-runner.mjs", import.meta.url));

test("parallel deploy_position calls in one message execute only once", () => {
  const res = spawnSync(process.execPath, ["--experimental-test-module-mocks", "--no-warnings", runner], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(res.status, 0, `runner failed\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  const summary = JSON.parse(res.stdout.trim().split("\n").pop());
  assert.equal(summary.deployExecutions, 1, "deploy_position must execute exactly once — a second parallel call means double-deployed capital");
  assert.equal(summary.blocked, 1, "the duplicate deploy_position call must be blocked, not executed");
});
