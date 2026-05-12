import { config } from "../config.js";
import { log } from "../logger.js";

const DEFAULT_INTERVALS = ["5_MINUTE"];
const DEFAULT_CANDLES = 298;

function getApiBase() {
  return String(config.api.url || "https://api.agentmeridian.xyz/api").replace(/\/+$/, "");
}

function getHeaders() {
  const headers = {};
  if (config.api.publicApiKey) headers["x-api-key"] = config.api.publicApiKey;
  return headers;
}

function normalizeIntervals(intervals) {
  const list = Array.isArray(intervals) ? intervals : DEFAULT_INTERVALS;
  return list
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => value === "5_MINUTE" || value === "15_MINUTE");
}

function safeNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildSignalSummary(payload) {
  const latest = payload?.latest || {};
  const candle = latest?.candle || {};
  const previousCandle = latest?.previousCandle || {};
  const rsi = safeNum(latest?.rsi?.value);
  const bollinger = latest?.bollinger || {};
  const supertrend = latest?.supertrend || {};
  const fibonacciLevels = latest?.fibonacci?.levels || {};
  return {
    close: safeNum(candle.close),
    previousClose: safeNum(previousCandle.close),
    rsi,
    lowerBand: safeNum(bollinger.lower),
    middleBand: safeNum(bollinger.middle),
    upperBand: safeNum(bollinger.upper),
    supertrendValue: safeNum(supertrend.value),
    supertrendDirection: String(supertrend.direction || "unknown"),
    supertrendBreakUp: !!latest?.states?.supertrendBreakUp,
    supertrendBreakDown: !!latest?.states?.supertrendBreakDown,
    fib50: safeNum(fibonacciLevels["0.500"]),
    fib618: safeNum(fibonacciLevels["0.618"]),
    fib786: safeNum(fibonacciLevels["0.786"]),
  };
}

