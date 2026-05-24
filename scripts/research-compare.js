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

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function closePnl(p) {
  const sol = firstFinite(p.pnl_sol, p.net_sol);
  if (sol !== null) return { value: sol, basis: "sol" };

  const pct = firstFinite(p.pnl_pct);
  if (pct !== null) return { value: pct, basis: "pct" };

  const usd = firstFinite(p.pnl_usd, p.net_usd);
  if (usd !== null) return { value: usd, basis: "usd" };

  return { value: 0, basis: "missing" };
}

function summarize(perfArray, label) {
  const closes = (perfArray || []).filter(p => p && p.close_reason);
  const totalClosed = closes.length;
  if (totalClosed === 0) {
    return { label, closes: 0, empty: true };
  }

  const pnlValues = closes.map(closePnl);
  const basisCounts = pnlValues.reduce((counts, pnl) => {
    counts[pnl.basis] = (counts[pnl.basis] || 0) + 1;
    return counts;
  }, {});
  const primaryBasis = Object.entries(basisCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "missing";
  const comparablePnlValues = pnlValues.filter(pnl => pnl.basis === primaryBasis);

  const netSol = closes.reduce((s, p) => s + num(p.pnl_sol ?? p.net_sol), 0);
  const netPnl = comparablePnlValues.reduce((s, pnl) => s + pnl.value, 0);
  const winners = comparablePnlValues.filter(pnl => pnl.value > 0);
  const losers = comparablePnlValues.filter(pnl => pnl.value < 0);
  const winrate = comparablePnlValues.length ? winners.length / comparablePnlValues.length : 0;

  const totalDeploy = closes.reduce((s, p) => s + num(p.deploy_sol ?? p.amount_sol ?? p.initial_sol), 0);
  const avgDeploy = totalClosed ? totalDeploy / totalClosed : 0;
  const netSolPerDeploy = totalDeploy > 0 ? netSol / totalDeploy : 0;
  const netPnlPerDeploy = totalDeploy > 0 && primaryBasis === "sol" ? netPnl / totalDeploy : null;

  const oor = closes.filter(p => /out of range|oor|pumped/i.test(p.close_reason)).length;
  const dump = closes.filter(p => /lower dump|stop loss|drop|fee.decay/i.test(p.close_reason)).length;
  const tp = closes.filter(p => /take profit|tp/i.test(p.close_reason)).length;

  const holds = closes.map(p => num(p.minutes_held)).filter(m => m > 0);
  const avgHold = holds.length ? holds.reduce((a, b) => a + b, 0) / holds.length : 0;

  const worst = comparablePnlValues.reduce((min, pnl) => {
    return pnl.value < min ? pnl.value : min;
  }, 0);

  const recentClose = closes.reduce((latest, p) => {
    const t = p.recorded_at || p.closed_at;
    return t && t > (latest || "") ? t : latest;
  }, null);

  return {
    label,
    closes: totalClosed,
    pnl_basis: primaryBasis,
    pnl_basis_counts: basisCounts,
    comparable_closes: comparablePnlValues.length,
    net_sol: +netSol.toFixed(4),
    net_pnl: +netPnl.toFixed(4),
    avg_pnl: comparablePnlValues.length ? +(netPnl / comparablePnlValues.length).toFixed(4) : 0,
    net_sol_per_deploy_unit: +netSolPerDeploy.toFixed(4),
    net_pnl_per_deploy_unit: netPnlPerDeploy === null ? null : +netPnlPerDeploy.toFixed(4),
    winrate: +winrate.toFixed(2),
    winners: winners.length,
    losers: losers.length,
    avg_deploy_sol: +avgDeploy.toFixed(3),
    avg_hold_minutes: +avgHold.toFixed(0),
    oor_closes: oor,
    dump_closes: dump,
    tp_closes: tp,
    worst_close: +worst.toFixed(4),
    worst_close_sol: primaryBasis === "sol" ? +worst.toFixed(4) : +netSol.toFixed(4),
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

  if (ar.pnl_basis !== "sol") {
    return {
      verdict: "REVIEW",
      reason: `Autoresearch winrate ${(ar.winrate * 100).toFixed(0)}% is computed from ${ar.pnl_basis} fallback because SOL PnL fields are missing. Do not promote automatically until records include pnl_sol/net_sol for normalized net SOL comparison.`,
    };
  }

  const sameBasis = main.empty || main.pnl_basis === ar.pnl_basis;
  const mainScore = main.empty
    ? 0
    : (sameBasis && ar.pnl_basis === "sol" ? main.net_sol_per_deploy_unit : main.avg_pnl);
  const arScore = sameBasis && ar.pnl_basis === "sol" ? ar.net_sol_per_deploy_unit : ar.avg_pnl;
  const beatsMain = arScore > mainScore;
  const beatsWinrate = !main.empty && ar.winrate >= main.winrate;
  const beatsTail = !main.empty && sameBasis && ar.worst_close >= main.worst_close;

  if (!sameBasis) {
    return {
      verdict: "REVIEW",
      reason: `Main and autoresearch use different PnL bases (${main.pnl_basis} vs ${ar.pnl_basis}). Review manually or normalize records before promotion.`,
    };
  }

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
    console.log(row("PnL basis", mainSummary.pnl_basis, arSummary.pnl_basis));
    console.log(row("winrate", mainSummary.winrate, arSummary.winrate));
    console.log(row("winners / losers", `${mainSummary.winners}/${mainSummary.losers}`, `${arSummary.winners}/${arSummary.losers}`));
    console.log(row("net PnL", mainSummary.net_pnl, arSummary.net_pnl));
    console.log(row("avg PnL / close", mainSummary.avg_pnl, arSummary.avg_pnl));
    console.log(row("net SOL (raw)", mainSummary.net_sol, arSummary.net_sol));
    console.log(row("net SOL / deploy unit", mainSummary.net_sol_per_deploy_unit, arSummary.net_sol_per_deploy_unit));
    console.log(row("avg deploy (SOL)", mainSummary.avg_deploy_sol, arSummary.avg_deploy_sol));
    console.log(row("avg hold (min)", mainSummary.avg_hold_minutes, arSummary.avg_hold_minutes));
    console.log(row("OOR closes", mainSummary.oor_closes, arSummary.oor_closes));
    console.log(row("dump/stop closes", mainSummary.dump_closes, arSummary.dump_closes));
    console.log(row("TP closes", mainSummary.tp_closes, arSummary.tp_closes));
    console.log(row("worst close", mainSummary.worst_close, arSummary.worst_close));
  }
  console.log("");

  const d = decision(mainSummary, arSummary);
  console.log(`  Decision: ${d.verdict}`);
  console.log(`  ${d.reason}`);
  console.log("");
}

main();
