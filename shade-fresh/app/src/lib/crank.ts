import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { ShadeClient, makeProviders, BASE_RPC, ER_RPC, ER_WS } from "./shade";

const LS_KEY = "shade_crank_sk_v1";

// anchor.Wallet (NodeWallet) is not available in the browser bundle — use a local signer.
class KeypairWallet {
  constructor(public payer: Keypair) {}
  get publicKey() { return this.payer.publicKey; }
  async signTransaction(tx: any) {
    if (tx.version !== undefined) tx.sign([this.payer]); else tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions(txs: any[]) {
    for (const tx of txs) { if (tx.version !== undefined) tx.sign([this.payer]); else tx.partialSign(this.payer); }
    return txs;
  }
}

/** Persistent devnet crank keypair (stored in localStorage so it's stable across reloads). */
export function getCrankKeypair(): Keypair {
  try {
    const sk = localStorage.getItem(LS_KEY);
    if (sk) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(sk)));
  } catch (_) {}
  const kp = Keypair.generate();
  try { localStorage.setItem(LS_KEY, JSON.stringify(Array.from(kp.secretKey))); } catch (_) {}
  return kp;
}

export type CrankStatus = { phase: string; address: string; balanceSol: number; funded: boolean };

/**
 * The Shade "engine": keeps the book delegated to the rollup and settles fills
 * automatically, so a trader only ever deposits + places orders.
 */
export class Crank {
  client: ShadeClient;
  kp: Keypair;
  running = false;
  paused = false;
  private timer: any = null;
  onStatus?: (s: CrankStatus) => void;
  private phase = "starting…";

  constructor(idl: anchor.Idl, kp: Keypair, quoteMint?: PublicKey, onStatus?: (s: CrankStatus) => void) {
    this.kp = kp;
    const wallet = new KeypairWallet(kp);
    const baseRpc = ((import.meta as any).env?.VITE_PROVIDER_ENDPOINT as string) || BASE_RPC;
    const { baseProvider, erProvider } = makeProviders(wallet as any, baseRpc, ER_RPC, ER_WS);
    this.client = new ShadeClient(idl, baseProvider, erProvider, quoteMint ? { quoteMint } : undefined);
    this.onStatus = onStatus;
    console.log("%cSHADE ENGINE ADDRESS → fund it with ~1 devnet SOL:", "color:#e9b872;font-weight:bold", kp.publicKey.toBase58());
  }

  get connection() { return this.client.baseProvider.connection; }

  async balanceSol(): Promise<number> {
    try { return (await this.connection.getBalance(this.kp.publicKey)) / LAMPORTS_PER_SOL; }
    catch { return 0; }
  }

  private async emit() {
    const bal = await this.balanceSol();
    this.onStatus?.({ phase: this.phase, address: this.kp.publicKey.toBase58(), balanceSol: bal, funded: bal >= 0.02 });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }
  stop() { this.running = false; if (this.timer) clearTimeout(this.timer); }

  private loop() {
    if (!this.running) return;
    this.tick().catch(() => {}).finally(() => {
      if (this.running) this.timer = setTimeout(() => this.loop(), 9000);
    });
  }

  pause() { this.paused = true; this.phase = "paused"; this.emit(); }
  resume() { this.paused = false; }

  /** Clears the book (drops stale fills + resets settledSeq) so settlement runs clean. */
  async resetBook() {
    this.pause();
    this.phase = "resetting book…"; await this.emit();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      try { await this.client.fetchBookER(); await this.client.settleAndUndelegate(); } catch (_) {}
      await this.client.waitUndelegated();
      await this.client.initializeBook();
      this.phase = "book reset · resuming"; await this.emit();
    } catch (e: any) {
      console.error("[shade reset] full error:", e, e?.logs);
      this.phase = "reset failed: " + (e.message || e).toString().slice(0, 60); await this.emit();
    } finally {
      this.resume();
    }
  }

  private async tick() {
    if (this.paused) { this.phase = "paused"; await this.emit(); return; }
    const bal = await this.balanceSol();
    if (bal < 0.02) { this.phase = "needs funding"; await this.emit(); return; }

    // 1. is the book live on the rollup? if not, delegate it.
    let erBook: any = null;
    try { erBook = await this.client.fetchBookER(); }
    catch {
      this.phase = "delegating to rollup…"; await this.emit();
      try { await this.client.delegate(); this.phase = "live · matching on rollup"; } catch (_) { this.phase = "delegating…"; }
      await this.emit();
      return;
    }

    // 2. any fills to settle?
    const unsettled = (erBook.fills || []).filter((f: any) => f.id > erBook.settledSeq);
    if (unsettled.length === 0) { this.phase = "live · matching on rollup"; await this.emit(); return; }

    // 3. settle: commit+undelegate → move balances → re-delegate
    this.phase = `settling ${unsettled.length} fill(s)…`; await this.emit();
    try {
      await this.client.settleAndUndelegate();
      await this.client.settleAll();
      await this.client.delegate();
      this.phase = "settled · live again";
    } catch (e) {
      console.error("[shade settle] full error:", e, (e as any)?.logs);
      try { await this.client.delegate(); } catch (_) {}
      this.phase = "recovering…";
    }
    await this.emit();
  }
}
