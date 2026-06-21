/**
 * Shade test faucet. Lets a visitor's wallet get mock USDC (so they can BUY) plus a
 * little devnet SOL for gas + wrapping. The maker wallet is the USDC mint authority,
 * so it can mint on demand.
 *
 *   POST /faucet  { "address": "<base58 pubkey>" }   -> mints USDC + sends SOL
 *   GET  /health                                     -> { ok: true }
 *
 *   npm run faucet
 *   pm2 start ecosystem.config.cjs --only shade-faucet
 */
import * as http from "http";
import { PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import { makeCtx, quoteMint, log } from "./config";

const PORT = Number(process.env.FAUCET_PORT || 8787);
const USDC_AMOUNT = Number(process.env.FAUCET_USDC || 1000);      // mock USDC per claim
const SOL_AMOUNT = Number(process.env.FAUCET_SOL || 0.05);        // gas + wrapping
const COOLDOWN_MS = Number(process.env.FAUCET_COOLDOWN_MS || 6 * 60 * 60 * 1000); // 6h per address
const ALLOW_ORIGIN = process.env.FAUCET_CORS_ORIGIN || "*";

const ctx = makeCtx();
const usdc = quoteMint();
const lastClaim = new Map<string, number>();

function cors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function send(res: http.ServerResponse, code: number, body: any) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function drip(address: string): Promise<string> {
  const dest = new PublicKey(address); // throws on invalid
  const me = ctx.kp.publicKey;
  const ata = getAssociatedTokenAddressSync(usdc, dest);
  const tx = new Transaction();
  try { await getAccount(ctx.baseConn, ata); }
  catch { tx.add(createAssociatedTokenAccountInstruction(me, ata, dest, usdc)); }
  tx.add(createMintToInstruction(usdc, ata, me, Math.round(USDC_AMOUNT * 1e6)));
  if (SOL_AMOUNT > 0) tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: dest, lamports: Math.round(SOL_AMOUNT * LAMPORTS_PER_SOL) }));
  return ctx.baseProvider.sendAndConfirm(tx, [], { skipPreflight: false });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }
  if (req.method === "GET" && req.url?.startsWith("/health")) return send(res, 200, { ok: true, mint: usdc.toBase58(), usdc: USDC_AMOUNT, sol: SOL_AMOUNT });
  if (req.method !== "POST" || !req.url?.startsWith("/faucet")) return send(res, 404, { error: "not found" });

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e4) req.destroy(); });
  req.on("end", async () => {
    let address = "";
    try { address = (JSON.parse(body || "{}").address || "").trim(); } catch { return send(res, 400, { error: "bad json" }); }
    if (!address) return send(res, 400, { error: "address required" });
    let dest: string;
    try { dest = new PublicKey(address).toBase58(); } catch { return send(res, 400, { error: "invalid address" }); }

    const now = Date.now();
    const last = lastClaim.get(dest) || 0;
    if (now - last < COOLDOWN_MS) {
      const mins = Math.ceil((COOLDOWN_MS - (now - last)) / 60000);
      return send(res, 429, { error: `already funded — try again in ~${mins} min` });
    }
    lastClaim.set(dest, now); // reserve the slot before the async send to avoid double-claims
    try {
      const sig = await drip(dest);
      log(`faucet → ${dest.slice(0, 6)}… ${USDC_AMOUNT} USDC + ${SOL_AMOUNT} SOL  ${sig.slice(0, 8)}`);
      send(res, 200, { ok: true, sig, usdc: USDC_AMOUNT, sol: SOL_AMOUNT, explorer: `https://solscan.io/tx/${sig}?cluster=devnet` });
    } catch (e: any) {
      lastClaim.delete(dest); // failed — let them retry
      log("faucet err:", (e.message || e).toString().slice(0, 140));
      send(res, 500, { error: (e.message || e).toString().slice(0, 200) });
    }
  });
});

server.listen(PORT, () => {
  log("SHADE FAUCET");
  log("  wallet:", ctx.kp.publicKey.toBase58());
  log("  mint  :", usdc.toBase58());
  log(`  serving on :${PORT}  (POST /faucet { address }, GET /health)\n`);
});
