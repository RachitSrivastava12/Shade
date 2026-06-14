/**
 * Shade — full settlement lifecycle on devnet. SELF-CONTAINED (no imports from app/).
 *
 *   export USDC_MINT=<your mock usdc mint>
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   export PROVIDER_ENDPOINT=<your quicknode devnet url>   # optional but recommended
 *   npm run demo:settle
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL, Connection, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

// ---- config ----
const IDL = JSON.parse(fs.readFileSync("target/idl/shade.json", "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-as.magicblock.app/";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-as.magicblock.app/";
const ER_VALIDATOR = new PublicKey(process.env.VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

const BOOK_SEED = "book_v5", BAL_SEED = "bal", VAULT_AUTH_SEED = "vault",
  VAULT_BASE_SEED = "vault_base", VAULT_QUOTE_SEED = "vault_quote";
const SIDE_BID = 0, SIDE_ASK = 1;

const log = (...a: any[]) => console.log(...a);
const fmtSol = (n: number) => (n / LAMPORTS_PER_SOL).toFixed(4);
const fmtUsdc = (n: number) => (n / 1e6).toFixed(2);

// ---- inline client (mirrors app/src/lib/shade.ts, no cross-imports) ----
class Shade {
  program: Program; erProgram: Program;
  baseProvider: anchor.AnchorProvider; erProvider: anchor.AnchorProvider;
  book: PublicKey; vaultAuth: PublicKey; vaultBase: PublicKey; vaultQuote: PublicKey;
  baseMint: PublicKey; quoteMint: PublicKey;

  constructor(baseProvider: anchor.AnchorProvider, erProvider: anchor.AnchorProvider, quoteMint: PublicKey) {
    this.baseProvider = baseProvider; this.erProvider = erProvider;
    this.program = new Program(IDL, baseProvider);
    this.erProgram = new Program(IDL, erProvider);
    const pid = this.program.programId;
    this.book = PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], pid)[0];
    this.vaultAuth = PublicKey.findProgramAddressSync([Buffer.from(VAULT_AUTH_SEED), this.book.toBuffer()], pid)[0];
    this.vaultBase = PublicKey.findProgramAddressSync([Buffer.from(VAULT_BASE_SEED), this.book.toBuffer()], pid)[0];
    this.vaultQuote = PublicKey.findProgramAddressSync([Buffer.from(VAULT_QUOTE_SEED), this.book.toBuffer()], pid)[0];
    this.baseMint = NATIVE_MINT; this.quoteMint = quoteMint;
  }
  get me() { return this.baseProvider.wallet.publicKey; }
  bal(owner: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from(BAL_SEED), this.book.toBuffer(), owner.toBuffer()], this.program.programId)[0]; }
  myBal() { return this.bal(this.me); }

  initializeBook(tick = 100, lot = 1) {
    return this.program.methods.initializeBook(new BN(tick), new BN(lot))
      .accounts({ authority: this.me, baseMint: this.baseMint, quoteMint: this.quoteMint }).rpc({ skipPreflight: true });
  }
  initVaults() {
    return this.program.methods.initVaults().accounts({
      book: this.book, payer: this.me, baseMint: this.baseMint, quoteMint: this.quoteMint,
      vaultAuth: this.vaultAuth, vaultBase: this.vaultBase, vaultQuote: this.vaultQuote,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    }).rpc({ skipPreflight: true });
  }
  initUser() {
    return this.program.methods.initUser()
      .accounts({ book: this.book, userBalance: this.myBal(), owner: this.me, systemProgram: SystemProgram.programId }).rpc({ skipPreflight: true });
  }
  async depositBaseSol(sol: number) {
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    const ata = getAssociatedTokenAddressSync(this.baseMint, this.me);
    const pre: anchor.web3.TransactionInstruction[] = [];
    try { await getAccount(this.baseProvider.connection, ata); }
    catch { pre.push(createAssociatedTokenAccountInstruction(this.me, ata, this.me, this.baseMint)); }
    pre.push(SystemProgram.transfer({ fromPubkey: this.me, toPubkey: ata, lamports }));
    pre.push(createSyncNativeInstruction(ata));
    return this.program.methods.depositBase(new BN(lamports))
      .accounts({ book: this.book, userBalance: this.myBal(), vaultBase: this.vaultBase, userToken: ata, owner: this.me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
  }
  depositQuoteUsdc(usdc: number) {
    const amount = Math.round(usdc * 1e6);
    const ata = getAssociatedTokenAddressSync(this.quoteMint, this.me);
    return this.program.methods.depositQuote(new BN(amount))
      .accounts({ book: this.book, userBalance: this.myBal(), vaultQuote: this.vaultQuote, userToken: ata, owner: this.me, tokenProgram: TOKEN_PROGRAM_ID }).rpc({ skipPreflight: true });
  }
  async withdrawBaseSol(sol: number) {
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    const ata = getAssociatedTokenAddressSync(this.baseMint, this.me);
    const pre: anchor.web3.TransactionInstruction[] = [];
    try { await getAccount(this.baseProvider.connection, ata); }
    catch { pre.push(createAssociatedTokenAccountInstruction(this.me, ata, this.me, this.baseMint)); }
    return this.program.methods.withdrawBase(new BN(lamports))
      .accounts({ book: this.book, userBalance: this.myBal(), vaultAuth: this.vaultAuth, vaultBase: this.vaultBase, userToken: ata, owner: this.me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
  }
  async withdrawQuoteUsdc(usdc: number) {
    const amount = Math.round(usdc * 1e6);
    const ata = getAssociatedTokenAddressSync(this.quoteMint, this.me);
    const pre: anchor.web3.TransactionInstruction[] = [];
    try { await getAccount(this.baseProvider.connection, ata); }
    catch { pre.push(createAssociatedTokenAccountInstruction(this.me, ata, this.me, this.quoteMint)); }
    return this.program.methods.withdrawQuote(new BN(amount))
      .accounts({ book: this.book, userBalance: this.myBal(), vaultAuth: this.vaultAuth, vaultQuote: this.vaultQuote, userToken: ata, owner: this.me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
  }
  settleFill(buyer: PublicKey, seller: PublicKey) {
    return this.program.methods.settleFill()
      .accounts({ book: this.book, buyerBalance: this.bal(buyer), sellerBalance: this.bal(seller), cranker: this.me }).rpc({ skipPreflight: true });
  }
  async settleAll() {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    let settledAny = false;
    // commit_and_undelegate writes to base asynchronously — poll until fills land.
    for (let attempt = 0; attempt < 25; attempt++) {
      let b: any = null;
      try { b = await (this.program.account as any).orderBook.fetch(this.book); } catch { await sleep(2000); continue; }
      const next = b.fills.filter((f: any) => Number(f.id) > Number(b.settledSeq)).sort((a: any, c: any) => Number(a.id) - Number(c.id))[0];
      if (!next) { if (settledAny) break; await sleep(2000); continue; }
      await this.settleFill(next.buyer, next.seller);
      settledAny = true;
    }
  }
  async delegate() {
    const tx = await this.program.methods.delegate().accounts({ payer: this.me, pda: this.book })
      .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }]).transaction();
    return this.baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
  }
  private async onER(tx: Transaction) {
    tx.feePayer = this.erProvider.wallet.publicKey;
    tx.recentBlockhash = (await this.erProvider.connection.getLatestBlockhash()).blockhash;
    const signed = await this.erProvider.wallet.signTransaction(tx);
    const sig = await this.erProvider.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    await this.erProvider.connection.confirmTransaction(sig, "confirmed");
    return sig;
  }
  async placeOrder(side: number, price: number, size: number) {
    return this.onER(await this.erProgram.methods.placeOrder(side, new BN(price), new BN(size)).accounts({ book: this.book, trader: this.me }).transaction());
  }
  async matchBook() { return this.onER(await this.erProgram.methods.matchBook().accounts({ book: this.book, trader: this.me }).transaction()); }
  async settleAndUndelegate() { return this.onER(await this.erProgram.methods.settleAndUndelegate().accounts({ payer: this.me, book: this.book }).transaction()); }
  async fetchBookER(): Promise<any> { return (this.erProgram.account as any).orderBook.fetch(this.book); }
  async fetchBalance(owner: PublicKey): Promise<any> { try { return await (this.program.account as any).userBalance.fetch(this.bal(owner)); } catch { return null; } }
}

function loadKp(): Keypair {
  const path = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
}
function providersFor(kp: Keypair) {
  const wallet = new anchor.Wallet(kp);
  const baseProvider = new anchor.AnchorProvider(new Connection(BASE_RPC, "confirmed"), wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" }), wallet, { commitment: "confirmed" });
  return { baseProvider, erProvider };
}
async function tokBal(conn: Connection, payer: Keypair, mint: PublicKey, owner: PublicKey) {
  try { const a = await getOrCreateAssociatedTokenAccount(conn, payer, mint, owner); return Number((await getAccount(conn, a.address)).amount); }
  catch { return 0; }
}

async function main() {
  const mintStr = (process.env.USDC_MINT || "").trim();
  if (!mintStr) throw new Error("Set USDC_MINT env (export USDC_MINT=...)");
  const USDC = new PublicKey(mintStr);
  const conn = new Connection(BASE_RPC, "confirmed");
  const seller = loadKp();
  const buyer = Keypair.generate();

  log("Shade settlement demo");
  log("  seller :", seller.publicKey.toBase58());
  log("  buyer  :", buyer.publicKey.toBase58());
  log("  USDC   :", USDC.toBase58());

  await anchor.web3.sendAndConfirmTransaction(conn,
    new Transaction().add(SystemProgram.transfer({ fromPubkey: seller.publicKey, toPubkey: buyer.publicKey, lamports: 0.25 * LAMPORTS_PER_SOL })), [seller]);
  const buyerUsdc = await getOrCreateAssociatedTokenAccount(conn, seller, USDC, buyer.publicKey);
  await mintTo(conn, seller, USDC, buyerUsdc.address, seller, 50_000_000);
  log("  minted 50 USDC to buyer");

  const sp = providersFor(seller); const bp = providersFor(buyer);
  const S = new Shade(sp.baseProvider, sp.erProvider, USDC);
  const B = new Shade(bp.baseProvider, bp.erProvider, USDC);

  const step = async (label: string, fn: () => Promise<any>) => {
    try { await fn(); log("  ✓", label); }
    catch (e: any) { log("  …", label, "—", (e.message || e).toString().slice(0, 120)); }
  };

  log("\n── setup ──");
  await step("init book + mints", () => S.initializeBook());
  await step("init vaults", () => S.initVaults());
  await step("init seller balance", () => S.initUser());
  await step("init buyer balance", () => B.initUser());

  log("\n── deposit (real tokens into vault) ──");
  await step("seller deposits 0.05 wSOL", () => S.depositBaseSol(0.05));
  await step("buyer deposits 40 USDC", () => B.depositQuoteUsdc(40));
  log("  seller credited:", JSON.stringify(await S.fetchBalance(seller.publicKey)));
  log("  buyer  credited:", JSON.stringify(await B.fetchBalance(buyer.publicKey)));

  log("\n── trade on the rollup ──");
  await step("delegate book → ER", () => S.delegate());
  await step("seller places ASK 18700 x10", () => S.placeOrder(SIDE_ASK, 18700, 10));
  await step("buyer places BID 18700 x10", () => B.placeOrder(SIDE_BID, 18700, 10));
  await step("match", () => S.matchBook());
  try { const eb = await S.fetchBookER(); log("  fills on ER:", (eb.fills || []).map((f: any) => `#${f.id} ${f.size}@${f.price}`).join(", ") || "none"); } catch {}

  log("\n── settle back to Solana ──");
  await step("commit + undelegate", () => S.settleAndUndelegate());
  await step("settle fills → balances", () => S.settleAll());
  log("  seller credited:", JSON.stringify(await S.fetchBalance(seller.publicKey)));
  log("  buyer  credited:", JSON.stringify(await B.fetchBalance(buyer.publicKey)));

  log("\n── withdraw (real tokens leave vault) ──");
  const b0 = await tokBal(conn, seller, NATIVE_MINT, buyer.publicKey);
  const s0 = await tokBal(conn, seller, USDC, seller.publicKey);
  await step("buyer withdraws 0.01 wSOL", () => B.withdrawBaseSol(0.01));
  await step("seller withdraws 1.87 USDC", () => S.withdrawQuoteUsdc(1.87));
  const b1 = await tokBal(conn, seller, NATIVE_MINT, buyer.publicKey);
  const s1 = await tokBal(conn, seller, USDC, seller.publicKey);

  log("\n── RESULT (real on-chain token movement) ──");
  log("  buyer  wSOL:", fmtSol(b0), "→", fmtSol(b1));
  log("  seller USDC:", fmtUsdc(s0), "→", fmtUsdc(s1));
  log("\ndone.");
}
main().catch((e) => { console.error(e); process.exit(1); });
