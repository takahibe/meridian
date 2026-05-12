import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "../config.js";
import { log } from "../logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, "..", "x-narrative-cache.json");
const SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
const cache = loadPersistentCache();

const CONFIDENCE_SCORE = {
  unknown: 0,
  absent: 1,
  weak: 2,
  moderate: 3,
  strong: 4,
};

export function confidenceScore(level) {
  return CONFIDENCE_SCORE[String(level || "unknown").toLowerCase()] ?? 0;
}

export async function getXNarrativeSignal({ symbol, contract, mint } = {}) {
  const token = String(contract || mint || "").trim();
  const sym = String(symbol || "").trim().toUpperCase();
  const cacheKey = `${token}:${sym}`;
  const ttlMs = Math.max(1, Number(config.screening.xApiCacheMinutes || 5)) * 60_000;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < ttlMs) {
    const ageMs = Date.now() - cached.at;
    const ageHours = Math.round(ageMs / 3_600_000);
    let value = { ...cached.value, cached: true, cached_at: new Date(cached.at).toISOString() };
    const freshHours = Math.max(1, Number(config.screening.xNarrativeFreshHours || 24));
    const conf = String(value.narrative_confidence || "unknown").toLowerCase();
    if (ageMs > freshHours * 3_600_000 && ["moderate", "strong"].includes(conf)) {
      value = {
        ...value,
        original_narrative_confidence: value.narrative_confidence,
        narrative_confidence: "weak",
        x_narrative_score: confidenceScore("weak"),
        stale: true,
        reason: `cached X narrative is ${ageHours}h old; downgraded after ${freshHours}h freshness window`,
      };
    }
    log("x_narrative", `${sym || token || "token"}: cache hit (${ageHours}h old${value.stale ? ", stale-downgraded" : ""})`);
    return value;
  }

  const bearer = process.env.X_BEARER_TOKEN;
  if (!bearer) {
    const value = unknownResult(sym || token, "missing bearer token");
    storeCache(cacheKey, value);
    return value;
  }

  const query = buildQuery(sym, token);
  if (!query) {
    const value = unknownResult(sym || token, "missing symbol/contract");
    storeCache(cacheKey, value);
    return value;
  }

  const params = new URLSearchParams({
    query,
    max_results: String(config.screening.xApiMaxResults || 10),
    "tweet.fields": "created_at,public_metrics,author_id",
    expansions: "author_id",
    "user.fields": "verified,public_metrics,created_at",
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.screening.xApiTimeoutMs || 4000));
  try {
    const res = await fetch(`${SEARCH_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    });

    if (res.status === 429) {
      const value = unknownResult(sym || token, "rate limited");
      storeCache(cacheKey, value);
      return value;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const value = unknownResult(sym || token, `http ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
      storeCache(cacheKey, value);
      return value;
    }

    const data = await res.json();

    // X API credit exhaustion: returns 200 with errors array, code 161 = credits depleted.
    // Return "unknown" so the screening funnel fail-open triggers instead of
    // treating empty results as "absent" narrative (which would incorrectly pass).
    if (Array.isArray(data.errors) && data.errors.some((e) => e.code === 161 || /credit|depleted/i.test(e.message || ""))) {
      const value = unknownResult(sym || token, "http 402: CreditsDepleted");
      storeCache(cacheKey, value);
      return value;
    }

    const tweets = Array.isArray(data.data) ? data.data : [];
    const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));
    const value = analyzeNarrative({ symbol: sym, contract: token, tweets, users });
    storeCache(cacheKey, value);
    return value;
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : error?.message || "request failed";
    const value = unknownResult(sym || token, reason);
    storeCache(cacheKey, value);
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function analyzeNarrative({ symbol, contract, tweets, users }) {
  const now = Date.now();
  const within24h = [];
  const prior24h = [];
  const lowQualityTimes = [];
  const qualityScores = [];

  for (const tweet of tweets) {
    const createdAt = Date.parse(tweet.created_at || 0);
    if (!Number.isFinite(createdAt)) continue;
    const ageMs = now - createdAt;
    const user = users.get(tweet.author_id) || {};
    const followers = Number(user.public_metrics?.followers_count || 0);
    const verified = Boolean(user.verified);
    const engagement = Number(tweet.public_metrics?.like_count || 0) + Number(tweet.public_metrics?.retweet_count || 0);
    const quality = computeAccountQuality({ followers, verified, engagement });
    qualityScores.push(quality);

    if (ageMs <= 24 * 60 * 60 * 1000) {
      within24h.push(tweet);
      if (quality < 0.25) lowQualityTimes.push(createdAt);
    } else if (ageMs <= 48 * 60 * 60 * 1000) {
      prior24h.push(tweet);
    }
  }

  const posts24h = within24h.length;
  const postsPrev24h = prior24h.length;
  const velocityRatio = postsPrev24h > 0 ? posts24h / postsPrev24h : (posts24h > 0 ? posts24h : 0);
  const accountQualityScore = qualityScores.length > 0
    ? Number((qualityScores.reduce((sum, n) => sum + n, 0) / qualityScores.length).toFixed(3))
    : 0;
  const shillBurstFlag = hasShillBurst(lowQualityTimes);

  let narrativeConfidence = "absent";
  if (posts24h === 0 && postsPrev24h === 0) {
    narrativeConfidence = "absent";
  } else if (shillBurstFlag) {
    narrativeConfidence = "weak";
  } else if (posts24h >= 8 && (accountQualityScore >= 0.5 || velocityRatio >= 1.5)) {
    narrativeConfidence = "strong";
  } else if (posts24h >= 3 && accountQualityScore >= 0.28) {
    narrativeConfidence = "moderate";
  } else {
    narrativeConfidence = "weak";
  }

  const result = {
    symbol,
    contract,
    source: "x_recent_search",
    posts_24h: posts24h,
    posts_prev_24h: postsPrev24h,
    post_velocity_24h: Number(velocityRatio.toFixed(2)),
    account_quality_score: accountQualityScore,
    shill_burst_flag: shillBurstFlag,
    narrative_confidence: narrativeConfidence,
    x_narrative_score: confidenceScore(narrativeConfidence),
  };
  log("x_narrative", `${symbol || contract || "token"}: confidence=${narrativeConfidence} posts24h=${posts24h} prev24h=${postsPrev24h} quality=${accountQualityScore}`);
  return result;
}

