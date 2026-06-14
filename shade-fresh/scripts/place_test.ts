/** Places ONE sell on the rollup with preflight ON, to surface the REAL execution error. */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, Transaction, SendTransactionError } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os";

const IDL = JSON.parse(fs.readFileSync("target/idl/shade.json", "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-router.magicblock.app";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-router.magicblock.app";
const BOOK_SEED = "book_v5";
const path = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
const wallet = new anchor.Wallet(kp);
const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
const baseProvider = new anchor.AnchorProvider(new Connection(BASE_RPC, "confirmed"), wallet, { commitment: "confirmed" });
const erProgram = new Program(IDL, erProvider);
const program = new Program(IDL, baseProvider);
const book = PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], program.programId)[0];

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

(async () => {
  console.log("book:", book.toBase58());
  try {
    const b: any = await (erProgram.account as any).orderBook.fetch(book);
    console.log(`BEFORE — asks:${b.asks.length} bids:${b.bids.length} fills:${b.fills.length} seq:${Number(b.seq)} settled:${Number(b.settledSeq)}`);
  } catch (e: any) { console.log("could not read ER book:", (e.message||e).toString().slice(0,120)); }

  console.log("\nplacing SELL 10 @ 18700 on rollup (preflight ON)…");
  try {
    const tx = await erProgram.methods.placeOrder(1, new BN(18700), new BN(10))
      .accounts({ book, trader: kp.publicKey }).transaction();
    tx.feePayer = kp.publicKey;
    const { blockhash, lastValidBlockHeight } = await routerBlockhash(erConn.rpcEndpoint, tx);
    tx.recentBlockhash = blockhash;
    const signed = await wallet.signTransaction(tx);
    const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log("OK sig:", sig);
  } catch (e: any) {
    console.log("\n>>> REAL ERROR:");
    console.log((e.message || e).toString());
    if (e instanceof SendTransactionError) { try { console.log("LOGS:", JSON.stringify(await e.getLogs(erConn), null, 2)); } catch {} }
    if (e.logs) console.log("LOGS:", JSON.stringify(e.logs, null, 2));
  }

  try {
    const b: any = await (erProgram.account as any).orderBook.fetch(book);
    console.log(`\nAFTER — asks:${b.asks.length} bids:${b.bids.length} fills:${b.fills.length} seq:${Number(b.seq)} settled:${Number(b.settledSeq)}`);
  } catch {}
  process.exit(0);
})();