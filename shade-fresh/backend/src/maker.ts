/**
 * Shade market maker. Continuously quotes a ladder of bids + asks around the live
 * SOL/USDC price on the Ephemeral Rollup, so any visitor always has a counterparty.
 *
 * It keeps its own credited inventory topped up (mints mock USDC — the maker wallet
 * is the USDC mint authority — and wraps SOL into wSOL as needed) so every fill it
 * takes can actually settle.
 *
 *   npm run maker
 *   pm2 start ecosystem.config.cjs --only shade-maker
 *
 * The maker wallet is normally the SAME wallet as the crank (the program authority /
 * USDC mint authority). It never self-crosses because bids always sit below asks.
 */
import { BN } from "@coral-xyz/anchor";
import { SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import {
  makeCtx, sendOnER, bookOnBase, log, sleep, quoteMint, NATIVE_MINT,
  SIDE_BID, SIDE_ASK, BASE_LAMPORTS_PER_SIZE, Ctx,
} from "./config";

// ---- tunables (env-overridable) ----
const LEVELS = Number(process.env.MM_LEVELS || 4);          // price levels per side
const SIZE_UNITS = Number(process.env.MM_SIZE || 10);       // size per level (10 = 0.01 SOL)
const SPREAD_BPS = Number(process.env.MM_SPREAD_BPS || 8);  // half-spread of the innermost level
const STEP_BPS = Number(process.env.MM_STEP_BPS || 6);      // gap between successive levels
const REQUOTE_BPS = Number(process.env.MM_REQUOTE_BPS || 12); // re-centre when mid drifts this far
const TICK_MS = Number(process.env.MM_TICK_MS || 7000);
const MIN_BASE_LAMPORTS = Number(process.env.MM_MIN_BASE_SOL || 0.1) * LAMPORTS_PER_SOL;
const MIN_QUOTE_MICRO = Number(process.env.MM_MIN_QUOTE_USDC || 50) * 1e6;
const TOPUP_BASE_SOL = Number(process.env.MM_TOPUP_BASE_SOL || 0.3);
const TOPUP_QUOTE_USDC = Number(process.env.MM_TOPUP_QUOTE_USDC || 200);

const bps = (n: number, b: number) => n * (1 + b / 10000);

async function livePrice(): Promise<number | null> {
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    if (!r.ok) return null;
    const d: any = await r.json();
    const p = Number(d.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

async function fetchBalance(ctx: Ctx): Promise<{ baseFree: number; quoteFree: number } | null> {
  try {
    const b: any = await (ctx.program.account as any).userBalance.fetch(ctx.balPda(ctx.kp.publicKey));
    return { baseFree: Number(b.baseFree), quoteFree: Number(b.quoteFree) };
  } catch { return null; }
}

/** Make sure the maker has a UserBalance ledger + enough credited base/quote to settle its quotes. */
async function ensureInventory(ctx: Ctx) {
  const me = ctx.kp.publicKey;
  const usdc = quoteMint();
  let bal = await fetchBalance(ctx);

  // init the ledger once
  if (!bal) {
    log("maker: init_user…");
    await ctx.program.methods.initUser()
      .accounts({ book: ctx.book, userBalance: ctx.balPda(me), owner: me, systemProgram: SystemProgram.programId })
      .rpc({ skipPreflight: true });
    bal = { baseFree: 0, quoteFree: 0 };
  }

  // top up wSOL (base) by wrapping native SOL
  if (bal.baseFree < MIN_BASE_LAMPORTS) {
    const lamports = Math.round(TOPUP_BASE_SOL * LAMPORTS_PER_SOL);
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, me);
    const pre: any[] = [];
    try { await getAccount(ctx.baseConn, ata); }
    catch { pre.push(createAssociatedTokenAccountInstruction(me, ata, me, NATIVE_MINT)); }
    pre.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: ata, lamports }));
    pre.push(createSyncNativeInstruction(ata));
    log(`maker: depositing ${TOPUP_BASE_SOL} wSOL inventory…`);
    await ctx.program.methods.depositBase(new BN(lamports))
      .accounts({ book: ctx.book, userBalance: ctx.balPda(me), vaultBase: ctx.vaultBase, userToken: ata, owner: me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
  }

  // top up USDC (quote) by minting mock USDC to ourselves (we are the mint authority)
  if (bal.quoteFree < MIN_QUOTE_MICRO) {
    const amount = Math.round(TOPUP_QUOTE_USDC * 1e6);
    const ata = getAssociatedTokenAddressSync(usdc, me);
    const pre: any[] = [];
    try { await getAccount(ctx.baseConn, ata); }
    catch { pre.push(createAssociatedTokenAccountInstruction(me, ata, me, usdc)); }
    pre.push(createMintToInstruction(usdc, ata, me, amount));
    log(`maker: minting + depositing ${TOPUP_QUOTE_USDC} USDC inventory…`);
    await ctx.program.methods.depositQuote(new BN(amount))
      .accounts({ book: ctx.book, userBalance: ctx.balPda(me), vaultQuote: ctx.vaultQuote, userToken: ata, owner: me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
  }
}

/** desired on-chain price levels (price = usd * 100) around a centre price */
function desiredLevels(midUsd: number) {
  const bids: number[] = [], asks: number[] = [];
  for (let i = 0; i < LEVELS; i++) {
    const off = SPREAD_BPS + i * STEP_BPS;
    bids.push(Math.round(bps(midUsd, -off) * 100));
    asks.push(Math.round(bps(midUsd, off) * 100));
  }
  return { bids, asks };
}

async function placeOrder(ctx: Ctx, side: number, price: number, size: number) {
  let err: any;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const tx = await ctx.erProgram.methods.placeOrder(side, new BN(price), new BN(size))
        .accounts({ book: ctx.book, trader: ctx.kp.publicKey }).transaction();
      return await sendOnER(ctx, tx);
    } catch (e) { err = e; await sleep(1500); }
  }
  throw err;
}
async function cancelOrder(ctx: Ctx, id: number) {
  const tx = await ctx.erProgram.methods.cancelOrder(new BN(id)).accounts({ book: ctx.book, trader: ctx.kp.publicKey }).transaction();
  return sendOnER(ctx, tx);
}

const PRICE_TOL = 2; // on-chain price units (=$0.02) — an order "matches" a desired level

/** Plan (don't execute) the reconciliation for one side: which resting orders to cancel
 *  (drifted/duplicate) and which desired prices still need an order. */
function planSide(myOrders: any[], desired: number[]): { cancels: any[]; places: number[] } {
  const used = new Set<number>();
  const cancels: any[] = [];
  for (const o of myOrders) {
    const p = Number(o.price);
    const hit = desired.find((d) => Math.abs(d - p) <= PRICE_TOL && !used.has(d));
    if (hit !== undefined) used.add(hit);
    else cancels.push(o);
  }
  return { cancels, places: desired.filter((d) => !used.has(d)) };
}

let quotedMid = 0;

async function tick(ctx: Ctx) {
  const mid = await livePrice();
  if (!mid) { log("maker: no live price, skipping"); return; }

  // the crank periodically undelegates to settle; just wait those windows out
  if (await bookOnBase(ctx)) { log("maker: book on base (settling) — waiting"); return; }

  let book: any;
  try { book = await (ctx.erProgram.account as any).orderBook.fetch(ctx.book); }
  catch { log("maker: ER read failed — waiting"); return; }

  const me = ctx.kp.publicKey.toBase58();
  const myBids = (book.bids || []).filter((o: any) => o.owner.toBase58() === me);
  const myAsks = (book.asks || []).filter((o: any) => o.owner.toBase58() === me);

  // only re-centre the desired prices when the live price drifts past tolerance — this
  // keeps target prices stable tick-to-tick so reconciliation doesn't churn needlessly.
  const drift = quotedMid ? Math.abs(mid - quotedMid) / quotedMid * 10000 : Infinity;
  if (drift > REQUOTE_BPS) quotedMid = mid;
  const { bids, asks } = desiredLevels(quotedMid);

  const bidPlan = planSide(myBids, bids);
  const askPlan = planSide(myAsks, asks);

  // CANCEL FIRST (both sides) — critical: never place a new order while a now-crossing
  // stale order on the OTHER side still rests, or the maker self-fills (buyer==seller),
  // which the program can't settle and which jams the queue.
  let cancelled = 0;
  for (const o of [...bidPlan.cancels, ...askPlan.cancels]) {
    try { await cancelOrder(ctx, Number(o.id)); cancelled++; } catch (e: any) { log("  cancel err:", (e.message || e).toString().slice(0, 60)); }
  }

  // re-read so we place against the post-cancel book (avoids racing a stale opposite side)
  let kept: any;
  try { kept = await (ctx.erProgram.account as any).orderBook.fetch(ctx.book); } catch { kept = book; }
  const restingAsk = Math.min(...(kept.asks || []).map((o: any) => Number(o.price)), Infinity);
  const restingBid = Math.max(...(kept.bids || []).map((o: any) => Number(o.price)), -Infinity);

  // PLACE — with a hard self-cross guard: a bid must stay strictly below every ask, and
  // an ask strictly above every bid (covers both desired levels and anything still resting).
  let placed = 0;
  for (const p of bidPlan.places) {
    if (p >= restingAsk || p >= Math.min(...asks)) { continue; }      // would cross an ask → skip
    try { await placeOrder(ctx, SIDE_BID, p, SIZE_UNITS); placed++; } catch (e: any) { log("  bid err:", (e.message || e).toString().slice(0, 60)); }
  }
  for (const p of askPlan.places) {
    if (p <= restingBid || p <= Math.max(...bids)) { continue; }      // would cross a bid → skip
    try { await placeOrder(ctx, SIDE_ASK, p, SIZE_UNITS); placed++; } catch (e: any) { log("  ask err:", (e.message || e).toString().slice(0, 60)); }
  }

  if (placed + cancelled) log(`maker: live ${mid.toFixed(2)} · ${drift > REQUOTE_BPS ? "re-centred" : "reconciled"} +${placed}/-${cancelled}`);
  else log(`maker: live ${mid.toFixed(2)} · depth ok (bids ${myBids.length} asks ${myAsks.length})`);
}

async function main() {
  const ctx = makeCtx();
  log("SHADE MAKER (liquidity bot)");
  log("  wallet:", ctx.kp.publicKey.toBase58());
  log("  book  :", ctx.book.toBase58());
  log(`  ${LEVELS} levels/side · size ${SIZE_UNITS} (${(SIZE_UNITS * BASE_LAMPORTS_PER_SIZE / LAMPORTS_PER_SOL)} SOL) · spread ${SPREAD_BPS}bps step ${STEP_BPS}bps\n`);
  while (true) {
    try { await ensureInventory(ctx); } catch (e: any) { log("inventory err:", (e.message || e).toString().slice(0, 120)); }
    try { await tick(ctx); } catch (e: any) { log("maker tick err:", (e.message || e).toString().slice(0, 120)); }
    await sleep(TICK_MS);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
