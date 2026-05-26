import path from "path";
import { fileURLToPath } from "url";

const __root = path.dirname(fileURLToPath(import.meta.url));

// Data directory: state, lessons, logs, cache, and all mutable JSON files.
// Defaults to project root so production behavior is unchanged.
const dataDir = process.env.MERIDIAN_DATA_DIR
  ? path.resolve(__root, process.env.MERIDIAN_DATA_DIR)
  : __root;

// Config file path. Separate from dataDir so you can point at any config
// while keeping data files isolated to their profile directory.
const userConfigPath = process.env.MERIDIAN_CONFIG_PATH
  ? path.resolve(__root, process.env.MERIDIAN_CONFIG_PATH)
  : path.join(dataDir, "user-config.json");

export const paths = {
  dataDir,
  userConfigPath,
  gmgnConfigPath:      path.join(dataDir, "gmgn-config.json"),
  statePath:           path.join(dataDir, "state.json"),
  lessonsPath:         path.join(dataDir, "lessons.json"),
  poolMemoryPath:      path.join(dataDir, "pool-memory.json"),
  decisionLogPath:     path.join(dataDir, "decision-log.json"),
  hivemindCachePath:   path.join(dataDir, "hivemind-cache.json"),
  logDir:              path.join(dataDir, "logs"),
  smartWalletsPath:    path.join(dataDir, "smart-wallets.json"),
  strategyLibraryPath: path.join(dataDir, "strategy-library.json"),
  tokenBlacklistPath:  path.join(dataDir, "token-blacklist.json"),
  devBlocklistPath:    path.join(dataDir, "dev-blocklist.json"),
  signalWeightsPath:   path.join(dataDir, "signal-weights.json"),
  researchEventsPath:  path.join(dataDir, "research-events.jsonl"),
  shadowLabelsPath:    path.join(dataDir, "shadow-labels.jsonl"),
  priceHistoryPath:    path.join(dataDir, "price-history.json"),
  xNarrativeCachePath: path.join(dataDir, "x-narrative-cache.json"),
};
