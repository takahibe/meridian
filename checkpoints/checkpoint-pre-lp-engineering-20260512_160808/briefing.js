import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";
const USER_CONFIG_FILE = "./user-config.json";
const X_NARRATIVE_CACHE_FILE = "./x-narrative-cache.json";
const LOG_DIR = "./logs";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);
  const bandCounts = perfLast24h.reduce((acc, p) => {
    const band = p.screening_band || "?";
    acc[band] = (acc[band] || 0) + 1;
    return acc;
  }, {});

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. X Narrative API health — catches $0 credit / auth / rate-limit failures surfaced by X API.
  const xHealth = getXNarrativeHealth({ since: last24h });

  // 6. Format Message
  const lines = [
    "☀️ <b>Morning Briefing</b> (Last 24h)",
    "────────────────",
    `<b>Activity:</b>`,
    `📥 Positions Opened: ${openedLast24h.length}`,
    `📤 Positions Closed: ${closedLast24h.length}`,
    "",
    `<b>Performance:</b>`,
    `💰 Net PnL: ${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}`,
    `💎 Fees Earned: $${totalFeesUsd.toFixed(2)}`,
    perfLast24h.length > 0
      ? `📈 Win Rate (24h): ${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%`
      : "📈 Win Rate (24h): N/A",
    perfLast24h.length > 0
      ? `🧭 Bands (24h): ${Object.entries(bandCounts).map(([band, count]) => `${band}:${count}`).join(" | ")}`
      : "🧭 Bands (24h): N/A",
    "",
    `<b>Lessons Learned:</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `• ${escapeHtml(l.rule)}`).join("\n")
      : "• No new lessons recorded overnight.",
    "",
    `<b>X Narrative API:</b>`,
    xHealth.statusLine,
    ...xHealth.detailLines,
    "",
    `<b>Current Portfolio:</b>`,
    `📂 Open Positions: ${openPositions.length}`,
    perfSummary
      ? `📊 All-time PnL: $${perfSummary.total_pnl_usd.toFixed(2)} (${perfSummary.win_rate_pct}% win)`
      : "",
    "────────────────"
  ];

  return lines.join("\n");
}

function getXNarrativeHealth({ since }) {
  const cache = loadJson(X_NARRATIVE_CACHE_FILE) || {};
  const userConfig = loadJson(USER_CONFIG_FILE) || {};
  const failOpenEnabled = userConfig.xNarrativeFailOpenOnUnavailable !== false;
  const cacheEntries = Object.values(cache)
    .filter((entry) => entry?.at && new Date(entry.at) > since)
    .map((entry) => entry.value || {});

  const cacheUnknown = cacheEntries.filter((value) => String(value.narrative_confidence || "").toLowerCase() === "unknown");
  const logReasons = getRecentXNarrativeLogReasons({ since });
  const reasons = [...cacheUnknown.map((value) => value.reason).filter(Boolean), ...logReasons];
  const reasonCounts = countReasons(reasons);
  const criticalReasons = reasons.filter(isCriticalXApiReason);
  const unknownLine = `• Recent unknown checks: ${cacheUnknown.length}/${cacheEntries.length || 0}`;
  const failOpenLine = failOpenEnabled
    ? "• Fail-open is enabled: X degradation should not hard-block candidates; later pool-quality gates still apply."
    : "• Fail-open is disabled: X degradation can hard-block otherwise valid candidates.";

  if (criticalReasons.length > 0) {
    return {
      statusLine: failOpenEnabled
        ? `⚠️ DEGRADED: ${escapeHtml(summarizeReasonCounts(countReasons(criticalReasons)))} — X is unavailable, but fail-open is enabled.`
        : `🚨 CRITICAL: ${escapeHtml(summarizeReasonCounts(countReasons(criticalReasons)))} — X may block screening because fail-open is disabled.`,
      detailLines: [unknownLine, failOpenLine],
    };
  }

  if (cacheUnknown.length > 0 || logReasons.length > 0) {
    return {
      statusLine: `⚠️ Degraded: ${escapeHtml(summarizeReasonCounts(reasonCounts))}`,
      detailLines: [unknownLine, failOpenLine],
    };
  }

  if (cacheEntries.length > 0) {
    return {
      statusLine: `✅ OK: ${cacheEntries.length} recent cached/check result(s), no X API failures detected.`,
      detailLines: [],
    };
  }

  return {
    statusLine: "ℹ️ No X narrative checks recorded in the last 24h.",
    detailLines: ["• Normal if no post-filter candidate reached the top-1 X check."],
  };
}

function getRecentXNarrativeLogReasons({ since }) {
  const reasons = [];
  if (!fs.existsSync(LOG_DIR)) return reasons;

  const files = fs.readdirSync(LOG_DIR)
    .filter((name) => /^agent-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .slice(-3);

  for (const name of files) {
    const file = `${LOG_DIR}/${name}`;
    const text = fs.readFileSync(file, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes("X_NARRATIVE")) continue;
      const ts = line.match(/^\[([^\]]+)\]/)?.[1];
      if (ts && new Date(ts) <= since) continue;
      if (!/WARN|degraded|http|rate limited|missing bearer token|timeout|credit|quota|usagecap|insufficient/i.test(line)) continue;
      const msg = line.replace(/^\[[^\]]+\]\s+\[[^\]]+\]\s*/, "").trim();
      if (msg) reasons.push(msg.slice(0, 180));
    }
  }
  return reasons;
}

function countReasons(reasons = []) {
  const counts = new Map();
  for (const reason of reasons) {
    const normalized = normalizeXApiReason(reason);
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  return counts;
}

function summarizeReasonCounts(counts) {
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${reason}${count > 1 ? ` (${count})` : ""}`);
  return parts.length ? parts.join("; ") : "unknown failure";
}

function normalizeXApiReason(reason) {
  const text = String(reason || "unknown").replace(/\s+/g, " ").trim();
  if (/CreditsDepleted/i.test(text) || /http 402/i.test(text)) return "http 402 CreditsDepleted / X API credit exhausted";
  if (/rate limited|http 429/i.test(text)) return "rate limited / http 429";
  if (/missing bearer token/i.test(text)) return "missing X bearer token";
  if (/unauthorized|http 401/i.test(text)) return "unauthorized / http 401";
  if (/forbidden|http 403/i.test(text)) return "forbidden / http 403";
  if (/timeout/i.test(text)) return "timeout";
  return text.replace(/account_id\s*[:=]\s*\d+/ig, "account_id:redacted").slice(0, 140);
}

function isCriticalXApiReason(reason) {
  return /\b(402|429|403|401|CreditsDepleted|rate limited|quota|credit|usagecap|usage cap|insufficient|payment|required|billing|subscription|unauthorized|forbidden|missing bearer token)\b/i.test(String(reason || ""));
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
