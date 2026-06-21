/**
 * Shared config + helpers for the Shade backend services (crank, maker, faucet).
 * Everything is env-driven so the same build runs locally and on the VPS.
 */
import "dotenv/config";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ---- on-chain seeds / scaling (must match programs/shade/src/lib.rs) ----
export const BOOK_SEED = "book_v5";
export const BAL_SEED = "bal";
export const VAULT_AUTH_SEED = "vault";
export const VAULT_BASE_SEED = "vault_base";
export const VAULT_QUOTE_SEED = "vault_quote";
export const SIDE_BID = 0;
export const SIDE_ASK = 1;
export const BASE_LAMPORTS_PER_SIZE = 1_000_000; // 0.001 SOL per size unit
export const QUOTE_MICRO_MULT = 10;
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// ---- endpoints ----
export const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
export const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-router.magicblock.app";
export const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-router.magicblock.app";
export const ER_VALIDATOR = new PublicKey(process.env.VALIDATOR || "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");

// ---- IDL ----
const IDL_PATH = process.env.IDL_PATH || path.join(__dirname, "..", "idl", "shade.json");
export const IDL = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function loadKp(): Keypair {
  const raw = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace(/^~/, os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(raw, "utf-8"))));
}

export function quoteMint(): PublicKey {
  const q = (process.env.USDC_MINT || "").trim();
  if (!q) throw new Error("USDC_MINT not set in env");
  return new PublicKey(q);
}

/** A fully wired Shade context: providers, programs, and PDA helpers. */
export function makeCtx(kp = loadKp()) {
  const wallet = new anchor.Wallet(kp);
  const baseConn = new Connection(BASE_RPC, "confirmed");
  const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
  const program = new Program(IDL, baseProvider);
  const erProgram = new Program(IDL, erProvider);
  const programId = program.programId;

  const book = PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], programId)[0];
  const vaultAuth = PublicKey.findProgramAddressSync([Buffer.from(VAULT_AUTH_SEED), book.toBuffer()], programId)[0];
  const vaultBase = PublicKey.findProgramAddressSync([Buffer.from(VAULT_BASE_SEED), book.toBuffer()], programId)[0];
  const vaultQuote = PublicKey.findProgramAddressSync([Buffer.from(VAULT_QUOTE_SEED), book.toBuffer()], programId)[0];
  const balPda = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from(BAL_SEED), book.toBuffer(), owner.toBuffer()], programId)[0];

  return { kp, wallet, baseConn, erConn, baseProvider, erProvider, program, erProgram, programId, book, vaultAuth, vaultBase, vaultQuote, balPda };
}
export type Ctx = ReturnType<typeof makeCtx>;

/**
 * Magic Router needs a blockhash keyed to the txn's writable accounts (custom RPC),
 * not the standard getLatestBlockhash. Handles both `result.value` and `result` shapes.
 */
export async function routerBlockhash(endpoint: string, tx: Transaction): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
  const writable = new Set<string>();
  if (tx.feePayer) writable.add(tx.feePayer.toBase58());
  for (const ix of tx.instructions) for (const k of ix.keys) if (k.isWritable) writable.add(k.pubkey.toBase58());
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockhashForAccounts", params: [Array.from(writable)] }),
  });
  const data: any = await res.json();
  const bh = data?.result?.value ?? data?.result;
  if (!bh?.blockhash) throw new Error("router getBlockhashForAccounts failed: " + JSON.stringify(data).slice(0, 200));
  return { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

/** Send + confirm a transaction on the Ephemeral Rollup via the Magic Router. */
export async function sendOnER(ctx: Ctx, tx: Transaction): Promise<string> {
  tx.feePayer = ctx.kp.publicKey;
  const { blockhash, lastValidBlockHeight } = await routerBlockhash(ctx.erConn.rpcEndpoint, tx);
  tx.recentBlockhash = blockhash;
  const signed = await ctx.wallet.signTransaction(tx);
  const sig = await ctx.erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
  const conf = await ctx.erConn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error("ER tx failed: " + JSON.stringify(conf.value.err));
  return sig;
}

/** Is the book currently sitting on the base layer (owned by our program), i.e. NOT delegated? */
export async function bookOnBase(ctx: Ctx): Promise<boolean> {
  const info = await ctx.baseConn.getAccountInfo(ctx.book, "confirmed");
  return !!(info && info.owner.equals(ctx.programId));
}
