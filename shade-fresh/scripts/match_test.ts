/**
 * End-to-end matching test from your DEFAULT CLI wallet (~/.config/solana/id.json).
 * Places a SELL then a BUY that crosses it -> creates a fill on the rollup.
 * The running crank will then settle it.
 *   npm run match:test
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, Transaction } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";

const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/shade.json"), "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-router.magicblock.app";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-router.magicblock.app";
const BOOK_SEED = "book_v5";
const PRICE = Number(process.env.PRICE || 18700);
const SIZE = Number(process.env.SIZE || 10);

const kpPath = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
const wallet = new anchor.Wallet(kp);
const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
const baseProvider = new anchor.AnchorProvider(new Connection(BASE_RPC, "confirmed"), wallet, { commitment: "confirmed" });
const erProgram = new Program(IDL, erProvider);
const program = new Program(IDL, baseProvider);
const book = PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], program.programId)[0];

async function routerBlockhash(tx: Transaction): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const writable = new Set<string>();
  if (tx.feePayer) writable.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isWritable) writable.add(k.pubkey.toBase58());
  const res = await fetch(erConn.rpcEndpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [Array.from(writable)] }) });
  const data: any = await res.json();
  const bh = data?.result?.value ?? data?.result;
  if (!bh?.blockhash) throw new Error("router getBlockhashForAccounts failed: " + JSON.stringify(data).slice(0, 200));
  return { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

async function place(side: number, label: string) {
  const tx = await erProgram.methods.placeOrder(side, new BN(PRICE), new BN(SIZE)).accounts({ book, trader: kp.publicKey }).transaction();
  tx.feePayer = kp.publicKey;
  const { blockhash, lastValidBlockHeight } = await routerBlockhash(tx);
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  const conf = await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error(label + " failed: " + JSON.stringify(conf.value.err));
  console.log("  " + label + " OK", sig.slice(0, 12));
}

const show = async (tag: string) => {
  const b: any = await (erProgram.account as any).orderBook.fetch(book);
  console.log(`${tag} — asks:${b.asks.length} bids:${b.bids.length} fills:${b.fills.length} seq:${Number(b.seq)} settled:${Number(b.settledSeq)}`);
  return b;
};

(async () => {
  console.log("wallet:", kp.publicKey.toBase58());
  console.log("book  :", book.toBase58(), "\n");
  const before = await show("BEFORE");

  // if nothing is resting to sell into, place a sell first
  if (before.asks.length === 0 && before.bids.length === 0) {
    console.log(`\nplacing SELL ${SIZE} @ ${PRICE}…`);
    await place(1, "sell");
    await show("after sell");
  }
  console.log(`\nplacing BUY ${SIZE} @ ${PRICE} (crosses)…`);
  await place(0, "buy");

  const after = await show("\nAFTER");
  if (after.fills.length > before.fills.length) console.log("\n*** FILL CREATED — your running crank will settle it now. ***");
  else console.log("\n(no new fill — check the price crosses the resting order)");
  process.exit(0);
})().catch((e) => { console.error("\nERROR:", (e.message || e).toString()); if (e.logs) console.error(JSON.stringify(e.logs, null, 2)); process.exit(1); });