import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Connection, Transaction, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, getAccount,
} from "@solana/spl-token";

export const BOOK_SEED = "book_v5";
export const BAL_SEED = "bal";
export const VAULT_AUTH_SEED = "vault";
export const VAULT_BASE_SEED = "vault_base";
export const VAULT_QUOTE_SEED = "vault_quote";
export const SIDE_BID = 0;
export const SIDE_ASK = 1;

// settlement scaling — must match the program
export const BASE_LAMPORTS_PER_SIZE = 1_000_000; // 0.001 SOL per size unit
export const QUOTE_MICRO_MULT = 10;

function nodeEnv(k: string): string | undefined {
  try { if (typeof process !== "undefined" && process.env) return process.env[k]; } catch (_) {}
  return undefined;
}

// Reliable devnet RPC default — used when PROVIDER_ENDPOINT/VITE_PROVIDER_ENDPOINT isn't
// set, so the app never falls back to rate-limited public devnet (which returns empty reads).
export const DEFAULT_RPC = "https://divine-fittest-season.solana-devnet.quiknode.pro/17750ffdb134b9cfe0539702c9f709ff4a855f60/";
export const BASE_RPC = nodeEnv("PROVIDER_ENDPOINT") || DEFAULT_RPC;
// Direct devnet ER validator endpoint. We use this instead of the Magic Router
// (devnet-router.magicblock.app) because the router has outages; the book is always
// delegated to a fixed validator (MAS1Dt9…) that this endpoint serves directly.
export const ER_RPC = nodeEnv("EPHEMERAL_PROVIDER_ENDPOINT") || "https://devnet.magicblock.app";
export const ER_WS = nodeEnv("EPHEMERAL_WS_ENDPOINT") || "wss://devnet.magicblock.app";
export const ER_VALIDATOR = new PublicKey(nodeEnv("VALIDATOR") || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

// wSOL is the base mint. USDC mint comes from env, defaulting to the live devnet mock USDC.
export const BASE_MINT = NATIVE_MINT; // So11111111111111111111111111111111111111112
// the deployed book's quote_mint — used as the default so the app never falls back to wSOL
// when VITE_USDC_MINT/USDC_MINT isn't set in the environment.
export const DEVNET_USDC_MINT = "DANN41Tukr829a3zzXy81QpzfqNyYendveiuvwDnho4R";
const _q = (nodeEnv("USDC_MINT") || "").trim();
export const QUOTE_MINT = _q ? new PublicKey(_q) : new PublicKey(DEVNET_USDC_MINT);

export interface OrderJSON { id: number; owner: string; price: number; size: number; side: number; }
export interface FillJSON { id: number; buyer: string; seller: string; price: number; size: number; ts: number; }
export interface BookJSON {
  authority: string; baseMint: string; quoteMint: string; seq: number; settledSeq: number;
  lastPrice: number; tick: number; lot: number;
  bids: OrderJSON[]; asks: OrderJSON[]; fills: FillJSON[];
}
export interface UserBalanceJSON { owner: string; baseFree: number; quoteFree: number; }

export function bookPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], programId)[0];
}
function vaultAuthPda(p: PublicKey, book: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from(VAULT_AUTH_SEED), book.toBuffer()], p)[0]; }
function vaultBasePda(p: PublicKey, book: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from(VAULT_BASE_SEED), book.toBuffer()], p)[0]; }
function vaultQuotePda(p: PublicKey, book: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from(VAULT_QUOTE_SEED), book.toBuffer()], p)[0]; }
function balPda(p: PublicKey, book: PublicKey, owner: PublicKey) { return PublicKey.findProgramAddressSync([Buffer.from(BAL_SEED), book.toBuffer(), owner.toBuffer()], p)[0]; }

export class ShadeClient {
  program: Program;
  erProgram: Program;
  baseProvider: anchor.AnchorProvider;
  erProvider: anchor.AnchorProvider;
  book: PublicKey;
  vaultAuth: PublicKey;
  vaultBase: PublicKey;
  vaultQuote: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;

