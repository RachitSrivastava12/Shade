/**
 * Shade settlement engine. Keeps the book delegated to the rollup and auto-settles
 * fills (commit + undelegate -> move balances -> re-delegate). Runs forever.
 *
 *   npm run crank        (local)
 *   pm2 start ecosystem.config.cjs --only shade-crank   (VPS)
 */
import { makeCtx, sendOnER, bookOnBase, log, sleep, Ctx, ER_VALIDATOR } from "./config";

const TICK_MS = Number(process.env.CRANK_TICK_MS || 6000);

async function delegate(ctx: Ctx) {
  const tx = await ctx.program.methods
    .delegate()
    .accounts({ payer: ctx.kp.publicKey, pda: ctx.book })
    .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
    .transaction();
  return ctx.baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
}

async function settleAndUndelegate(ctx: Ctx) {
  return sendOnER(ctx, await ctx.erProgram.methods.settleAndUndelegate().accounts({ payer: ctx.kp.publicKey, book: ctx.book }).transaction());
}

async function settleAll(ctx: Ctx): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const b: any = await (ctx.program.account as any).orderBook.fetch(ctx.book);
    const next = b.fills.filter((f: any) => Number(f.id) > Number(b.settledSeq)).sort((a: any, c: any) => Number(a.id) - Number(c.id))[0];
    if (!next) return true;
    try {
      const sig = await ctx.program.methods
        .settleFill()
        .accounts({ book: ctx.book, buyerBalance: ctx.balPda(next.buyer), sellerBalance: ctx.balPda(next.seller), cranker: ctx.kp.publicKey })
        .rpc({ skipPreflight: true });
      log(`  settled fill #${Number(next.id)}  ${next.buyer.toBase58().slice(0, 4)}→${next.seller.toBase58().slice(0, 4)}`);
      log("  tx: https://solscan.io/tx/" + sig + "?cluster=devnet");
    } catch (e: any) {
      // A fill whose counterparty under-funded can't settle and would block the queue.
      // Skip it so the rest of the queue clears (the program settles strictly in id order,
      // so we advance settled_seq past it by retrying — if it persistently fails, surface it).
      const msg = (e.message || e).toString();
      log(`  settle fill #${Number(next.id)} failed: ${msg.slice(0, 120)}`);
      if (/InsufficientFunds|0x1771/i.test(msg)) {
        log("  ^ counterparty under-funded — leaving for manual review, stopping this pass");
      }
      return false;
    }
  }
  return false;
}

async function tick(ctx: Ctx) {
  const onBase = await bookOnBase(ctx);

  if (onBase) {
    const b: any = await (ctx.program.account as any).orderBook.fetch(ctx.book);
    const unsettled = (b.fills || []).filter((f: any) => Number(f.id) > Number(b.settledSeq));
    if (unsettled.length > 0) {
      log(`book on base — settling ${unsettled.length} fill(s)…`);
      try { await settleAll(ctx); } catch (e: any) { log("  settle err:", (e.message || e).toString().slice(0, 140)); return; }
    }
    log("  re-delegating for trading…");
    try { await delegate(ctx); log("  delegated ✓"); }
    catch (e: any) { log("  delegate err:", (e.message || e).toString().slice(0, 140)); }
    return;
  }

  let erBook: any;
  try { erBook = await (ctx.erProgram.account as any).orderBook.fetch(ctx.book); }
  catch (e: any) { log("  ER read err:", (e.message || e).toString().slice(0, 80)); return; }
  const unsettled = (erBook.fills || []).filter((f: any) => Number(f.id) > Number(erBook.settledSeq));
  log(`book on rollup — asks:${(erBook.asks || []).length} bids:${(erBook.bids || []).length} fills:${(erBook.fills || []).length} settled:${Number(erBook.settledSeq)}`);
  if (unsettled.length === 0) return;
  log(`\n${unsettled.length} fill(s) to settle → committing + undelegating…`);
  try { await settleAndUndelegate(ctx); log("  undelegate sent; settling next tick"); }
  catch (e: any) { log("  undelegate err:", (e.message || e).toString().slice(0, 140)); }
}

async function main() {
  const ctx = makeCtx();
  log("SHADE CRANK (settlement engine)");
  log("  wallet:", ctx.kp.publicKey.toBase58());
  log("  book  :", ctx.book.toBase58());
  log("  watching for fills — leave running.\n");
  while (true) {
    try { await tick(ctx); } catch (e: any) { log("tick err:", (e.message || e).toString().slice(0, 120)); }
    await sleep(TICK_MS);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
