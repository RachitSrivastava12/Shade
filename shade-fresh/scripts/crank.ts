/**
 * Shade engine — ONE standalone crank process. Keeps the book delegated to the rollup
 * and auto-settles fills. Run in its own terminal and leave it open:
 *
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   export PROVIDER_ENDPOINT=<your quicknode devnet url>
 *   export USDC_MINT=<your mock usdc mint>
 *   npm run crank
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";

const IDL = JSON.parse(fs.readFileSync("target/idl/shade.json", "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-router.magicblock.app";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-router.magicblock.app";
const ER_VALIDATOR = new PublicKey(process.env.VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
const BOOK_SEED = "book_v5", BAL_SEED = "bal";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

function loadKp(): Keypair {
  const path = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
}

const kp = loadKp();
const wallet = new anchor.Wallet(kp);
const baseConn = new Connection(BASE_RPC, "confirmed");
const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
const program = new Program(IDL, baseProvider);
const erProgram = new Program(IDL, erProvider);
const book = PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], program.programId)[0];
const balPda = (owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from(BAL_SEED), book.toBuffer(), owner.toBuffer()], program.programId)[0];

async function routerBlockhash(endpoint: string, tx: Transaction): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const writable = new Set<string>();
  if (tx.feePayer) writable.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isWritable) writable.add(k.pubkey.toBase58());
  const res = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [Array.from(writable)] }),
  });
  const data: any = await res.json();
  const bh = data?.result?.value ?? data?.result;
  if (!bh?.blockhash) throw new Error("router getBlockhashForAccounts failed: " + JSON.stringify(data).slice(0, 200));
  return { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

async function onER(tx: Transaction) {
  tx.feePayer = kp.publicKey;
  const { blockhash, lastValidBlockHeight } = await routerBlockhash(erConn.rpcEndpoint, tx);
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const conf = await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error("ER tx failed: " + JSON.stringify(conf.value.err));
  return sig;
}
async function delegate() {
  const tx = await program.methods.delegate().accounts({ payer: kp.publicKey, pda: book })
    .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }]).transaction();
  return baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
}
async function settleAndUndelegate() {
  return onER(await erProgram.methods.settleAndUndelegate().accounts({ payer: kp.publicKey, book }).transaction());
}
async function waitUndelegated() {
  for (let i = 0; i < 30; i++) {
    const info = await baseConn.getAccountInfo(book, "confirmed");
    if (info && info.owner.equals(program.programId)) return true;
    await sleep(2000);
  }
  return false;
}
async function settleAll(): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    const b: any = await (program.account as any).orderBook.fetch(book);
    const next = b.fills.filter((f: any) => Number(f.id) > Number(b.settledSeq)).sort((a: any, c: any) => Number(a.id) - Number(c.id))[0];
    if (!next) return true;
    const sig = await program.methods.settleFill()
      .accounts({ book, buyerBalance: balPda(next.buyer), sellerBalance: balPda(next.seller), cranker: kp.publicKey })
      .rpc({ skipPreflight: true });
    log("  settled fill #" + Number(next.id) + "  " + next.buyer.toBase58().slice(0, 4) + "→" + next.seller.toBase58().slice(0, 4));
    log("  SETTLE TX (show on Solscan): https://solscan.io/tx/" + sig + "?cluster=devnet");
  }
  return false;
}

async function tick() {
  // Where does the book live RIGHT NOW? (owner on base layer)
  const info = await baseConn.getAccountInfo(book, "confirmed");
  const onBase = !!(info && info.owner.equals(program.programId));

  if (onBase) {
    // Book is undelegated on Solana. Settle any pending fills, then re-delegate for trading.
    const b: any = await (program.account as any).orderBook.fetch(book);
    const unsettled = (b.fills || []).filter((f: any) => Number(f.id) > Number(b.settledSeq));
    if (unsettled.length > 0) {
      log(`book on base — settling ${unsettled.length} fill(s)…`);
      try { await settleAll(); }
      catch (e: any) { log("  settle err:", (e.message || e).toString().slice(0, 140)); return; }
    }
    log("  re-delegating for trading…");
    try { await delegate(); log("  delegated ✓"); }
    catch (e: any) { log("  delegate err:", (e.message || e).toString().slice(0, 140)); }
    return;
  }

  // Book is delegated to the rollup. Read it.
  let erBook: any;
  try { erBook = await (erProgram.account as any).orderBook.fetch(book); }
  catch (e: any) { log("  ER read err:", (e.message || e).toString().slice(0, 80)); return; }
  const unsettled = (erBook.fills || []).filter((f: any) => Number(f.id) > Number(erBook.settledSeq));
  log(`book on rollup — asks:${(erBook.asks||[]).length} bids:${(erBook.bids||[]).length} fills:${(erBook.fills||[]).length} settled:${Number(erBook.settledSeq)}`);
  if (unsettled.length === 0) return;
  // Fills exist → commit + undelegate. Settlement happens next tick once it lands on base.
  log("\n" + unsettled.length + " fill(s) to settle → committing + undelegating…");
  try { await settleAndUndelegate(); log("  undelegate sent; settling next tick"); }
  catch (e: any) { log("  undelegate err:", (e.message || e).toString().slice(0, 140)); }
}

async function main() {
  log("SHADE ENGINE (standalone crank)");
  log("  wallet:", kp.publicKey.toBase58());
  log("  book  :", book.toBase58());
  log("  watching for fills — leave this running.\n");
  while (true) { try { await tick(); } catch (e: any) { log("tick err:", (e.message || e).toString().slice(0, 80)); } await sleep(6000); }
}
main().catch((e) => { console.error(e); process.exit(1); });