  constructor(idl: anchor.Idl, baseProvider: anchor.AnchorProvider, erProvider: anchor.AnchorProvider, opts?: { baseMint?: PublicKey; quoteMint?: PublicKey }) {
    this.baseProvider = baseProvider;
    this.erProvider = erProvider;
    this.baseMint = opts?.baseMint ?? BASE_MINT;
    this.quoteMint = opts?.quoteMint ?? QUOTE_MINT;
    this.program = new Program(idl, baseProvider);
    this.erProgram = new Program(idl, erProvider);
    this.book = bookPda(this.program.programId);
    this.vaultAuth = vaultAuthPda(this.program.programId, this.book);
    this.vaultBase = vaultBasePda(this.program.programId, this.book);
    this.vaultQuote = vaultQuotePda(this.program.programId, this.book);
  }

  get me() { return this.baseProvider.wallet.publicKey; }
  myBal() { return balPda(this.program.programId, this.book, this.me); }

  /** Returns [initUser ix] if the caller has no balance yet, else []. Bundled into deposits. */
  private async ensureUserIx(): Promise<anchor.web3.TransactionInstruction[]> {
    const bal = await this.fetchMyBalance();
    if (bal) return [];
    const ix = await this.program.methods.initUser()
      .accounts({ book: this.book, userBalance: this.myBal(), owner: this.me, systemProgram: SystemProgram.programId })
      .instruction();
    return [ix];
  }

  // ---------- base layer: setup ----------
  async initializeBook(tick = 100, lot = 1) {
    return this.program.methods.initializeBook(new BN(tick), new BN(lot))
      .accounts({ authority: this.me, baseMint: this.baseMint, quoteMint: this.quoteMint })
      .rpc({ skipPreflight: true });
  }

  async initVaults() {
    return this.program.methods.initVaults()
      .accounts({
        book: this.book, payer: this.me, baseMint: this.baseMint, quoteMint: this.quoteMint,
        vaultAuth: this.vaultAuth, vaultBase: this.vaultBase, vaultQuote: this.vaultQuote,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      }).rpc({ skipPreflight: true });
  }

  async initUser() {
    return this.program.methods.initUser()
      .accounts({ book: this.book, userBalance: this.myBal(), owner: this.me, systemProgram: SystemProgram.programId })
      .rpc({ skipPreflight: true });
  }