function evaluatePreset(side, preset, payload) {
  const summary = buildSignalSummary(payload);
  const oversold = Number(config.indicators.rsiOversold ?? 30);
  const overbought = Number(config.indicators.rsiOverbought ?? 80);
  const close = summary.close;
  const previousClose = summary.previousClose;
  const lowerBand = summary.lowerBand;
  const upperBand = summary.upperBand;
  const rsi = summary.rsi;
  const isBullish = summary.supertrendDirection === "bullish";
  const isBearish = summary.supertrendDirection === "bearish";
  const crossedUp = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose < level &&
    close >= level;
  const crossedDown = (level) =>
    level != null &&
    close != null &&
    previousClose != null &&
    previousClose > level &&
    close <= level;

  switch (preset) {
    case "supertrend_break":
      return side === "entry"
        ? {
            confirmed: summary.supertrendBreakUp || (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue),
            reason: summary.supertrendBreakUp ? "Supertrend flipped bullish" : "Price is above bullish Supertrend",
            signal: summary,
          }
        : {
            confirmed: summary.supertrendBreakDown || (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue),
            reason: summary.supertrendBreakDown ? "Supertrend flipped bearish" : "Price is below bearish Supertrend",
            signal: summary,
          };
    case "rsi_reversal":
      return side === "entry"
        ? {
            confirmed: rsi != null && rsi <= oversold,
            reason: `RSI ${rsi ?? "n/a"} <= oversold ${oversold}`,
            signal: summary,
          }
        : {
            confirmed: rsi != null && rsi >= overbought,
            reason: `RSI ${rsi ?? "n/a"} >= overbought ${overbought}`,
            signal: summary,
          };
    case "bollinger_reversion":
      return side === "entry"
        ? {
            confirmed: close != null && lowerBand != null && close <= lowerBand,
            reason: `Close ${close ?? "n/a"} <= lower band ${lowerBand ?? "n/a"}`,
            signal: summary,
          }
        : {
            confirmed: close != null && upperBand != null && close >= upperBand,
            reason: `Close ${close ?? "n/a"} >= upper band ${upperBand ?? "n/a"}`,
            signal: summary,
          };
    case "rsi_plus_supertrend":
      return side === "entry"
        ? {
            confirmed:
              (rsi != null && rsi <= oversold) &&
              (summary.supertrendBreakUp || isBullish),
            reason: `RSI oversold with bullish Supertrend context`,
            signal: summary,
          }
        : {
            confirmed:
              (rsi != null && rsi >= overbought) &&
              (summary.supertrendBreakDown || isBearish),
            reason: `RSI overbought with bearish Supertrend context`,
            signal: summary,
          };
    case "supertrend_or_rsi":
      return side === "entry"
        ? {
            confirmed:
              summary.supertrendBreakUp ||
              (isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue) ||
              (rsi != null && rsi <= oversold),
            reason: "Supertrend bullish confirmation or RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              summary.supertrendBreakDown ||
              (isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue) ||
              (rsi != null && rsi >= overbought),
            reason: "Supertrend bearish confirmation or RSI overbought",
            signal: summary,
          };
    case "supertrend_bounce":
      // Entry logic for bid-ask bin strategy:
      // Primary  : Supertrend 15m bullish (price at/near support = bounce zone)
      // Secondary: RSI overbought on 5m OR 15m (momentum confirmation)
      // Bonus    : Supertrend 5m break = extra confidence (not required)
      if (side === "entry") {
        const stBreakUp = summary.supertrendBreakUp;
        const stBullish = isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue;
        const rsiOversold = rsi != null && rsi <= oversold;
        const st5mBreak = payload?.latest?.states?.supertrendBreakUp && payload?.interval === "5_MINUTE";
        // Build layered reasons
        const layers = [];
        if (stBreakUp) layers.push("ST 15m break-up");
        else if (stBullish) layers.push("ST 15m bullish");
        if (rsiOversold) layers.push(`RSI ${rsi} oversold`);
        if (st5mBreak) layers.push("ST 5m break (bonus)");
        const reason = layers.length > 0 ? layers.join(" + ") : "No confirmation yet";
        return {
          confirmed: (stBreakUp || stBullish) && rsiOversold,
          reason,
          signal: summary,
        };
      } else {
        // Exit flips based on 15m trend:
        // ST 15m bearish → exit at Bollinger middle band (+ RSI overbought = confirm)
        // ST 15m bullish → exit at Bollinger upper band (+ RSI overbought = confirm)
        // ST 15m bearish break = immediate exit regardless
        const stBearish = isBearish && close != null && summary.supertrendValue != null && close <= summary.supertrendValue;
        const stBullish = isBullish && close != null && summary.supertrendValue != null && close >= summary.supertrendValue;
        const bbMiddleTouched = close != null && summary.middleBand != null && close >= summary.middleBand;
        const bbUpperTouched = close != null && summary.upperBand != null && close >= summary.upperBand;
        const rsiOverbought = rsi != null && rsi >= overbought;
        const layers = [];
        if (summary.supertrendBreakDown) layers.push("ST 15m break-down (exit now)");
        else if (stBearish) layers.push("ST 15m bearish");
        else if (stBullish) layers.push("ST 15m bullish");
        if (bbMiddleTouched) layers.push(`BB mid ${summary.middleBand?.toFixed(4)}`);
        if (bbUpperTouched) layers.push(`BB upper ${summary.upperBand?.toFixed(4)}`);
        if (rsiOverbought) layers.push(`RSI ${rsi} overbought`);
        return {
          confirmed: summary.supertrendBreakDown || (stBearish && bbMiddleTouched) || (stBullish && bbUpperTouched && rsiOverbought),
          reason: layers.length > 0 ? layers.join(" | ") : "No exit signal yet",
          signal: summary,
        };
      }
    case "bb_plus_rsi":
      return side === "entry"
        ? {
            confirmed:
              close != null &&
              lowerBand != null &&
              close <= lowerBand &&
              rsi != null &&
              rsi <= oversold,
            reason: "Close at/below lower band with RSI oversold",
            signal: summary,
          }
        : {
            confirmed:
              close != null &&
              upperBand != null &&
              close >= upperBand &&
              rsi != null &&
              rsi >= overbought,
            reason: "Close at/above upper band with RSI overbought",
            signal: summary,
          };
    case "fibo_reclaim":
      return side === "entry"
        ? {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50) ||
              crossedUp(summary.fib786),
            reason: "Price reclaimed a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedUp(summary.fib618) ||
              crossedUp(summary.fib50),
            reason: "Price reclaimed a key Fibonacci level upward",
            signal: summary,
          };
    case "fibo_reject":
      return side === "entry"
        ? {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50),
            reason: "Price rejected from a key Fibonacci level",
            signal: summary,
          }
        : {
            confirmed:
              crossedDown(summary.fib618) ||
              crossedDown(summary.fib50) ||
              crossedDown(summary.fib786),
            reason: "Price rejected below a key Fibonacci level",
            signal: summary,
          };
    default:
      return {
        confirmed: false,
        reason: `Unknown preset ${preset}`,
        signal: summary,
      };
  }
}

