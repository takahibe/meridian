import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { assignBand } from "../tools/scoring.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const lessonsPath = path.join(ROOT, "lessons.json");
const outputPath = path.join(ROOT, "replay-screening-funnel.md");
const userConfigPath = path.join(ROOT, "user-config.json");

const lessons = JSON.parse(fs.readFileSync(lessonsPath, "utf8"));
const userConfig = JSON.parse(fs.readFileSync(userConfigPath, "utf8"));
const cfg = {
  xNarrativeMinConfidence: userConfig.xNarrativeMinConfidence ?? "moderate",
  minPoolTvl: userConfig.minPoolTvl ?? 15000,
  minPoolOpenPositions: userConfig.minPoolOpenPositions ?? 1,
};

const perf = (lessons.performance || []).filter((entry) => entry.signal_snapshot && Object.keys(entry.signal_snapshot).length > 0);
const bandStats = { A: initBand(), B: initBand(), C: initBand(), REJECT: initBand() };
const stageDrops = { x_narrative: 0, pool_quality: 0, discord: 0, unknown: 0 };
let filteredLossReduction = 0;

for (const entry of perf) {
  const snap = entry.signal_snapshot || {};
  const result = assignBand({
    active_tvl: snap.active_tvl ?? entry.initial_value_usd ?? 0,
    open_positions: snap.open_positions ?? cfg.minPoolOpenPositions,
    fragility_level: snap.fragility_level,
    lpagent_confidence: snap.lpagent_confidence,
    discord_active: snap.discord_active,
  }, {
    narrative_confidence: snap.narrative_confidence,
    shill_burst_flag: snap.shill_burst_flag,
    lpagent_confidence: snap.lpagent_confidence,
  }, cfg);

  const band = result.band || "REJECT";
  const stats = bandStats[band] || (bandStats[band] = initBand());
  stats.count++;
  stats.pnl += Number(entry.pnl_usd || 0);
  if ((entry.pnl_usd || 0) > 0) stats.wins++;
  else if (band === "REJECT") filteredLossReduction += Math.abs(Number(entry.pnl_usd || 0));
  stageDrops[result.stage || "unknown"] = (stageDrops[result.stage || "unknown"] || 0) + 1;
}

const projectedPnl = (bandStats.A.pnl || 0) + (bandStats.B.pnl || 0);
const lines = [
  "# Replay Screening Funnel",
  "",
  `Records analyzed: ${perf.length}`,
  `Projected kept-band PnL (A+B): $${projectedPnl.toFixed(2)}`,
  `Hypothetical filtered loss reduction (REJECT losers only): $${filteredLossReduction.toFixed(2)}`,
  "",
  "## PnL by band",
  "",
  "| Band | Count | Wins | Win Rate | Net PnL |",
  "|---|---:|---:|---:|---:|",
  ...Object.entries(bandStats).map(([band, stats]) => `| ${band} | ${stats.count} | ${stats.wins} | ${stats.count ? ((stats.wins / stats.count) * 100).toFixed(1) : "0.0"}% | $${stats.pnl.toFixed(2)} |`),
  "",
  "## Stage drop counts",
  "",
  "| Stage | Count |",
  "|---|---:|",
  ...Object.entries(stageDrops).map(([stage, count]) => `| ${stage} | ${count} |`),
];

fs.writeFileSync(outputPath, `${lines.join("\n")}\n`);
console.log(`Wrote ${outputPath}`);

function initBand() {
  return { count: 0, wins: 0, pnl: 0 };
}
