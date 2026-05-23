import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function mkTempProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "meridian-iso-"));
}

function rootMtime(file) {
  const full = path.join(repoRoot, file);
  if (!fs.existsSync(full)) return null;
  return fs.statSync(full).mtimeMs;
}

function runInChild(script, env = {}) {
  return execFileSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("state.js writes route to MERIDIAN_DATA_DIR, not project root", () => {
  const tmp = mkTempProfile();
  const before = rootMtime("state.json");
  runInChild(
    `import("./state.js").then(({ trackPosition }) => trackPosition({ position_address: "iso-" + Date.now(), pool_address: "pool-iso", pool_name: "ISO-TEST", base_mint: "x", deploy_source: "test" }));`,
    { MERIDIAN_DATA_DIR: tmp },
  );
  const tmpFile = path.join(tmp, "state.json");
  assert.ok(fs.existsSync(tmpFile), `expected ${tmpFile} to exist`);
  const after = rootMtime("state.json");
  assert.equal(after, before, "project-root state.json mtime must be unchanged");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("signal-weights.js auto-creates weights file under profile dir", () => {
  const tmp = mkTempProfile();
  const before = rootMtime("signal-weights.json");
  runInChild(
    `import("./signal-weights.js").then(({ getWeightsSummary }) => getWeightsSummary());`,
    { MERIDIAN_DATA_DIR: tmp },
  );
  const tmpFile = path.join(tmp, "signal-weights.json");
  assert.ok(fs.existsSync(tmpFile), `expected ${tmpFile} to exist`);
  const after = rootMtime("signal-weights.json");
  assert.equal(after, before, "project-root signal-weights.json mtime must be unchanged");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("price-tracker.js writes price history under profile dir", () => {
  const tmp = mkTempProfile();
  const before = rootMtime("price-history.json");
  runInChild(
    `import("./tools/price-tracker.js").then(({ recordSolPrice }) => recordSolPrice(123.45));`,
    { MERIDIAN_DATA_DIR: tmp },
  );
  const tmpFile = path.join(tmp, "price-history.json");
  assert.ok(fs.existsSync(tmpFile), `expected ${tmpFile} to exist`);
  const after = rootMtime("price-history.json");
  assert.equal(after, before, "project-root price-history.json mtime must be unchanged");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("decision-log.js writes audit entries under profile dir", () => {
  const tmp = mkTempProfile();
  const before = rootMtime("decision-log.json");
  runInChild(
    `import("./decision-log.js").then(({ appendDecision }) => appendDecision({ type: "iso-test", summary: "isolation smoke" }));`,
    { MERIDIAN_DATA_DIR: tmp },
  );
  const tmpFile = path.join(tmp, "decision-log.json");
  assert.ok(fs.existsSync(tmpFile), `expected ${tmpFile} to exist`);
  const after = rootMtime("decision-log.json");
  assert.equal(after, before, "project-root decision-log.json mtime must be unchanged");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("logger.js writes logs under MERIDIAN_DATA_DIR/logs/", () => {
  const tmp = mkTempProfile();
  const beforeRootLogs = fs.existsSync(path.join(repoRoot, "logs"))
    ? fs.readdirSync(path.join(repoRoot, "logs"))
    : [];
  runInChild(
    `import("./logger.js").then(({ log }) => log("iso_test", "isolation smoke"));`,
    { MERIDIAN_DATA_DIR: tmp },
  );
  const tmpLogs = path.join(tmp, "logs");
  assert.ok(fs.existsSync(tmpLogs), `expected ${tmpLogs} to exist`);
  const tmpFiles = fs.readdirSync(tmpLogs);
  assert.ok(tmpFiles.length > 0, "profile logs dir should have at least one file");
  if (fs.existsSync(path.join(repoRoot, "logs"))) {
    const afterRootLogs = fs.readdirSync(path.join(repoRoot, "logs"));
    assert.deepEqual(afterRootLogs.sort(), beforeRootLogs.sort(),
      "project-root logs/ directory contents must be unchanged");
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});
