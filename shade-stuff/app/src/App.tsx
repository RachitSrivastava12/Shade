import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import {
  ShadeClient,
  makeProviders,
  SIDE_BID,
  SIDE_ASK,
  BookJSON,
} from "./lib/shade";
import { ShadeWordmark } from "./Logo";

const ENV = (import.meta as any).env || {};
const BASE_RPC = ENV.VITE_BASE_RPC || "https://api.devnet.solana.com";
const ER_RPC = ENV.VITE_ER_RPC || "https://devnet-as.magicblock.app/";
const ER_WS = ENV.VITE_ER_WS || "wss://devnet-as.magicblock.app/";

type Status = { kind: "idle" | "busy" | "ok" | "err"; msg: string; ms?: number };
type LogRow = { label: string; ms: number; layer: "ER" | "base" };

// Eclipse depth meter — corona arcs scale with bid/ask depth.
function Eclipse({ book }: { book: BookJSON | null }) {
  const bidDepth = (book?.bids || []).reduce((s, o) => s + o.size, 0);
  const askDepth = (book?.asks || []).reduce((s, o) => s + o.size, 0);
  const total = bidDepth + askDepth || 1;
  const bidPct = Math.max(2, Math.round((bidDepth / total) * 48));
  const askPct = Math.max(2, Math.round((askDepth / total) * 48));
  const last = book?.lastPrice ? (book.lastPrice / 100).toFixed(2) : "—";

  return (
    <div className="eclipse-wrap">
      <div className="eclipse">
        <svg viewBox="0 0 168 168">
          <defs>
            <filter id="ec-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.4" />
            </filter>
          </defs>
          {/* faint corona ring */}
          <circle cx="84" cy="84" r="62" fill="none" stroke="#e9b872"
            strokeWidth="1" opacity="0.22" />
          {/* bid corona (jade), starts bottom, sweeps left */}
          <circle cx="84" cy="84" r="62" fill="none" stroke="#4ade9e" strokeWidth="3"
            pathLength={100} strokeDasharray={`${bidPct} 100`} strokeLinecap="round"
            transform="rotate(90 84 84)" filter="url(#ec-glow)" opacity="0.9" />
          {/* ask corona (coral), starts top, sweeps right */}
          <circle cx="84" cy="84" r="62" fill="none" stroke="#f2616b" strokeWidth="3"
            pathLength={100} strokeDasharray={`${askPct} 100`} strokeLinecap="round"
            transform="rotate(270 84 84)" filter="url(#ec-glow)" opacity="0.9" />
          {/* dark sphere */}
          <circle cx="84" cy="84" r="50" fill="#08090c" />
          <circle cx="84" cy="84" r="50" fill="none" stroke="#f0ead6" strokeWidth="0.5" opacity="0.08" />
        </svg>
        <div className="eclipse-center">
          <span className="lab">mid · last fill</span>
          <span className="val tnum">{last}</span>
        </div>
      </div>
      <div className="eclipse-legend">
        <span><span className="dot" style={{ background: "#4ade9e" }} />bids {bidDepth}</span>
        <span><span className="dot" style={{ background: "#f2616b" }} />asks {askDepth}</span>
      </div>
    </div>
  );
}

