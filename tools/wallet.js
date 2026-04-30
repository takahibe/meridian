import {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";

let _connection = null;
let _wallet = null;

function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";
const SOL_MINT = "So11111111111111111111111111111111111111112";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Direct RPC lookup for a single token balance by mint. Use as a fallback when
 * Helius /balances omits newly-minted pump.fun-style tokens. Returns ui-denominated
 * balance (number) or 0 if no account / zero balance.
 */
export async function getTokenBalanceByMint(mint) {
  try {
    const walletPk = getWallet().publicKey;
    const mintPk = new PublicKey(mint);
    const res = await getConnection().getParsedTokenAccountsByOwner(walletPk, { mint: mintPk });
    let total = 0;
    for (const acct of res.value || []) {
      const info = acct.account?.data?.parsed?.info;
      const ui = info?.tokenAmount?.uiAmount;
      if (typeof ui === "number" && Number.isFinite(ui)) total += ui;
    }
    return total;
  } catch (e) {
    log("wallet_warn", `getTokenBalanceByMint(${mint.slice(0, 8)}) failed: ${e.message}`);
    return 0;
  }
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Falls back to direct RPC SOL balance if Helius is unavailable.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  let solPrice = 0;
  try {
    const priceRes = await fetch(`${JUPITER_PRICE_API}?ids=${config.tokens.SOL}`);
    if (priceRes.ok) {
      const priceData = await priceRes.json();
      solPrice = priceData?.[config.tokens.SOL]?.usdPrice || 0;
    }
  } catch { /* price fetch failure is non-fatal */ }

  const buildBalanceResult = ({ solBalance, tokens = [], usdc = 0, error = null, source }) => {
    const roundedSol = Math.round(solBalance * 1e6) / 1e6;
    const solUsd = roundedSol * solPrice;
    return {
      wallet: walletAddress,
      sol: roundedSol,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdc * 100) / 100,
      tokens,
      total_usd: Math.round(solUsd * 100) / 100,
      ...(error ? { error } : {}),
      ...(source ? { source } : {}),
    };
  };

  const fallbackRpcBalance = async (cause) => {
    try {
      const lamports = await getConnection().getBalance(getWallet().publicKey, "confirmed");
      log("wallet_warn", `Helius balance lookup failed, using RPC fallback: ${cause}`);
      return buildBalanceResult({
        solBalance: lamports / LAMPORTS_PER_SOL,
        tokens: [],
        usdc: 0,
        error: `Helius unavailable, SOL from RPC fallback: ${cause}`,
        source: "rpc_fallback",
      });
    } catch (rpcError) {
      log("wallet_error", `RPC fallback failed after Helius error: ${rpcError.message}`);
      return buildBalanceResult({
        solBalance: 0,
        tokens: [],
        usdc: 0,
        error: `Helius failed (${cause}); RPC fallback failed (${rpcError.message})`,
        source: "error",
      });
    }
  };

  const HELIUS_KEY = process.env.HELIUS_API_KEY;
  if (!HELIUS_KEY) {
    log("wallet_warn", "HELIUS_API_KEY not set in .env, using RPC fallback for SOL balance");
    return fallbackRpcBalance("Helius API key missing");
  }

  try {
    const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/balances?api-key=${HELIUS_KEY}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Helius API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    if (typeof data?.nativeBalance !== "number") {
      throw new Error("Helius response missing nativeBalance");
    }

    const solBalance = data.nativeBalance / LAMPORTS_PER_SOL;
    const rawTokens = Array.isArray(data.tokens) ? data.tokens : [];
    const usdcEntry = rawTokens.find(t => t.mint === config.tokens.USDC);
    const usdcBalance = usdcEntry
      ? usdcEntry.amount / Math.pow(10, usdcEntry.decimals ?? 6)
      : 0;
    const enrichedTokens = rawTokens.map(t => ({
      mint: t.mint,
      symbol: t.tokenAccount?.slice(0, 8) ?? t.mint.slice(0, 8),
      balance: t.amount / Math.pow(10, t.decimals ?? 0),
      usd: null,
    }));

    return buildBalanceResult({
      solBalance,
      tokens: enrichedTokens,
      usdc: usdcBalance,
      source: "helius",
    });
  } catch (error) {
    log("wallet_error", error.message);
    return fallbackRpcBalance(error.message);
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
function amountToUi(amountRaw, decimals) {
  const rawNum = Number(amountRaw);
  if (!Number.isFinite(rawNum)) return amountRaw ?? null;
  const scale = Math.pow(10, Number(decimals) || 0);
  if (!Number.isFinite(scale) || scale <= 0) return rawNum;
  return rawNum / scale;
}

async function getMintDecimals(mint) {
  if (!mint || mint === SOL_MINT) return 9;
  try {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(mint));
    return mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
  } catch {
    return 9;
  }
}

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
  slippageBps,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount, slippageBps },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();
    const connection = getConnection();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      const mintInfo = await connection.getParsedAccountInfo(new PublicKey(input_mint));
      decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    if (Number.isFinite(Number(slippageBps)) && Number(slippageBps) > 0) {
      search.set("slippageBps", String(Math.floor(Number(slippageBps))));
    }
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    const orderRes = await fetch(orderUrl, {
      headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
    });
    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
      },
      body: JSON.stringify({ signedTransaction: signedTx, requestId }),
    });
    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    const inputDecimals = await getMintDecimals(input_mint);
    const outputDecimals = await getMintDecimals(output_mint);

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: amountToUi(result.inputAmountResult, inputDecimals),
      amount_out: amountToUi(result.outputAmountResult, outputDecimals),
      amount_in_raw: result.inputAmountResult,
      amount_out_raw: result.outputAmountResult,
      input_decimals: inputDecimals,
      output_decimals: outputDecimals,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Attempt to sweep each pending auto-swap-failed token back to SOL.
 * Called from the management cycle. Silent on empty queue.
 * Drops entries after too many failed attempts so the queue doesn't grow unbounded.
 */