function buildQuery(symbol, contract) {
  const parts = [];
  if (symbol) {
    const clean = symbol.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    if (clean) parts.push(`\"${clean}\"`, `\"$${clean}\"`);
  }
  if (contract && contract.length >= 20) parts.push(`\"${contract}\"`);
  if (parts.length === 0) return null;
  return `(${parts.join(" OR ")}) -is:retweet -is:reply lang:en`;
}

function computeAccountQuality({ followers, verified, engagement }) {
  const followerScore = Math.min(1, Math.log10(Math.max(followers, 1)) / 5);
  const verifiedScore = verified ? 0.35 : 0;
  const engagementScore = Math.min(0.25, Math.log10(Math.max(engagement + 1, 1)) / 8);
  return Number(Math.min(1, followerScore + verifiedScore + engagementScore).toFixed(3));
}

function hasShillBurst(times = []) {
  if (times.length < 4) return false;
  const sorted = [...times].sort((a, b) => a - b);
  const windowMs = 10 * 60 * 1000;
  for (let i = 0; i < sorted.length; i++) {
    let count = 1;
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j] - sorted[i] <= windowMs) count++;
      else break;
    }
    if (count >= 4) return true;
  }
  return false;
}

function loadPersistentCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return new Map();
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return new Map(Object.entries(raw || {}));
  } catch (error) {
    log("x_narrative_warn", `cache load failed: ${error.message}`);
    return new Map();
  }
}

function storeCache(cacheKey, value) {
  cache.set(cacheKey, { at: Date.now(), value });
  try {
    const obj = Object.fromEntries(cache.entries());
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch (error) {
    log("x_narrative_warn", `cache write failed: ${error.message}`);
  }
}

function unknownResult(label, reason) {
  log("x_narrative_warn", `${label || "token"}: ${reason}`);
  return {
    source: "x_recent_search",
    narrative_confidence: "unknown",
    x_narrative_score: 0,
    shill_burst_flag: false,
    post_velocity_24h: null,
    account_quality_score: null,
    reason,
  };
}
