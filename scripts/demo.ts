/**
 * Shade — end-to-end demo on Solana devnet + MagicBlock ER.
 *
 *   1. initialize the book on the base layer
 *   2. delegate it to the Ephemeral Rollup
 *   3. stream a few orders straight onto the ER (gasless, low-latency)
 *   4. watch them cross + fill inside the ER
 *   5. commit the book state back to the base layer
 *
 * Run:  yarn demo     (after `anchor build && anchor deploy`)
 */
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import os from "os";
import path from "path";
import { Keypair } from "@solana/web3.js";
import {
  ShadeClient,
  makeProviders,
  SIDE_BID,
  SIDE_ASK,
} from "../shade-client";

const IDL_PATH = path.join(__dirname, "../target/idl/shade.json");

function loadWallet(): anchor.Wallet {
  const kpPath =
    process.env.WALLET || path.join(os.homedir(), ".config/solana/id.json");
  const secret = JSON.parse(fs.readFileSync(kpPath, "utf-8"));
  return new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  const out = await fn();
  console.log(`  ${String(Date.now() - t).padStart(5)}ms  ${label}`);
  return out;
}

function printBook(b: any) {
  console.log("\n  ── BOOK ──────────────────────────────");
  console.log("   ASKS:", b.asks.map((o: any) => `${o.price}x${o.size}`).join("  ") || "—");
  console.log("   last:", b.lastPrice || "—");
  console.log("   BIDS:", b.bids.map((o: any) => `${o.price}x${o.size}`).join("  ") || "—");
  console.log("   FILLS:", b.fills.length, b.fills.slice(0, 3).map((f: any) => `${f.price}x${f.size}`).join(" "));
  console.log("  ──────────────────────────────────────\n");
}

(async () => {
  const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf-8"));
  const wallet = loadWallet();
  const { baseProvider, erProvider } = makeProviders(wallet);

  console.log("Shade demo");
  console.log("  base :", baseProvider.connection.rpcEndpoint);
  console.log("  ER   :", erProvider.connection.rpcEndpoint);
  console.log("  wallet:", wallet.publicKey.toBase58(), "\n");

  const client = new ShadeClient(idl, baseProvider, erProvider);
  console.log("  book PDA:", client.book.toBase58(), "\n");

  // 1. init (idempotent)
  try {
    await timed("(base) initialize_book", () => client.initializeBook(100, 1));
  } catch (e) {
    console.log("  initialize_book skipped (already exists)");
  }

  // 2. delegate to ER
  await timed("(base) delegate -> ER", () => client.delegate());
  await new Promise((r) => setTimeout(r, 3000)); // let delegation settle

  // 3. stream orders onto the ER
  await timed("(ER)   place ASK 18740 x 10", () => client.placeOrder(SIDE_ASK, 18740, 10));
  await timed("(ER)   place ASK 18738 x 15", () => client.placeOrder(SIDE_ASK, 18738, 15));
  await timed("(ER)   place BID 18735 x 8 ", () => client.placeOrder(SIDE_BID, 18735, 8));
  // this one crosses 18738 -> should fill
  await timed("(ER)   place BID 18742 x 12 (crosses!)", () => client.placeOrder(SIDE_BID, 18742, 12));

  printBook(await client.fetchBookER());

  // 4. explicit crank match (no-op if already cleared inline)
  await timed("(ER)   match_book (crank)", () => client.matchBook());

  // 5. commit ER state -> base layer
  await timed("(ER)   commit_book -> base layer", () => client.commitBook());

  console.log("\nbase-layer view after commit:");
  printBook(await client.fetchBookBase());

  console.log("done. orders matched on the ER, settled to mainnet.\n");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
