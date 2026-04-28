/**
 * Weekly source check — informs the meteora vs gmgn flip decision.
 *
 * Reports for the last 7 days:
 *   - Deploy count (from state.json positions.deployed_at)
 *   - Closed-cohort PnL: sum + win rate (from lessons.json performance[].recorded_at)
 *   - Flip verdict per project_gmgn_switch_plan.md criteria
 *
 * Verdict rules:
 *   - "FLIP — quality" if deploys >= 10 and cohort sum < 0
 *   - "FLIP — thin universe" if deploys < 3 and no allowlist starvation
 *   - "HOLD" otherwise
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { sendMessage, isEnabled as telegramEnabled } from "../telegram.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function readJson(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export function computeWeeklySourceCheck(now = Date.now()) {
  const cutoff = now - WEEK_MS;
  const state = readJson("state.json") ?? { positions: {} };
  const lessons = readJson("lessons.json") ?? { performance: [] };

  const deploys = Object.values(state.positions ?? {}).filter((p) => {
    const t = Date.parse(p?.deployed_at ?? "");
    return Number.isFinite(t) && t >= cutoff;
  });

  const closedCohort = (lessons.performance ?? []).filter((r) => {
    const t = Date.parse(r?.recorded_at ?? "");
    return Number.isFinite(t) && t >= cutoff;
  });

  const sumPnlUsd = closedCohort.reduce((s, r) => s + (Number(r.pnl_usd) || 0), 0);
  const winners = closedCohort.filter((r) => (Number(r.pnl_pct) || 0) > 0).length;
  const winRate = closedCohort.length > 0 ? winners / closedCohort.length : null;

  const allowedLaunchpads = config?.screening?.allowedLaunchpads ?? [];
  const allowlistStarvation = Array.isArray(allowedLaunchpads) && allowedLaunchpads.length > 0;
  const screeningSource = config?.screening?.source ?? "meteora";

  let verdict = "HOLD";
  let reason = "metrics within normal band";
  if (deploys.length >= 10 && sumPnlUsd < 0) {
    verdict = "FLIP — quality";
    reason = `${deploys.length} deploys but cohort PnL ${sumPnlUsd.toFixed(2)} USD — funnel works, quality bad`;
  } else if (deploys.length < 3 && !allowlistStarvation) {
    verdict = "FLIP — thin universe";
    reason = `only ${deploys.length} deploys, no allowlist starvation — pool universe too thin`;
  } else if (deploys.length < 3 && allowlistStarvation) {
    verdict = "HOLD";
    reason = `${deploys.length} deploys but allowedLaunchpads is set (${allowedLaunchpads.length}) — investigate allowlist before flipping`;
  }

  return {
    source: screeningSource,
    deploys: deploys.length,
    closedCount: closedCohort.length,
    sumPnlUsd,
    winRate,
    allowedLaunchpadsCount: allowedLaunchpads.length,
    verdict,
    reason,
  };
}

export function formatReport(r) {
  const wr = r.winRate == null ? "n/a" : `${(r.winRate * 100).toFixed(0)}%`;
  const pnl = `${r.sumPnlUsd >= 0 ? "+" : ""}${r.sumPnlUsd.toFixed(2)} USD`;
  return [
    `📊 Weekly Source Check (${r.source})`,
    ``,
    `Deploys (7d): ${r.deploys}`,
    `Closed (7d): ${r.closedCount} — PnL ${pnl} — win rate ${wr}`,
    `Allowlist: ${r.allowedLaunchpadsCount === 0 ? "off" : `${r.allowedLaunchpadsCount} entries`}`,
    ``,
    `Verdict: ${r.verdict}`,
    `→ ${r.reason}`,
  ].join("\n");
}

export async function runWeeklySourceCheck() {
  const result = computeWeeklySourceCheck();
  const text = formatReport(result);
  log("cron", `Weekly source check: ${result.verdict} (deploys=${result.deploys}, pnl=${result.sumPnlUsd.toFixed(2)})`);
  if (telegramEnabled()) {
    await sendMessage(text).catch((e) => log("cron_error", `Weekly source check telegram failed: ${e.message}`));
  } else {
    console.log(text);
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runWeeklySourceCheck().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