export async function sweepPendingTokens() {
  const { getPendingSweeps, markSweepAttempt, clearPendingSweep } = await import("../state.js");
  const pending = getPendingSweeps();
  if (!pending.length) return { swept: 0, attempted: 0, dropped: 0 };

  const SOL_MINT = config.tokens.SOL;
  const slippageBps = config.management.autoSwapSlippageBps ?? 1500;
  const maxAttempts = Math.max(3, config.management.autoSwapRetries ?? 3) * 3;

  let swept = 0;
  let attempted = 0;
  let dropped = 0;

  for (const entry of pending) {
    if ((entry.attempts || 0) >= maxAttempts) {
      log("sweep_warn", `Dropping ${entry.label} after ${entry.attempts} failed sweeps`);
      clearPendingSweep(entry.mint);
      dropped++;
      continue;
    }
    const balance = await getTokenBalanceByMint(entry.mint).catch(() => 0);
    if (balance <= 0) {
      // Token is gone (manually swapped or transferred) — clear entry.
      log("sweep", `${entry.label}: zero balance, clearing queue entry`);
      clearPendingSweep(entry.mint);
      continue;
    }
    attempted++;
    markSweepAttempt(entry.mint);
    log("sweep", `Sweeping ${balance} ${entry.label} → SOL (slippage ${slippageBps}bps, attempt ${entry.attempts + 1})`);
    const swap = await swapToken({ input_mint: entry.mint, output_mint: SOL_MINT, amount: balance, slippageBps });
    if (swap?.success) {
      swept++;
      clearPendingSweep(entry.mint);
      log("sweep", `Swept ${entry.label} successfully (tx ${swap.tx?.slice(0, 12)}...)`);
    } else {
      log("sweep_warn", `Sweep failed for ${entry.label}: ${swap?.error || "unknown"}`);
    }
  }
  if (swept || attempted || dropped) {
    log("sweep", `Cycle done: ${swept} swept, ${attempted - swept} failed, ${dropped} dropped`);
  }
  return { swept, attempted, dropped };
}
