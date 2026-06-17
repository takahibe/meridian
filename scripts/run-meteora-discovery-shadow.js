#!/usr/bin/env node
// Manually run the autoresearch-only Meteora Pool Discovery shadow probe.
// Example:
//   MERIDIAN_PROFILE=autoresearch MERIDIAN_DATA_DIR=profiles/autoresearch MERIDIAN_RESEARCH_RUN_ID=run-002 node scripts/run-meteora-discovery-shadow.js --json

import { runMeteoraDiscoveryShadowProbe } from "../tools/meteora-discovery-shadow.js";

const record = await runMeteoraDiscoveryShadowProbe({
  cycleId: `manual-${Date.now()}`,
  mainSource: "manual",
  mainCandidates: [],
});

if (!record) {
  console.error("Meteora discovery shadow probe is disabled. Set MERIDIAN_PROFILE=autoresearch and autoresearch.meteoraDiscoveryShadowEnabled=true.");
  process.exit(2);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(record, null, 2));
} else {
  console.log("Meteora discovery shadow probe");
  console.log(`run=${record.run_id} timeframe=${record.timeframe} category=${record.category}`);
  console.log(`api_total=${record.api_total} returned=${record.summary.returned} yunus_match=${record.summary.yunus_match} sol=${record.summary.sol_quote}`);
  console.log("Top:");
  for (const c of record.candidates.slice(0, 10)) {
    console.log(`- ${c.name}: score=${c.yunus_score}/${c.yunus_score_max}, match=${c.yunus_match}, fee/tvl=${c.fee_active_tvl_ratio}%, vol=${c.volatility}, open=${c.open_positions}, quote=${c.quote_symbol}`);
  }
}