  // ---------- deposits / withdrawals (real tokens move here) ----------
  async depositBaseSol(sol: number) {
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    // must hold enough native SOL for the wrap + ~0.01 SOL gas/rent headroom, else the
    // wallet rejects the tx with a vague "unexpected error".
    const have = await this.baseProvider.connection.getBalance(this.me);
    if (have < lamports + 0.01 * LAMPORTS_PER_SOL)
      throw new Error(`only ${(have / LAMPORTS_PER_SOL).toFixed(3)} SOL in your wallet — need ${sol} + gas. Use the faucet or lower the amount.`);
    const ata = getAssociatedTokenAddressSync(this.baseMint, this.me);
    const pre: anchor.web3.TransactionInstruction[] = [...(await this.ensureUserIx())];
    try { await getAccount(this.baseProvider.connection, ata); }
    catch { pre.push(createAssociatedTokenAccountInstruction(this.me, ata, this.me, this.baseMint)); }
    pre.push(SystemProgram.transfer({ fromPubkey: this.me, toPubkey: ata, lamports }));
    pre.push(createSyncNativeInstruction(ata));
    return this.program.methods.depositBase(new BN(lamports))
      .accounts({ book: this.book, userBalance: this.myBal(), vaultBase: this.vaultBase, userToken: ata, owner: this.me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
  }

  async depositQuoteUsdc(usdc: number) {
    const amount = Math.round(usdc * 1e6);
    const ata = getAssociatedTokenAddressSync(this.quoteMint, this.me);
    // must actually hold this much USDC in the wallet, or the wallet rejects with a vague
    // "unexpected error". Surface a clear, actionable message instead.
    let have = 0;
    try { have = Number((await getAccount(this.baseProvider.connection, ata)).amount); } catch { have = 0; }
    if (have < amount)
      throw new Error(`only ${(have / 1e6).toFixed(2)} USDC in your wallet — claim test USDC from the faucet, or lower the amount.`);
    // init the user's balance ledger if this is their first action (e.g. a buyer who
    // funded via the faucet and deposits USDC before ever touching SOL).
    const pre: anchor.web3.TransactionInstruction[] = [...(await this.ensureUserIx())];
    return this.program.methods.depositQuote(new BN(amount))
      .accounts({ book: this.book, userBalance: this.myBal(), vaultQuote: this.vaultQuote, userToken: ata, owner: this.me, tokenProgram: TOKEN_PROGRAM_ID })
      .preInstructions(pre).rpc({ skipPreflight: true });
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

  async settleFill(buyerOwner: PublicKey, sellerOwner: PublicKey) {
    return this.program.methods.settleFill()
      .accounts({
        book: this.book,
        buyerBalance: balPda(this.program.programId, this.book, buyerOwner),
        sellerBalance: balPda(this.program.programId, this.book, sellerOwner),
        cranker: this.me,
      }).rpc({ skipPreflight: true });
  }

  async settleAll(onLog?: (m: string) => void) {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    onLog?.("waiting for book to return to base…");
    await this.waitUndelegated();
    let last = "";
    let settledAny = false;
    // commit_and_undelegate writes ER state to the base layer asynchronously,
    // so poll the base book until the committed fills appear, then settle them.
    for (let attempt = 0; attempt < 25; attempt++) {
      let b: BookJSON | null = null;
      try { b = await this.fetchBookBase(); } catch { await sleep(2000); continue; }
      const next = b.fills.filter((f) => f.id > b.settledSeq).sort((a, c) => a.id - c.id)[0];
      if (!next) {
        if (settledAny) break;
        onLog?.("waiting for committed fills to land on base…");
        await sleep(2000);
        continue;
      }
      last = await this.settleFill(new PublicKey(next.buyer), new PublicKey(next.seller));
      settledAny = true;
      onLog?.(`settled fill #${next.id}`);
    }
    if (!settledAny) throw new Error("no committed fills found on base after waiting — run settle & undelegate first");
    return last;
  }

  // ---------- ER: delegation + matching ----------
  async delegate() {
    const tx = await this.program.methods.delegate()
      .accounts({ payer: this.me, pda: this.book })
      .remainingAccounts([{ pubkey: ER_VALIDATOR, isSigner: false, isWritable: false }])
      .transaction();
    return this.baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
  }

  private async sendOnER(tx: Transaction) {
    const conn = this.erProvider.connection;
    tx.feePayer = this.erProvider.wallet.publicKey;
    const { blockhash, lastValidBlockHeight } = await routerBlockhash(conn.rpcEndpoint, tx);
    tx.recentBlockhash = blockhash;
    const signed = await this.erProvider.wallet.signTransaction(tx);
    const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
    const conf = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (conf.value.err) {
      throw new Error("rollup tx failed: " + JSON.stringify(conf.value.err));
    }
    return sig;
  }

  async placeOrder(side: number, price: number, size: number) {
    let err: any;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const tx = await this.erProgram.methods.placeOrder(side, new BN(price), new BN(size))
          .accounts({ book: this.book, trader: this.me }).transaction();
        return await this.sendOnER(tx);
      } catch (e) { err = e; await new Promise((r) => setTimeout(r, 2500)); }
    }
    throw err;
  }
  async cancelOrder(id: number) {
    const tx = await this.erProgram.methods.cancelOrder(new BN(id))
      .accounts({ book: this.book, trader: this.me }).transaction();
    return this.sendOnER(tx);
  }
  async matchBook() {
    const tx = await this.erProgram.methods.matchBook().accounts({ book: this.book, trader: this.me }).transaction();
    return this.sendOnER(tx);
  }
  async commitBook() {
    const tx = await this.erProgram.methods.commitBook().accounts({ payer: this.me, book: this.book }).transaction();
    return this.sendOnER(tx);
  }
  async settleAndUndelegate() {
    const tx = await this.erProgram.methods.settleAndUndelegate().accounts({ payer: this.me, book: this.book }).transaction();
    return this.sendOnER(tx);
  }

  // ---------- reads ----------
  async fetchBookER(): Promise<BookJSON> { return normalizeBook(await (this.erProgram.account as any).orderBook.fetch(this.book)); }
  async fetchBookBase(): Promise<BookJSON> { return normalizeBook(await (this.program.account as any).orderBook.fetch(this.book)); }
  /** Polls until the book account is owned by our program again (i.e. undelegated from the rollup). */
  async waitUndelegated(maxMs = 45000): Promise<boolean> {
    const conn = this.baseProvider.connection;
    const pid = this.program.programId;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      try { const info = await conn.getAccountInfo(this.book, "confirmed"); if (info && info.owner.equals(pid)) return true; } catch (_) {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }
  async fetchMyBalance(): Promise<UserBalanceJSON | null> {
    try { const b: any = await (this.program.account as any).userBalance.fetch(this.myBal()); return { owner: b.owner.toBase58(), baseFree: Number(b.baseFree), quoteFree: Number(b.quoteFree) }; }
    catch { return null; }
  }
  /** What the connected wallet actually holds (native SOL + USDC token) — what's available to deposit. */
  async fetchWalletHoldings(): Promise<{ sol: number; usdc: number }> {
    const conn = this.baseProvider.connection;
    let sol = 0, usdc = 0;
    try { sol = (await conn.getBalance(this.me)) / LAMPORTS_PER_SOL; } catch {}
    try { usdc = Number((await getAccount(conn, getAssociatedTokenAddressSync(this.quoteMint, this.me))).amount) / 1e6; } catch {}
    return { sol, usdc };
  }
}

function normalizeBook(b: any): BookJSON {
  const ord = (o: any): OrderJSON => ({ id: Number(o.id), owner: o.owner.toBase58(), price: Number(o.price), size: Number(o.size), side: Number(o.side) });
  const fil = (f: any): FillJSON => ({ id: Number(f.id), buyer: f.buyer.toBase58(), seller: f.seller.toBase58(), price: Number(f.price), size: Number(f.size), ts: Number(f.ts) });
  return {
    authority: b.authority.toBase58(), baseMint: b.baseMint.toBase58(), quoteMint: b.quoteMint.toBase58(),
    seq: Number(b.seq), settledSeq: Number(b.settledSeq), lastPrice: Number(b.lastPrice), tick: Number(b.tick), lot: Number(b.lot),
    bids: b.bids.map(ord).sort((a: OrderJSON, c: OrderJSON) => c.price - a.price),
    asks: b.asks.map(ord).sort((a: OrderJSON, c: OrderJSON) => a.price - c.price),
    fills: b.fills.map(fil).sort((a: FillJSON, c: FillJSON) => c.id - a.id),
  };
}


// Magic Router needs the blockhash keyed to the txn's writable accounts (custom RPC),
// not the standard getLatestBlockhash (which returns a base-layer hash the ER rejects).
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

export function makeProviders(wallet: anchor.Wallet, baseRpc = BASE_RPC, erRpc = ER_RPC, erWs = ER_WS) {
  const baseProvider = new anchor.AnchorProvider(new Connection(baseRpc, { commitment: "confirmed" }), wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(new Connection(erRpc, { wsEndpoint: erWs, commitment: "confirmed" }), wallet, { commitment: "confirmed" });
  return { baseProvider, erProvider };
}
