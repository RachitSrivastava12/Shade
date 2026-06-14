/**
 * One-shot setup for a FRESH deploy: creates the order book + token vaults on the base layer.
 * Self-contained (no app imports) so ts-node runs it cleanly.
 *   npm run bootstrap
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, Connection, SystemProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";

const IDL = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/shade.json"), "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC = new PublicKey((process.env.USDC_MINT || "").trim());
const BOOK_SEED = "book_v5", VAULT_AUTH_SEED = "vault", VAULT_BASE_SEED = "vault_base", VAULT_QUOTE_SEED = "vault_quote";

const kpPath = (process.env.ANCHOR_WALLET || process.env.WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath, "utf-8"))));
const wallet = new anchor.Wallet(kp);
const conn = new Connection(BASE_RPC, "confirmed");
const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
const program = new Program(IDL, provider);
const pid = program.programId;

const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const book = pda([Buffer.from(BOOK_SEED)]);
const vaultAuth = pda([Buffer.from(VAULT_AUTH_SEED), book.toBuffer()]);
const vaultBase = pda([Buffer.from(VAULT_BASE_SEED), book.toBuffer()]);
const vaultQuote = pda([Buffer.from(VAULT_QUOTE_SEED), book.toBuffer()]);

(async () => {
  if (!process.env.USDC_MINT) { console.error("set USDC_MINT first"); process.exit(1); }
  console.log("Shade bootstrap");
  console.log("  program   :", pid.toBase58());
  console.log("  wallet    :", kp.publicKey.toBase58());
  console.log("  quote mint:", USDC.toBase58());
  console.log("  book PDA  :", book.toBase58(), "\n");

  try {
    const sig = await program.methods.initializeBook(new BN(100), new BN(1))
      .accounts({ authority: kp.publicKey, baseMint: NATIVE_MINT, quoteMint: USDC })
      .rpc({ skipPreflight: true });
    console.log("  initialize_book OK", sig.slice(0, 12));
  } catch (e: any) { console.log("  initialize_book -", (e.message || e).toString().slice(0, 100)); }

  try {
    const sig = await program.methods.initVaults()
      .accounts({
        book, payer: kp.publicKey, baseMint: NATIVE_MINT, quoteMint: USDC,
        vaultAuth, vaultBase, vaultQuote,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).rpc({ skipPreflight: true });
    console.log("  init_vaults     OK", sig.slice(0, 12));
  } catch (e: any) { console.log("  init_vaults     -", (e.message || e).toString().slice(0, 100)); }

  const b: any = await (program.account as any).orderBook.fetch(book);
  console.log(`\n  book ready - asks:${b.asks.length} bids:${b.bids.length} fills:${b.fills.length} seq:${Number(b.seq)}`);
  console.log("\n  next: npm run crank   (terminal 1)   +   cd app && npm run dev   (terminal 2)\n");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });