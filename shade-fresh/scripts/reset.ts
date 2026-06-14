/**
 * Reset the Shade book from the CLI wallet (the original delegator).
 * Undelegates if needed, then re-initializes the book (clears stale fills + settledSeq).
 *
 *   export ANCHOR_WALLET=~/.config/solana/id.json
 *   export PROVIDER_ENDPOINT=<your quicknode devnet url>
 *   export USDC_MINT=<your mock usdc mint>
 *   npm run reset
 */
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, Connection, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";

const IDL = JSON.parse(fs.readFileSync("target/idl/shade.json", "utf-8"));
const BASE_RPC = process.env.PROVIDER_ENDPOINT || "https://api.devnet.solana.com";
const ER_RPC = process.env.EPHEMERAL_PROVIDER_ENDPOINT || "https://devnet-as.magicblock.app/";
const ER_WS = process.env.EPHEMERAL_WS_ENDPOINT || "wss://devnet-as.magicblock.app/";
const BOOK_SEED = "book_v5";

function loadKp(): Keypair {
  const path = (process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/id.json`).replace("~", os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf-8"))));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...a: any[]) => console.log(...a);

async function main() {
  const usdc = (process.env.USDC_MINT || "").trim();
  if (!usdc) throw new Error("set USDC_MINT");
  const USDC = new PublicKey(usdc);
  const kp = loadKp();
  const wallet = new anchor.Wallet(kp);
  const baseConn = new Connection(BASE_RPC, "confirmed");
  const erConn = new Connection(ER_RPC, { wsEndpoint: ER_WS, commitment: "confirmed" });
  const baseProvider = new anchor.AnchorProvider(baseConn, wallet, { commitment: "confirmed" });
  const erProvider = new anchor.AnchorProvider(erConn, wallet, { commitment: "confirmed" });
  const program = new Program(IDL, baseProvider);
  const erProgram = new Program(IDL, erProvider);
  const book = PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED)], program.programId)[0];

  log("wallet:", kp.publicKey.toBase58());
  log("book  :", book.toBase58());

  // who owns the book right now?
  const info = await baseConn.getAccountInfo(book, "confirmed");
  const owner = info?.owner.toBase58();
  log("book owner:", owner, owner === program.programId.toBase58() ? "(undelegated)" : "(delegated)");

  // 1. if delegated, undelegate it via the ER (commit + undelegate)
  if (info && owner !== program.programId.toBase58()) {
    log("→ undelegating via ER…");
    try {
      const tx = await erProgram.methods.settleAndUndelegate().accounts({ payer: kp.publicKey, book }).transaction();
      tx.feePayer = kp.publicKey;
      tx.recentBlockhash = (await erConn.getLatestBlockhash()).blockhash;
      const signed = await wallet.signTransaction(tx);
      const sig = await erConn.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      await erConn.confirmTransaction(sig, "confirmed");
      log("  undelegate sent:", sig);
    } catch (e: any) { log("  undelegate error (continuing):", (e.message || e).toString().slice(0, 120)); }

    // wait until ownership returns to our program
    for (let i = 0; i < 30; i++) {
      const n = await baseConn.getAccountInfo(book, "confirmed");
      if (n && n.owner.equals(program.programId)) { log("  book back on base ✓"); break; }
      log("  waiting for undelegation…");
      await sleep(2000);
    }
  }

  // 2. re-initialize the book (clears fills + settledSeq)
  log("→ resetting book (clearing stale fills)…");
  const sig = await program.methods.initializeBook(new BN(100), new BN(1))
    .accounts({ authority: kp.publicKey, baseMint: NATIVE_MINT, quoteMint: USDC })
    .rpc({ skipPreflight: true });
  log("  book reset ✓", sig);

  const b: any = await program.account.orderBook.fetch(book);
  log("\nbook is clean → fills:", b.fills.length, "| settledSeq:", Number(b.settledSeq), "| seq:", Number(b.seq));
  log("done. reopen the app — the engine will delegate a fresh book and run clean.");
}
main().catch((e) => { console.error(e); process.exit(1); });
