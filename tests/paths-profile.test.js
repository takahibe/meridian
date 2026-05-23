import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function pathsWithEnv(env = {}) {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      'import("./paths.js").then(m => process.stdout.write(JSON.stringify(m.paths)))',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, MERIDIAN_DATA_DIR: "", MERIDIAN_CONFIG_PATH: "", ...env },
      encoding: "utf8",
    },
  );
  return JSON.parse(out);
}

test("default profile: paths resolve under project root", () => {
  const p = pathsWithEnv();
  assert.equal(p.statePath, path.join(repoRoot, "state.json"));
  assert.equal(p.lessonsPath, path.join(repoRoot, "lessons.json"));
  assert.equal(p.userConfigPath, path.join(repoRoot, "user-config.json"));
});

test("MERIDIAN_DATA_DIR redirects data paths to subdirectory", () => {
  const p = pathsWithEnv({ MERIDIAN_DATA_DIR: "/tmp/xyz-profile" });
  assert.equal(p.statePath, "/tmp/xyz-profile/state.json");
  assert.equal(p.lessonsPath, "/tmp/xyz-profile/lessons.json");
  assert.equal(p.poolMemoryPath, "/tmp/xyz-profile/pool-memory.json");
  assert.equal(p.signalWeightsPath, "/tmp/xyz-profile/signal-weights.json");
  assert.equal(p.priceHistoryPath, "/tmp/xyz-profile/price-history.json");
  assert.equal(p.xNarrativeCachePath, "/tmp/xyz-profile/x-narrative-cache.json");
  assert.equal(p.logDir, "/tmp/xyz-profile/logs");
});

test("MERIDIAN_CONFIG_PATH overrides userConfigPath independently of dataDir", () => {
  const p = pathsWithEnv({
    MERIDIAN_DATA_DIR: "/tmp/xyz-profile",
    MERIDIAN_CONFIG_PATH: "/tmp/cfg.json",
  });
  assert.equal(p.userConfigPath, "/tmp/cfg.json");
  assert.equal(p.statePath, "/tmp/xyz-profile/state.json");
});

test("all expected path keys are present", () => {
  const p = pathsWithEnv();
  const expected = [
    "dataDir",
    "userConfigPath",
    "gmgnConfigPath",
    "statePath",
    "lessonsPath",
    "poolMemoryPath",
    "decisionLogPath",
    "hivemindCachePath",
    "logDir",
    "smartWalletsPath",
    "strategyLibraryPath",
    "tokenBlacklistPath",
    "devBlocklistPath",
    "signalWeightsPath",
    "priceHistoryPath",
    "xNarrativeCachePath",
  ];
  for (const k of expected) {
    assert.ok(p[k], `missing path key: ${k}`);
  }
  assert.equal(Object.keys(p).length, expected.length);
});
