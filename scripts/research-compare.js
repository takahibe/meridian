#!/usr/bin/env node
/**
 * Side-by-side comparison of main vs autoresearch profile performance.
 *
 * Reads lessons.json from project root (main) and profiles/autoresearch/
 * (autores). Normalizes net SOL by deploy size so wallets of different
 * sizes are comparable. Prints a table and recommends a decision per
 * the workflow in research/README.md.
 *
 * Usage:
 *   node scripts/research-compare.js           # compare current run
 *   node scripts/research-compare.js --json    # machine-readable output
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function loadLessons(file) {
  if (!fs.existsSync(file)) return { performance: [], lessons: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`! Failed to read ${file}: ${err.message}`);
    return { performance: [], lessons: [] };
  }
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function summarize(perfArray, label) {
  const closes = (perfArray || []).filter(p => p && p.close_reason);
  const totalClosed = closes.length;
  if (totalClosed === 0) {
    return { label, closes: 0, empty: true };
  }

  const netSol = closes.reduce((s, p) => s + num(p.pnl_sol ?? p.net_sol), 0);
  const winners = closes.filter(p => num(p.pnl_sol ?? p.net_sol) > 0);
  const losers = closes.filter(p => num(p.pnl_sol ?? p.net_sol) < 0);
  const winrate = totalClosed ? winners.length / totalClosed : 0;

  const totalDeploy = closes.reduce((s, p) => s + num(p.deploy_sol ?? p.amount_sol ?? p.initial_sol), 0);
  const avgDeploy = totalClosed ? totalDeploy / totalClosed : 0;
  const netSolPerDeploy = avgDeploy > 0 ? netSol / totalDeploy : 0;

  const oor = closes.filter(p => /out of range|oor|pumped/i.test(p.close_reason)).length;
  const dump = closes.filter(p => /lower dump|stop loss|drop|fee.decay/i.test(p.close_reason)).length;
  const tp = closes.filter(p => /take profit|tp/i.test(p.close_reason)).length;

  const holds = closes.map(p => num(p.minutes_held)).filter(m => m > 0);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;

  const worst = closes.reduce((min, p) => {
    const v = num(p.pnl_sol ?? p.net_sol);
    return v < min ? v : min;
  }, 0);

  const recentClose = closes.reduce((latest, p) => {
    const t = p.recorded_at || p.closed_at;
    return t && t > (latest || "") ? t : latest;
  }, null);

  return {
    label,
    closes: totalClosed,
    net_sol: +netSol.toFixed(4),
    net_sol_per_deploy_unit: +netSolPerDeploy.toFixed(4),
    winrate: +winrate.toFixed(2),
    winners: winners.length,
    losers: losers.length,
    avg_deploy_sol: +avgDeploy.toFixed(3),
    avg_hold_minutes: +avgHold.toFixed(0),
    oor_closes: oor,
    dump_closes: dump,
    tp_closes: tp,
    worst_close_sol: +worst.toFixed(4),
    last_close: recentClose,
  };
}

function row(key, mainVal, arVal) {
  const padded = (v) => String(v ?? "—").padStart(14);
  return `  ${key.padEnd(28)}${padded(mainVal)}${padded(arVal)}`;
}

function decision(main, ar) {
  if (ar.empty) {
    return {
      verdict: "WAIT",
      reason: "Autoresearch has no closed positions yet. Continue running until at least 10 closes accumulate.",
    };
  }
  if (ar.closes < 10) {
    return {
      verdict: "WAIT",
      reason: `Autoresearch has only ${ar.closes} closed position(s). Minimum sample size is 10 before deciding.`,
    };
  }
  if (ar.winrate < 0.4) {
    return {
      verdict: "KILL",
      reason: `Autoresearch winrate ${(ar.winrate * 100).toFixed(0)}% is below 40% kill threshold over ${ar.closes} closes.`,
    };
  }

  const mainPerDeploy = main.empty ? 0 : main.net_sol_per_deploy_unit;
  const arPerDeploy = ar.net_sol_per_deploy_unit;
  const beatsMain = arPerDeploy > mainPerDeploy;
  const beatsWinrate = !main.empty && ar.winrate >= main.winrate;
  const beatsTail = !main.empty && ar.worst_close_sol >= main.worst_close_sol;

  if (beatsMain && beatsWinrate && beatsTail) {
    return {
      verdict: "PROMOTE",
      reason: "Autoresearch beats main on net SOL per deploy unit, winrate, AND worst-close tail. Review the close reasons before applying to main — confirm the mechanism is real and not a regime artifact.",
    };
  }
  if (beatsMain || beatsWinrate || beatsTail) {
    return {
      verdict: "EXTEND",
      reason: "Mixed result — autoresearch beats main on some metrics but not all. Extend the run to 2x sample size, or start a cleaner hypothesis.",
    };
  }
  return {
    verdict: "KILL",
    reason: "Autoresearch does not beat main on net SOL per deploy unit, winrate, or worst-close tail. Document why and start a new hypothesis.",
  };
}

function main() {
  const mainLessons = loadLessons(path.join(repoRoot, "lessons.json"));
  const arLessons = loadLessons(path.join(repoRoot, "profiles", "autoresearch", "lessons.json"));

  const mainSummary = summarize(mainLessons.performance, "main");
  const arSummary = summarize(arLessons.performance, "autoresearch");

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ main: mainSummary, autoresearch: arSummary, decision: decision(mainSummary, arSummary) }, null, 2));
    return;
  }

  console.log("");
  console.log("Meridian autoresearch vs main — close-position comparison");
  console.log("");
  console.log("  " + "metric".padEnd(28) + "main".padStart(14) + "autores".padStart(14));
  console.log("  " + "─".repeat(56));
  console.log(row("closed positions", mainSummary.closes, arSummary.closes));
  if (!arSummary.empty) {
    console.log(row("net SOL (raw)", mainSummary.net_sol, arSummary.net_sol));
    console.log(row("net SOL / deploy unit", mainSummary.net_sol_per_deploy_unit, arSummary.net_sol_per_deploy_unit));
    console.log(row("winrate", mainSummary.winrate, arSummary.winrate));
    console.log(row("winners / losers", `${mainSummary.winners}/${mainSummary.losers}`, `${arSummary.winners}/${arSummary.losers}`));
    console.log(row("avg deploy (SOL)", mainSummary.avg_deploy_sol, arSummary.avg_deploy_sol));
    console.log(row("avg hold (min)", mainSummary.avg_hold_minutes, arSummary.avg_hold_minutes));
    console.log(row("OOR closes", mainSummary.oor_closes, arSummary.oor_closes));
    console.log(row("dump/stop closes", mainSummary.dump_closes, arSummary.dump_closes));
    console.log(row("TP closes", mainSummary.tp_closes, arSummary.tp_closes));
    console.log(row("worst close (SOL)", mainSummary.worst_close_sol, arSummary.worst_close_sol));
  }
  console.log("");

  const d = decision(mainSummary, arSummary);
  console.log(`  Decision: ${d.verdict}`);
  console.log(`  ${d.reason}`);
  console.log("");
}

main();
