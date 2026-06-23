import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-sol-pnl-"));
process.env.MERIDIAN_DATA_DIR = tmp;

const { recordPerformance } = await import("../lessons.js");

test("recordPerformance persists exact SOL PnL fields when close data includes SOL deposits/withdrawals/fees", async () => {
  await recordPerformance({
    position: "pos-sol-pnl-test",
    pool: "pool-sol-pnl-test",
    pool_name: "SOLPNL-SOL",
    base_mint: "base-mint-test",
    strategy: "bid_ask",
    bin_range: { min: -10, max: 10 },
    bin_step: 100,
    volatility: 2.5,
    fee_tvl_ratio: 0.2,
    organic_score: 70,
    amount_sol: 0.2,
    fees_earned_usd: 0.000559540481114327,
    fees_earned_sol: 0.000008134490454228137,
    final_value_usd: 13.757654037085707,
    initial_value_usd: 13.75864058373985,
    final_value_sol: 0.199999949,
    initial_value_sol: 0.199999974,
    minutes_in_range: 30,
    minutes_held: 35,
    close_reason: "test exact SOL persistence",
  });

  const lessons = JSON.parse(fs.readFileSync(path.join(tmp, "lessons.json"), "utf8"));
  const entry = lessons.performance.at(-1);

  assert.equal(entry.pnl_usd, 0, "USD PnL remains rounded to cents for legacy reports");
  assert.equal(entry.pnl_pct, 0, "legacy pct remains USD-based and rounded to two decimals");
  assert.equal(entry.initial_value_sol, 0.199999974);
  assert.equal(entry.final_value_sol, 0.199999949);
  assert.equal(entry.fees_earned_sol, 0.000008134);
  assert.equal(entry.pnl_sol, 0.000008109);
  assert.equal(entry.net_sol, 0.000008109);
  assert.equal(entry.pnl_basis, "sol");
  assert.equal(entry.pnl_sol_pct, 0.004055);

  const memory = JSON.parse(fs.readFileSync(path.join(tmp, "pool-memory.json"), "utf8"));
  const deploy = memory["pool-sol-pnl-test"].deploys.at(-1);
  assert.equal(deploy.pnl_sol, entry.pnl_sol);
  assert.equal(deploy.net_sol, entry.net_sol);
  assert.equal(deploy.fees_earned_sol, entry.fees_earned_sol);
});

test("recordPerformance does not fake SOL PnL fields when exact SOL close data is absent", async () => {
  await recordPerformance({
    position: "pos-no-sol-pnl-test",
    pool: "pool-no-sol-pnl-test",
    pool_name: "NOSOL-SOL",
    base_mint: "base-mint-test",
    strategy: "bid_ask",
    bin_range: { min: -10, max: 10 },
    bin_step: 100,
    volatility: 2.5,
    fee_tvl_ratio: 0.2,
    organic_score: 70,
    amount_sol: 0.2,
    fees_earned_usd: 0.05,
    fees_earned_sol: null,
    final_value_usd: 13.9,
    initial_value_usd: 14,
    final_value_sol: null,
    initial_value_sol: null,
    minutes_in_range: 10,
    minutes_held: 12,
    close_reason: "test no exact SOL data",
  });

  const lessons = JSON.parse(fs.readFileSync(path.join(tmp, "lessons.json"), "utf8"));
  const entry = lessons.performance.at(-1);
  assert.equal(entry.pnl_sol, undefined);
  assert.equal(entry.net_sol, undefined);
  assert.equal(entry.pnl_basis, undefined);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