export async function fetchChartIndicatorsForMint(
  mint,
  {
    interval,
    candles = config.indicators.candles ?? DEFAULT_CANDLES,
    rsiLength = config.indicators.rsiLength ?? 2,
    refresh = false,
  } = {},
) {
  const normalizedInterval = String(interval || "15_MINUTE").trim().toUpperCase();
  const search = new URLSearchParams({
    interval: normalizedInterval,
    candles: String(candles),
    rsiLength: String(rsiLength),
  });
  if (refresh) search.set("refresh", "1");

  const res = await fetch(`${getApiBase()}/chart-indicators/${mint}?${search.toString()}`, {
    headers: getHeaders(),
  });
  const text = await res.text().catch(() => "");
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new Error(payload?.error || `chart indicators ${res.status}`);
  }
  return payload;
}

export async function confirmIndicatorPreset({
  mint,
  side,
  preset = side === "entry" ? config.indicators.entryPreset : config.indicators.exitPreset,
  intervals = config.indicators.intervals,
  refresh = false,
} = {}) {
  if (!config.indicators.enabled || !mint || !preset) {
    return { enabled: false, confirmed: true, reason: "Indicators disabled or not configured", intervals: [] };
  }

  const targets = normalizeIntervals(intervals);
  if (targets.length === 0) {
    return { enabled: false, confirmed: true, reason: "No indicator intervals configured", intervals: [] };
  }

  const results = [];
  for (const interval of targets) {
    try {
      const payload = await fetchChartIndicatorsForMint(mint, { interval, refresh });
      const evaluation = evaluatePreset(side, preset, payload);
      results.push({
        interval,
        ok: true,
        confirmed: !!evaluation.confirmed,
        reason: evaluation.reason,
        signal: evaluation.signal,
        latest: payload?.latest || null,
      });
    } catch (error) {
      log("indicators_warn", `Indicator fetch failed for ${mint.slice(0, 8)} ${interval}: ${error.message}`);
      results.push({
        interval,
        ok: false,
        confirmed: null,
        reason: error.message,
        signal: null,
        latest: null,
      });
    }
  }

  const successful = results.filter((entry) => entry.ok);
  if (successful.length === 0) {
    return {
      enabled: true,
      confirmed: true,
      skipped: true,
      preset,
      side,
      reason: "Indicator API unavailable; falling back to existing logic",
      intervals: results,
    };
  }

  // ── Hierarchical combination for supertrend_bounce ──────────────────────────
  // 15m supertrend bullish = primary entry condition (price at support = bounce zone)
  // RSI overbought on 5m OR 15m = secondary momentum confirmation
  // ST 5m break = bonus confidence (not required, just logged)
  // For exits: BB upper band + RSI overbought on 15m, or ST 15m bearish reversal
  if (preset === "supertrend_bounce") {
    const m15 = successful.find((e) => e.interval === "15_MINUTE");
    const m5 = successful.find((e) => e.interval === "5_MINUTE");

    if (side === "entry") {
      // Primary: 15m supertrend must be bullish (break or price above line)
      const m15StBullish = m15 && (m15.signal?.supertrendBreakUp || (m15.signal?.supertrendDirection === "bullish" && m15.signal?.close != null && m15.signal?.supertrendValue != null && m15.signal.close >= m15.signal.supertrendValue));
      // Secondary: RSI overbought on 5m OR 15m
      const m15RsiOb = m15 && m15.signal?.rsi != null && m15.signal.rsi >= (config.indicators.rsiOverbought ?? 80);
      const m5RsiOb = m5 && m5.signal?.rsi != null && m5.signal.rsi >= (config.indicators.rsiOverbought ?? 80);
      const rsiOverbought = m15RsiOb || m5RsiOb;
      // Bonus: ST 5m break
      const st5mBreak = m5?.signal?.supertrendBreakUp;

      if (m15StBullish && rsiOverbought) {
        const rsiVal = m15RsiOb ? m15.signal.rsi : m5.signal.rsi;
        return {
          enabled: true,
          confirmed: true,
          skipped: false,
          preset,
          side,
          requireAllIntervals: false,
          reason: st5mBreak
            ? `ST 15m bullish + RSI ${rsiVal} overbought + ST 5m break (full confirmation)`
            : `ST 15m bullish + RSI ${rsiVal} overbought (entry confirmed)`,
          intervals: results,
        };
      }
      if (m15StBullish && !rsiOverbought) {
        return {
          enabled: true,
          confirmed: false,
          skipped: false,
          preset,
          side,
          requireAllIntervals: false,
          reason: `ST 15m bullish (primary) but no RSI overbought on 5m or 15m — waiting for RSI confirmation`,
          intervals: results,
        };
      }
      return {
        enabled: true,
        confirmed: false,
        skipped: false,
        preset,
        side,
        requireAllIntervals: false,
        reason: `ST 15m not bullish. ${m15 ? `15m: ${m15.reason}` : "15m: no data"} ${m5 ? `| 5m: ${m5.reason}` : ""}`,
        intervals: results,
      };
    }

    if (side === "exit") {
      // Exit targets flip based on 15m trend direction:
      // ST 15m bearish  → exit at Bollinger MIDDLE band (take profit earlier, protect from reversal)
      // ST 15m bullish → exit at Bollinger UPPER band (let position ride the uptrend)
      // Supertrend 15m bearish break = immediate exit regardless of BB
      const stBearishM15 = m15 && (m15.signal?.supertrendBreakDown || (m15.signal?.supertrendDirection === "bearish" && m15.signal?.close != null && m15.signal?.supertrendValue != null && m15.signal.close <= m15.signal.supertrendValue));
      const stBullishM15 = m15 && (m15.signal?.supertrendBreakUp || (m15.signal?.supertrendDirection === "bullish" && m15.signal?.close != null && m15.signal?.supertrendValue != null && m15.signal.close >= m15.signal.supertrendValue));
      const bbMiddleM15 = m15 && m15.signal?.close != null && m15.signal?.middleBand != null && m15.signal.close >= m15.signal.middleBand;
      const bbUpperM15 = m15 && m15.signal?.close != null && m15.signal?.upperBand != null && m15.signal.close >= m15.signal.upperBand;
      const rsiObM15 = m15 && m15.signal?.rsi != null && m15.signal.rsi >= (config.indicators.rsiOverbought ?? 80);

      // Supertrend 15m bearish break = immediate exit (trend reversal)
      if (stBearishM15 && m15.signal?.supertrendBreakDown) {
        return {
          enabled: true,
          confirmed: true,
          skipped: false,
          preset,
          side,
          requireAllIntervals: false,
          reason: `ST 15m bearish break — immediate exit (trend reversed)`,
          intervals: results,
        };
      }

      if (stBearishM15) {
        // Bearish: exit at middle band + RSI overbought (confirm momentum peak)
        if (bbMiddleM15 && rsiObM15) {
          return {
            enabled: true,
            confirmed: true,
            skipped: false,
            preset,
            side,
            requireAllIntervals: false,
            reason: `ST 15m bearish + BB middle touched + RSI ${m15.signal.rsi} overbought — exit (take profit)`,
            intervals: results,
          };
        }
        if (bbMiddleM15) {
          return {
            enabled: true,
            confirmed: true,
            skipped: false,
            preset,
            side,
            requireAllIntervals: false,
            reason: `ST 15m bearish + BB middle touched — exit (partial signal, taking profit)`,
            intervals: results,
          };
        }
        return {
          enabled: true,
          confirmed: false,
          skipped: false,
          preset,
          side,
          requireAllIntervals: false,
          reason: `ST 15m bearish but BB middle not touched (${m15.signal?.middleBand?.toFixed(4) ?? "n/a"}). Waiting.`,
          intervals: results,
        };
      }

      if (stBullishM15) {
        // Bullish: exit at upper band + RSI overbought (uptrend exhausted)
        if (bbUpperM15 && rsiObM15) {
          return {
            enabled: true,
            confirmed: true,
            skipped: false,
            preset,
            side,
            requireAllIntervals: false,
            reason: `ST 15m bullish + BB upper touched + RSI ${m15.signal.rsi} overbought — exit (uptrend stretched)`,
            intervals: results,
          };
        }
        return {
          enabled: true,
          confirmed: false,
          skipped: false,
          preset,
          side,
          requireAllIntervals: false,
          reason: `ST 15m bullish — holding. BB upper=${m15.signal?.upperBand?.toFixed(4) ?? "n/a"}, RSI=${m15.signal?.rsi ?? "n/a"}`,
          intervals: results,
        };
      }

      return {
        enabled: true,
        confirmed: false,
        skipped: false,
        preset,
        side,
        requireAllIntervals: false,
        reason: `ST 15m direction unclear. ${m15 ? `RSI=${m15.signal?.rsi ?? "n/a"}, BB mid=${m15.signal?.middleBand?.toFixed(4) ?? "n/a"}, BB upper=${m15.signal?.upperBand?.toFixed(4) ?? "n/a"}` : "15m: no data"}`,
        intervals: results,
      };
    }
  }

  const requireAll = !!config.indicators.requireAllIntervals;
  const confirmed = requireAll
    ? successful.every((entry) => entry.confirmed)
    : successful.some((entry) => entry.confirmed);

  return {
    enabled: true,
    confirmed,
    skipped: false,
    preset,
    side,
    requireAllIntervals: requireAll,
    reason: confirmed
      ? `${preset} confirmed on ${successful.filter((entry) => entry.confirmed).map((entry) => entry.interval).join(", ")}`
      : `${preset} not confirmed on ${successful.map((entry) => entry.interval).join(", ")}`,
    intervals: results,
  };
}
