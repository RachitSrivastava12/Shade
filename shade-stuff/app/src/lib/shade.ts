import * as anchor from "@coral-xyz/anchor";
import { Program, web3, BN } from "@coral-xyz/anchor";
import { PublicKey, Connection, Transaction } from "@solana/web3.js";

export const BOOK_SEED = "orderbook";
export const SIDE_BID = 0;
export const SIDE_ASK = 1;

// ── Endpoints (MagicBlock devnet) ──────────────────────────────────────────
// Browser-safe env read: works under Node (ts-node) and is harmless in Vite.
function nodeEnv(key: string): string | undefined {
  try {
    if (typeof process !== "undefined" && process.env) return process.env[key];
  } catch (_) {}
  return undefined;
}

export const BASE_RPC =
  nodeEnv("PROVIDER_ENDPOINT") || "https://api.devnet.solana.com";

export const ER_RPC =
  nodeEnv("EPHEMERAL_PROVIDER_ENDPOINT") || "https://devnet-as.magicblock.app/";

export const ER_WS =
  nodeEnv("EPHEMERAL_WS_ENDPOINT") || "wss://devnet-as.magicblock.app/";

// Default ER validator on devnet (override with VALIDATOR env if MagicBlock gives you one)
export const ER_VALIDATOR = new PublicKey(
  nodeEnv("VALIDATOR") || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57"
);

export interface OrderJSON {
  id: number;
  owner: string;
  price: number;
  size: number;
  side: number;
}
export interface FillJSON {
  id: number;
  maker: string;
  taker: string;
  price: number;
  size: number;
  ts: number;
}
export interface BookJSON {
  authority: string;
  seq: number;
  lastPrice: number;
  tick: number;
  lot: number;
  bids: OrderJSON[];
  asks: OrderJSON[];
  fills: FillJSON[];
}

export function bookPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BOOK_SEED)],
    programId
  )[0];
}

/**
 * ShadeClient wraps both the base-layer and ER providers and exposes
 * the full lifecycle: init -> delegate -> place/cancel/match (on ER) -> commit.
 */
export class ShadeClient {
  program: Program;
  erProgram: Program;
  baseProvider: anchor.AnchorProvider;
  erProvider: anchor.AnchorProvider;
  book: PublicKey;

  constructor(
    idl: anchor.Idl,
    baseProvider: anchor.AnchorProvider,
    erProvider: anchor.AnchorProvider
  ) {
    this.baseProvider = baseProvider;
    this.erProvider = erProvider;
    this.program = new Program(idl, baseProvider);
    this.erProgram = new Program(idl, erProvider);
    this.book = bookPda(this.program.programId);
  }

  // ---- base layer ----
  async initializeBook(tick = 100, lot = 1) {
    return this.program.methods
      .initializeBook(new BN(tick), new BN(lot))
      .accounts({ authority: this.baseProvider.wallet.publicKey })
      .rpc({ skipPreflight: true });
  }

  async delegate() {
    const tx = await this.program.methods
      .delegate()
      .accounts({
        payer: this.baseProvider.wallet.publicKey,
        pda: this.book,
      })
      .remainingAccounts([
        { pubkey: ER_VALIDATOR, isSigner: false, isWritable: false },
      ])
      .transaction();
    return this.baseProvider.sendAndConfirm(tx, [], { skipPreflight: true });
  }

  // ---- ER layer (low latency) ----
  private async sendOnER(tx: Transaction) {
    tx.feePayer = this.erProvider.wallet.publicKey;
    tx.recentBlockhash = (
      await this.erProvider.connection.getLatestBlockhash()
    ).blockhash;
    const signed = await this.erProvider.wallet.signTransaction(tx);
    return this.erProvider.sendAndConfirm(signed, [], { skipPreflight: true });
  }

  async placeOrder(side: number, price: number, size: number) {
    const tx = await this.erProgram.methods
      .placeOrder(side, new BN(price), new BN(size))
      .accounts({ book: this.book, trader: this.erProvider.wallet.publicKey })
      .transaction();
    return this.sendOnER(tx);
  }

  async cancelOrder(id: number) {
    const tx = await this.erProgram.methods
      .cancelOrder(new BN(id))
      .accounts({ book: this.book, trader: this.erProvider.wallet.publicKey })
      .transaction();
    return this.sendOnER(tx);
  }

  async matchBook() {
    const tx = await this.erProgram.methods
      .matchBook()
      .accounts({ book: this.book, trader: this.erProvider.wallet.publicKey })
      .transaction();
    return this.sendOnER(tx);
  }

  async commitBook() {
    const tx = await this.erProgram.methods
      .commitBook()
      .accounts({ payer: this.erProvider.wallet.publicKey, book: this.book })
      .transaction();
    return this.sendOnER(tx);
  }

  async settleAndUndelegate() {
    const tx = await this.erProgram.methods
      .settleAndUndelegate()
      .accounts({ payer: this.erProvider.wallet.publicKey, book: this.book })
      .transaction();
    return this.sendOnER(tx);
  }

  // ---- reads ----
  /** Read the book from the ER (live, low-latency state). */
  async fetchBookER(): Promise<BookJSON> {
    return normalizeBook(await this.erProgram.account.orderBook.fetch(this.book));
  }
  /** Read the book from the base layer (last committed state). */
  async fetchBookBase(): Promise<BookJSON> {
    return normalizeBook(await this.program.account.orderBook.fetch(this.book));
  }
}

function normalizeBook(b: any): BookJSON {
  const ord = (o: any): OrderJSON => ({
    id: Number(o.id),
    owner: o.owner.toBase58(),
    price: Number(o.price),
    size: Number(o.size),
    side: Number(o.side),
  });
  const fil = (f: any): FillJSON => ({
    id: Number(f.id),
    maker: f.maker.toBase58(),
    taker: f.taker.toBase58(),
    price: Number(f.price),
    size: Number(f.size),
    ts: Number(f.ts),
  });
  return {
    authority: b.authority.toBase58(),
    seq: Number(b.seq),
    lastPrice: Number(b.lastPrice),
    tick: Number(b.tick),
    lot: Number(b.lot),
    bids: b.bids.map(ord).sort((a: OrderJSON, c: OrderJSON) => c.price - a.price),
    asks: b.asks.map(ord).sort((a: OrderJSON, c: OrderJSON) => a.price - c.price),
    fills: b.fills.map(fil).sort((a: FillJSON, c: FillJSON) => c.id - a.id),
  };
}

// Helper to build the two providers from a wallet + connections (used by scripts/frontend).
export function makeProviders(
  wallet: anchor.Wallet,
  baseRpc = BASE_RPC,
  erRpc = ER_RPC,
  erWs = ER_WS
) {
  const baseProvider = new anchor.AnchorProvider(
    new Connection(baseRpc, { commitment: "confirmed" }),
    wallet,
    { commitment: "confirmed" }
  );
  const erProvider = new anchor.AnchorProvider(
    new Connection(erRpc, { wsEndpoint: erWs, commitment: "confirmed" }),
    wallet,
    { commitment: "confirmed" }
  );
  return { baseProvider, erProvider };
}
