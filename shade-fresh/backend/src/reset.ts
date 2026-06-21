/**
 * One-off: un-jam / reset the Shade book. Undelegates from the ER if needed, then
 * re-initializes the book (clears fills, orders, and settledSeq). Run when settlement
 * is stuck (e.g. an unsettleable fill blocking the queue).
 *
 * STOP the maker + crank first so they don't fight the reset:
 *   pm2 stop shade-maker shade-crank   (on the VPS)   — or just run this locally
 *   npm run reset
 */
import { BN } from "@coral-xyz/anchor";
import { makeCtx, sendOnER, bookOnBase, quoteMint, NATIVE_MINT, log, sleep, Ctx } from "./config";

async function waitBase(ctx: Ctx, ms = 60000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await bookOnBase(ctx)) return true; await sleep(2000); }
  return false;
}

async function main() {
  const ctx = makeCtx();
  const usdc = quoteMint();
  log("RESET book:", ctx.book.toBase58());

  if (!(await bookOnBase(ctx))) {
    log("book is delegated → committing + undelegating from the ER…");
    try { await sendOnER(ctx, await ctx.erProgram.methods.settleAndUndelegate().accounts({ payer: ctx.kp.publicKey, book: ctx.book }).transaction()); }
    catch (e: any) { log("  undelegate err (continuing):", (e.message || e).toString().slice(0, 120)); }
    log("  waiting for it to land on base…");
    if (!(await waitBase(ctx))) { log("  still delegated after 60s — aborting"); process.exit(1); }
  }
  log("book on base ✓ — re-initializing (clears fills/orders/settledSeq)…");
  const sig = await ctx.program.methods.initializeBook(new BN(100), new BN(1))
    .accounts({ authority: ctx.kp.publicKey, baseMint: NATIVE_MINT, quoteMint: usdc })
    .rpc({ skipPreflight: true });
  log("  reset tx:", sig);

  const b: any = await (ctx.program.account as any).orderBook.fetch(ctx.book);
  log(`done ✓  seq:${Number(b.seq)} settledSeq:${Number(b.settledSeq)} bids:${b.bids.length} asks:${b.asks.length} fills:${b.fills.length}`);
  log("now restart the maker + crank: pm2 restart shade-maker shade-crank");
}
main().catch((e) => { console.error(e); process.exit(1); });