export default function App() {
  const wallet = useAnchorWallet();
  useConnection();
  const [idl, setIdl] = useState<anchor.Idl | null>(null);
  const [idlError, setIdlError] = useState(false);
  const [book, setBook] = useState<BookJSON | null>(null);
  const [prevLast, setPrevLast] = useState(0);
  const [src, setSrc] = useState<"ER" | "base" | "—">("—");
  const [status, setStatus] = useState<Status>({ kind: "idle", msg: "ready" });
  const [log, setLog] = useState<LogRow[]>([]);

  const [side, setSide] = useState<number>(SIDE_BID);
  const [price, setPrice] = useState("18735");
  const [size, setSize] = useState("10");
  const [adv, setAdv] = useState(false);

  useEffect(() => {
    fetch("/shade.json")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setIdl)
      .catch(() => setIdlError(true));
  }, []);

  const client = useMemo(() => {
    if (!idl || !wallet) return null;
    const { baseProvider, erProvider } = makeProviders(wallet as any, BASE_RPC, ER_RPC, ER_WS);
    return new ShadeClient(idl, baseProvider, erProvider);
  }, [idl, wallet]);

  const refresh = useCallback(async () => {
    if (!client) return;
    try {
      const b = await client.fetchBookER();
      setBook((p) => { setPrevLast(p?.lastPrice || 0); return b; });
      setSrc("ER");
    } catch {
      try {
        const b = await client.fetchBookBase();
        setBook((p) => { setPrevLast(p?.lastPrice || 0); return b; });
        setSrc("base");
      } catch { setSrc("—"); }
    }
  }, [client]);

  useEffect(() => {
    if (!client) return;
    refresh();
    const t = setInterval(refresh, 1200);
    return () => clearInterval(t);
  }, [client, refresh]);

  const run = async (label: string, layer: "ER" | "base", fn: () => Promise<string>) => {
    setStatus({ kind: "busy", msg: label });
    const t = Date.now();
    try {
      await fn();
      const ms = Date.now() - t;
      setStatus({ kind: "ok", msg: label, ms });
      setLog((l) => [{ label, ms, layer }, ...l].slice(0, 8));
      setTimeout(refresh, 350);
    } catch (e: any) {
      setStatus({ kind: "err", msg: `${label} — ${e.message || e}` });
    }
  };

  const me = wallet?.publicKey?.toBase58();
  const short = (s: string) => s.slice(0, 4) + "…" + s.slice(-4);
  const fmtPx = (p: number) => (p / 100).toFixed(2);
  const lastDir = (book?.lastPrice || 0) >= prevLast ? "up" : "down";
  const bestBid = book?.bids?.[0]?.price;
  const bestAsk = book?.asks?.[0]?.price;
  const spread = bestBid && bestAsk ? ((bestAsk - bestBid) / 100).toFixed(2) : "—";

  return (
    <div className="shell">
      <div className="topbar">
        <div className="topbar-left">
          <ShadeWordmark size={30} />
          <div className="market-chip">
            <span className="pair">SOL / USDC</span>
            <span className="px tnum">{book?.lastPrice ? fmtPx(book.lastPrice) : "—"}</span>
          </div>
        </div>
        <div className="topbar-right">
          <span className={`live-badge ${src === "ER" ? "on" : ""}`}>
            <span className="pip" />
            {src === "ER" ? "live · ephemeral rollup" : src === "base" ? "base layer" : "offline"}
          </span>
          <WalletMultiButton />
        </div>
      </div>

      {idlError && (
        <div className="banner">
          Program interface not found. Run <code>anchor build</code>, then{" "}
          <code>cp target/idl/shade.json app/public/</code> and reload.
        </div>
      )}

      <div className="grid">
        {/* ── ORDER BOOK ── */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">Order Book</span>
            <span className="card-note">{src === "ER" ? "hidden until fill" : "committed"}</span>
          </div>
          <div className="book-cols"><span>Price</span><span>Size</span><span>Owner</span></div>

          <div className="book-side asks">
            {(book?.asks || []).slice(0, 7).map((o) => (
              <div className="lvl ask" key={`a${o.id}`}>
                <span className="bar" style={{ width: `${Math.min(100, o.size * 4)}%` }} />
                <span className="px tnum">{fmtPx(o.price)}</span>
                <span className="sz tnum">{o.size}</span>
                <span className={`who ${o.owner === me ? "you" : ""}`}>{o.owner === me ? "you" : short(o.owner)}</span>
              </div>
            ))}
            {!book?.asks?.length && <div className="empty">no asks resting</div>}
          </div>

          <div className="book-mid">
            <span className={`last tnum ${lastDir}`}>{book?.lastPrice ? fmtPx(book.lastPrice) : "—"}</span>
            <span className="spread">spread {spread}</span>
          </div>

          <div className="book-side bids">
            {(book?.bids || []).slice(0, 7).map((o) => (
              <div className="lvl bid" key={`b${o.id}`}>
                <span className="bar" style={{ width: `${Math.min(100, o.size * 4)}%` }} />
                <span className="px tnum">{fmtPx(o.price)}</span>
                <span className="sz tnum">{o.size}</span>
                <span className={`who ${o.owner === me ? "you" : ""}`}>{o.owner === me ? "you" : short(o.owner)}</span>
              </div>
            ))}
            {!book?.bids?.length && <div className="empty">no bids resting</div>}
          </div>
        </div>

        {/* ── TRADE ── */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">Trade</span>
            <span className="card-note">executes on the rollup</span>
          </div>

          <Eclipse book={book} />

          <div className="trade">
            <div className="seg">
              <button className={`${side === SIDE_BID ? "on buy" : ""}`} onClick={() => setSide(SIDE_BID)}>Buy</button>
              <button className={`${side === SIDE_ASK ? "on sell" : ""}`} onClick={() => setSide(SIDE_ASK)}>Sell</button>
            </div>

            <div className="field">
              <label>Size — SOL</label>
              <input value={size} onChange={(e) => setSize(e.target.value)} inputMode="decimal" />
            </div>

            {adv ? (
              <div className="field">
                <label>Limit price — USDC</label>
                <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
                <div className="hint">stored on-chain ×100 ({price} → {fmtPx(Number(price) || 0)})</div>
              </div>
            ) : (
              <button className="adv-toggle" onClick={() => setAdv(true)}>+ set limit price</button>
            )}
            {adv && <button className="adv-toggle" onClick={() => setAdv(false)}>– hide limit price</button>}

            <button
              className={`cta ${side === SIDE_BID ? "buy" : "sell"}`}
              disabled={!client}
              onClick={() => run(`place ${side === SIDE_BID ? "buy" : "sell"} order`, "ER",
                () => client!.placeOrder(side, Number(price), Number(size)))}
            >
              {!client ? "connect wallet to trade" : side === SIDE_BID ? "Buy in shade" : "Sell in shade"}
            </button>

            <div className="lifecycle">
              <div className="lifecycle-title">Market lifecycle</div>
              <div className="steps">
                <button className="step" disabled={!client} onClick={() => run("initialize book", "base", () => client!.initializeBook(100, 1))}>
                  <span className="idx">01</span> create the book
                </button>
                <button className="step" disabled={!client} onClick={() => run("delegate to rollup", "base", () => client!.delegate())}>
                  <span className="idx">02</span> delegate to rollup
                </button>
                <button className="step" disabled={!client} onClick={() => run("match book", "ER", () => client!.matchBook())}>
                  <span className="idx">03</span> run matching pass
                </button>
                <button className="step" disabled={!client} onClick={() => run("commit to Solana", "ER", () => client!.commitBook())}>
                  <span className="idx">04</span> commit to Solana
                </button>
              </div>
            </div>

            <div className={`toast ${status.kind}`}>
              {status.kind === "busy" && <span className="spin" />}
              {status.kind === "ok" && "✓"}
              {status.kind === "err" && "✕"}
              <span>{status.msg}</span>
              {status.ms != null && <span className="ms tnum">{status.ms}ms</span>}
            </div>
          </div>
        </div>

        {/* ── FILLS + SESSION ── */}
        <div className="card">
          <div className="card-head">
            <span className="card-title">Recent Fills</span>
            <span className="card-note">settled on Solana</span>
          </div>
          {(book?.fills || []).slice(0, 9).map((f) => (
            <div className="fill" key={f.id}>
              <span className="px tnum">{fmtPx(f.price)}</span>
              <span className="sz tnum">{f.size}</span>
              <span className={`tag ${f.taker === me || f.maker === me ? "you" : ""}`}>
                {f.taker === me ? "you bought" : f.maker === me ? "you sold" : "matched"}
              </span>
            </div>
          ))}
          {!book?.fills?.length && <div className="empty">no fills yet —<br />place a buy and a sell that cross</div>}

          <div className="card-head" style={{ marginTop: 8 }}>
            <span className="card-title">Latency</span>
            <span className="card-note">measured, this session</span>
          </div>
          <div className="session">
            {log.length === 0 && <div className="empty" style={{ padding: "6px 0" }}>actions you run appear here</div>}
            {log.map((r, i) => (
              <div className="session-row" key={i}>
                <span>{r.layer === "ER" ? "rollup · " : "base · "}{r.label}</span>
                <span className="ms tnum">{r.ms}ms</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="foot">
        <span>Shade — open dark pool order book</span>
        <span>matched on MagicBlock · settled on Solana</span>
      </div>
    </div>
  );
}