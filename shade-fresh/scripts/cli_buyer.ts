/**
 * Full CLI buyer: makes (or loads) a 2nd wallet, funds it from your CLI wallet,
 * deposits USDC into Shade, and places a BUY that crosses the resting sell.
 * The running crank then settles it -> balances move.
 *
 *   npm run cli:buyer
 *
 * Reuses ./buyer.json if present (so balances persist run to run).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Connection, Transaction, SystemProgram, SYSVAR_RENT_PUBKEY, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";

const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/shade.json"), "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-router.magicblock.app";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-router.magicblock.app";
const USDC = new PublicKey((process.env.USDC_MINT || "").trim());
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const BOOK_SEED = "book_v5", BAL_SEED = "bal", VAULT_QUOTE_SEED = "vault_quote";
// PRICE is the SAME human number you type in the UI (e.g. 187 = $187). UI sends price*100 on-chain; we match it.
const PRICE_HUMAN = Number(process.env.PRICE || 187);
const PRICE = Math.round(PRICE_HUMAN * 100);
const SIZE = Number(process.env.SIZE || 10);
// quote (USDC) for the fill = price_onchain * size * 10 micro-USDC; deposit that + 20% buffer
const USDC_NEEDED = (PRICE * SIZE * 10) / 1e6;
const USDC_DEPOSIT = Number(process.env.USDC_DEPOSIT || Math.ceil(USDC_NEEDED * 1.2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// payer = your funded CLI wallet (sends SOL + USDC to the buyer)
const payerPath = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(payerPath, "utf-8"))));

// buyer = a 2nd wallet (created + saved so it's a real distinct trader)
let buyer: Keypair;
if (fs.existsSync("buyer.json")) buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync("buyer.json", "utf-8"))));
else { buyer = Keypair.generate(); fs.writeFileSync("buyer.json", JSON.stringify(Array.from(buyer.secretKey))); }

const wallet = new anchor.Wallet(buyer);
const baseConn = new Connection(BASE_RPC, "confirmed");
const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: "confirmed" });
const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
const program = new Program(IDL, baseProvider);
const erProgram = new Program(IDL, erProvider);
const pid = program.programId;
const pda = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, pid)[0];
const book = pda([Buffer.from(BOOK_SEED)]);
const myBal = pda([Buffer.from(BAL_SEED), book.toBuffer(), buyer.publicKey.toBuffer()]);
const vaultQuote = pda([Buffer.from(VAULT_QUOTE_SEED), book.toBuffer()]);

async function routerBlockhash(tx: Transaction) {
  const writable = new Set<string>();
  if (tx.feePayer) writable.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isWritable) writable.add(k.pubkey.toBase58());
  const res = await fetch(erConn.rpcEndpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [Array.from(writable)] }) });
  const data: any = await res.json();
  const bh = data?.result?.value ?? data?.result;
  if (!bh?.blockhash) throw new Error("router blockhash failed: " + JSON.stringify(data).slice(0, 160));
  return bh;
}

(async () => {
  if (!process.env.USDC_MINT) { console.error("set USDC_MINT"); process.exit(1); }
  console.log("payer (CLI):", payer.publicKey.toBase58());
  console.log("buyer (2nd):", buyer.publicKey.toBase58());
  console.log("book       :", book.toBase58(), "\n");

  // 1. fund buyer with SOL for gas (from payer) if low
  const bal = await baseConn.getBalance(buyer.publicKey);
  if (bal < 0.05 * LAMPORTS_PER_SOL) {
    console.log("funding buyer with 0.2 SOL for gas…");
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: buyer.publicKey, lamports: 0.2 * LAMPORTS_PER_SOL }));
    await anchor.web3.sendAndConfirmTransaction(baseConn, t, [payer]);
  }

  // 2. send USDC from payer -> buyer ATA
  const payerAta = getAssociatedTokenAddressSync(USDC, payer.publicKey);
  const buyerAta = getAssociatedTokenAddressSync(USDC, buyer.publicKey);
  const pre: anchor.web3.TransactionInstruction[] = [];
  if (!(await baseConn.getAccountInfo(buyerAta))) pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, buyerAta, buyer.publicKey, USDC));
  pre.push(createTransferInstruction(payerAta, buyerAta, payer.publicKey, BigInt(Math.round((USDC_DEPOSIT + 50) * 1e6))));
  console.log("sending USDC to buyer…");
  await anchor.web3.sendAndConfirmTransaction(baseConn, new Transaction().add(...pre), [payer]);

  // 3. init_user (if needed) + deposit_quote (USDC) into Shade
  if (!(await baseConn.getAccountInfo(myBal))) {
    console.log("init_user…");
    await program.methods.initUser().accounts({ book, userBalance: myBal, owner: buyer.publicKey, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
  }
  console.log(`deposit ${USDC_DEPOSIT} USDC…`);
  await program.methods.depositQuote(new BN(Math.round(USDC_DEPOSIT * 1e6)))
    .accounts({ book, userBalance: myBal, vaultQuote, userToken: buyerAta, owner: buyer.publicKey, tokenProgram: TOKEN_PROGRAM_ID })
    .rpc({ skipPreflight: true });

  const before: any = await (erProgram.account as any).orderBook.fetch(book);
  console.log(`\nBEFORE — asks:${before.asks.length} bids:${before.bids.length} fills:${before.fills.length} settled:${Number(before.settledSeq)}`);

  // 4. place BUY on the rollup (crosses the resting sell)
  console.log(`placing BUY size ${SIZE} (=${SIZE*0.001} SOL) @ $${PRICE_HUMAN} (on-chain ${PRICE}); USDC deposit ${USDC_DEPOSIT}…`);
  const tx = await erProgram.methods.placeOrder(0, new BN(PRICE), new BN(SIZE)).accounts({ book, trader: buyer.publicKey }).transaction();
  tx.feePayer = buyer.publicKey;
  const { blockhash, lastValidBlockHeight } = await routerBlockhash(tx);
  tx.recentBlockhash = blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const conf = await erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error("buy failed: " + JSON.stringify(conf.value.err));
  console.log("buy OK:", sig.slice(0, 16));

  const after: any = await (erProgram.account as any).orderBook.fetch(book);
  console.log(`AFTER  — asks:${after.asks.length} bids:${after.bids.length} fills:${after.fills.length} settled:${Number(after.settledSeq)}`);
  if (after.fills.length > before.fills.length) {
    console.log("\n*** FILL CREATED — watch the crank settle it. ***");
    console.log("    buyer:", buyer.publicKey.toBase58());
    console.log("    after settle, check buyer balance grows in wSOL, drops in USDC.");
  } else console.log("\n(no new fill — does the price cross the resting ask?)");
  process.exit(0);
})().catch((e) => { console.error("\nERROR:", (e.message || e).toString()); if (e.logs) console.error(JSON.stringify(e.logs, null, 2)); process.exit(1); });