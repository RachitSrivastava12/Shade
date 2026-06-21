import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import * as anchor from "@coral-xyz/anchor";
import { ShadeClient, makeProviders, SIDE_BID, SIDE_ASK, BookJSON, bookPda } from "./lib/shade";
import { Crank, getCrankKeypair, CrankStatus } from "./lib/crank";
import { PublicKey } from "@solana/web3.js";
import { ShadeMark } from "./Logo";
import { TradingViewChart } from "./TradingViewChart";
import { MARKETS, Market, Stats, fetchAllTickers } from "./lib/markets";

const ENV = (import.meta as any).env || {};
const BASE_RPC = ENV.VITE_BASE_RPC || "https://api.devnet.solana.com";
// Magic Router — routes ER writes to whichever validator holds the delegated book and
// supports getBlockhashForAccounts (the backend crank/maker use the same endpoint).
const ER_RPC = ENV.VITE_ER_RPC || "https://devnet-router.magicblock.app";
const ER_WS = ENV.VITE_ER_WS || "wss://devnet-router.magicblock.app";
const FAUCET_URL = ENV.VITE_FAUCET_URL || "";

// on-chain size unit = 0.001 base token; price unit = quote-per-base ×100 (see program)
const SIZE_PER_UNIT = 0.001;
const TAKER_FEE = 0.0005;
const fmt = (n: number, d = 2) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const dec = (p: number) => (p < 1 ? 5 : 2);
const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(2)}K` : `$${fmt(n)}`);

type Status = { kind: "idle" | "busy" | "ok" | "err"; msg: string; ms?: number };

// real token logo with graceful fallback to lettered glyph
function TokenIcon({ m, size = 20 }: { m: Market; size?: number }) {
  const [err, setErr] = useState(false);
  if (err) return <span className="glyph" style={{ width: size, height: size, fontSize: size * 0.42 }}>{m.icon}</span>;
  return <img className="tlogo" src={m.logo} width={size} height={size} alt={m.base} onError={() => setErr(true)} />;
}

export default function App() {
  const wallet = useAnchorWallet();
  const [idl, setIdl] = useState<anchor.Idl | null>(null);
  const [idlError, setIdlError] = useState(false);
  const [market, setMarket] = useState<Market>(MARKETS[0]);
  const [tickers, setTickers] = useState<Record<string, Stats>>({});
  const [book, setBook] = useState<BookJSON | null>(null);
  const [prevLast, setPrevLast] = useState(0);
  const [src, setSrc] = useState<"ER" | "base" | "—">("—");
  const [leftTab, setLeftTab] = useState<"book" | "trades">("book");
  const [centerTab, setCenterTab] = useState<"chart" | "depth">("chart");
  const [botTab, setBotTab] = useState<"orders" | "history">("orders");
  const [side, setSide] = useState(SIDE_BID);
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("");
  const [slip, setSlip] = useState(0.5);
  const [ops, setOps] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: "idle", msg: "ready" });
  const [marketSel, setMarketSel] = useState(false);
  const [lastTx, setLastTx] = useState<{ label: string; sig: string; layer: "base" | "er" } | null>(null);
  const [bal, setBal] = useState<{ baseFree: number; quoteFree: number } | null>(null);
  const [depSol, setDepSol] = useState("0.05");
  const [depUsdc, setDepUsdc] = useState("100");
  const [funds, setFunds] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState("");
  const [faucetBusy, setFaucetBusy] = useState(false);
  const [engine, setEngine] = useState<CrankStatus | null>(null);
  const crankRef = useRef<Crank | null>(null);

  // resizable / collapsible layout
  const [leftW, setLeftW] = useState(300);
  const [rightW, setRightW] = useState(312);
  const [botH, setBotH] = useState(188);
  const [leftOpen, setLeftOpen] = useState(true);
  const [botOpen, setBotOpen] = useState(true);
  const drag = useRef<{ type: string; sx: number; sy: number; lw: number; rw: number; bh: number } | null>(null);

  const startDrag = (type: "left" | "right" | "bottom", e: React.MouseEvent) => {
    e.preventDefault();
    drag.current = { type, sx: e.clientX, sy: e.clientY, lw: leftW, rw: rightW, bh: botH };
    const move = (ev: MouseEvent) => {
      const d = drag.current; if (!d) return;
      if (d.type === "left") setLeftW(Math.min(480, Math.max(220, d.lw + (ev.clientX - d.sx))));
      if (d.type === "right") setRightW(Math.min(460, Math.max(260, d.rw - (ev.clientX - d.sx))));
      if (d.type === "bottom") setBotH(Math.min(380, Math.max(90, d.bh - (ev.clientY - d.sy))));
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    document.body.style.cursor = type === "bottom" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
  };

  const SOLSCAN = "https://solscan.io";
  const txUrl = (sig: string) => `${SOLSCAN}/tx/${sig}?cluster=devnet`;
  const accUrl = (a: string) => `${SOLSCAN}/account/${a}?cluster=devnet`;
  const programId = idl ? (() => { try { return new PublicKey((idl as any).address); } catch { return null; } })() : null;
  const bookAcct = programId ? bookPda(programId) : null;

  const stats = tickers[market.binance] || null;

  useEffect(() => { fetch("/shade.json").then((r) => (r.ok ? r.json() : Promise.reject())).then(setIdl).catch(() => setIdlError(true)); }, []);

  const client = useMemo(() => {
    if (!idl || !wallet) return null;
    const baseRpc = ((import.meta as any).env?.VITE_PROVIDER_ENDPOINT as string) || BASE_RPC;
    const { baseProvider, erProvider } = makeProviders(wallet as any, baseRpc, ER_RPC, ER_WS);
    const usdcEnv = (import.meta as any).env?.VITE_USDC_MINT as string | undefined;
    const quoteMint = usdcEnv ? new PublicKey(usdcEnv) : undefined;
    return new ShadeClient(idl, baseProvider, erProvider, quoteMint ? { quoteMint } : undefined);
  }, [idl, wallet]);

  // The engine now runs as ONE standalone CLI process (npm run crank), not in the browser —
  // so multiple wallets/tabs can't fight over delegating the same book.
  useEffect(() => {
    if (!idl) return;
    setEngine({ phase: "live · matching on rollup", address: "", balanceSol: 1, funded: true });
  }, [idl]);

  useEffect(() => {
    let alive = true;
    const load = () => fetchAllTickers(MARKETS.map((m) => m.binance)).then((t) => { if (alive && Object.keys(t).length) setTickers(t); });
    load(); const i = setInterval(load, 5000); return () => { alive = false; clearInterval(i); };
  }, []);

  useEffect(() => { const s = tickers[market.binance]; if (s) setPrice(s.price.toFixed(dec(s.price))); /* eslint-disable-next-line */ }, [market.key]);

  const refresh = useCallback(async () => {
    if (!client || !market.live) { setBook(null); setSrc("—"); return; }
    try { const b = await client.fetchBookER(); setBook((p) => { setPrevLast(p?.lastPrice || 0); return b; }); setSrc("ER"); }
    catch { try { const b = await client.fetchBookBase(); setBook((p) => { setPrevLast(p?.lastPrice || 0); return b; }); setSrc("base"); } catch { setSrc("—"); } }
  }, [client, market]);
  useEffect(() => { if (!client || !market.live) return; refresh(); const t = setInterval(refresh, 1500); return () => clearInterval(t); }, [client, market, refresh]);
  useEffect(() => { if (!client) { setBal(null); return; } const f = () => client.fetchMyBalance().then((b) => setBal(b ? { baseFree: b.baseFree, quoteFree: b.quoteFree } : null)).catch(() => {}); f(); const t = setInterval(f, 2500); return () => clearInterval(t); }, [client]);

  const run = async (label: string, layer: "base" | "er", fn: () => Promise<string>) => {
    setStatus({ kind: "busy", msg: label }); const t = Date.now();
    try {
      const sig = await fn();
      setLastTx(typeof sig === "string" && sig.length > 20 ? { label, sig, layer } : null);
      setStatus({ kind: "ok", msg: label, ms: Date.now() - t });
      setTimeout(refresh, 300);
    } catch (e: any) {
      const raw = e?.message || e?.error?.errorMessage || e?.toString?.() || JSON.stringify(e);
      if (label.includes("create") && /already in use|already initialized|custom program error: 0x0\b/i.test(raw)) { setStatus({ kind: "ok", msg: "book already created" }); return; }
      if (label.includes("delegate") && /delegated|already/i.test(raw)) { setStatus({ kind: "ok", msg: "already on rollup" }); return; }
      setStatus({ kind: "err", msg: `${label} — ${raw}` });
    }
  };

  const me = wallet?.publicKey?.toBase58();
  const px = (p: number) => p / 100;            // on-chain price -> USDC
  const sz = (u: number) => u * SIZE_PER_UNIT;  // on-chain size units -> SOL
  const asks = (book?.asks || []).slice(0, 8);
  const bids = (book?.bids || []).slice(0, 8);
  const maxSz = Math.max(1, ...asks.map((o) => o.size), ...bids.map((o) => o.size));
  const bidVol = bids.reduce((s, o) => s + o.size, 0), askVol = asks.reduce((s, o) => s + o.size, 0);
  const buyPct = Math.round((bidVol / (bidVol + askVol || 1)) * 100);
  const bestBid = bids[0]?.price, bestAsk = asks[0]?.price;
  const spread = bestBid && bestAsk ? px(bestAsk - bestBid) : null;
  const lastDir = (book?.lastPrice || 0) >= prevLast ? "up" : "down";
  const myOrders = [...bids.map((o) => ({ ...o, s: "bid" })), ...asks.map((o) => ({ ...o, s: "ask" }))].filter((o) => o.owner === me);

  const priceNum = parseFloat(price) || 0, sizeNum = parseFloat(size) || 0;  // sizeNum is in SOL
  const orderValue = priceNum * sizeNum, fee = orderValue * TAKER_FEE;

  // credited balances (what settlement actually draws from), in human units
  const baseFreeSol = bal ? bal.baseFree / 1e9 : 0;
  const quoteFreeUsdc = bal ? bal.quoteFree / 1e6 : 0;
  // already-committed exposure from my resting orders (settlement strictly in fill order,
  // so an order I can't cover would jam the whole queue — count open orders too).
  const myOpenBidUsdc = (book?.bids || []).filter((o) => o.owner === me).reduce((s, o) => s + px(o.price) * sz(o.size), 0);
  const myOpenAskSol = (book?.asks || []).filter((o) => o.owner === me).reduce((s, o) => s + sz(o.size), 0);
  // a buy settles by paying USDC (price*size); a sell settles by delivering SOL (size)
  const needUsdc = side === SIDE_BID ? orderValue : 0;
  const needSol = side === SIDE_ASK ? sizeNum : 0;
  const underfunded = !!client && market.live && sizeNum > 0 && priceNum > 0 &&
    (needUsdc + myOpenBidUsdc > quoteFreeUsdc + 1e-9 || needSol + myOpenAskSol > baseFreeSol + 1e-9);

  const placeOrder = () => {
    if (!client || !market.live) return;
    const units = Math.max(1, Math.round(sizeNum / SIZE_PER_UNIT));
    run(`place ${side === SIDE_BID ? "buy" : "sell"} ${sizeNum} ${market.base}`, "er", () => client.placeOrder(side, Math.round(priceNum * 100), units));
  };

  const claimFaucet = async () => {
    if (!FAUCET_URL || !me || faucetBusy) return;
    setFaucetBusy(true); setFaucetMsg("requesting test funds…");
    try {
      const r = await fetch(FAUCET_URL.replace(/\/$/, "") + "/faucet", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: me }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "faucet failed");
      setFaucetMsg(`✓ sent ${d.usdc} USDC + ${d.sol} SOL — now deposit below to trade`);
      setFunds(true);
    } catch (e: any) { setFaucetMsg("✕ " + (e?.message || e).toString().slice(0, 90)); }
    finally { setFaucetBusy(false); }
  };

  return (
    <div className="term">
      <header className="nav">
        <div className="brand"><ShadeMark size={26} /><span className="bname">SHADE</span><span className="bbadge">devnet</span></div>
        <div className="nav-right">
          <a className="navicon" href="https://x.com/tradedotshade" target="_blank" rel="noopener">𝕏</a>
          <a className="navicon" href="https://github.com/RachitSrivastava12" target="_blank" rel="noopener">⌥</a>
          <WalletMultiButton />
        </div>
      </header>

      <div className="ticker-strip">
        {MARKETS.map((m) => {
          const t = tickers[m.binance];
          return (
            <button key={m.key} className={`tk ${m.key === market.key ? "on" : ""}`} onClick={() => setMarket(m)}>
              <TokenIcon m={m} size={18} /><span className="tk-name">{m.base}</span>
              <span className="tk-px">{t ? fmt(t.price, dec(t.price)) : "—"}</span>
              {t && <span className={`tk-chg ${t.changePct >= 0 ? "up" : "down"}`}>{t.changePct >= 0 ? "▲" : "▼"} {fmt(Math.abs(t.changePct), 2)}%</span>}
            </button>
          );
        })}
      </div>

      {idlError && <div className="idl-warn">Program interface missing — run <code>anchor build</code> then <code>cp target/idl/shade.json app/public/</code> and reload.</div>}

      <div className="mkthead">
        <div className="mkt-pick" onClick={() => setMarketSel((v) => !v)}>
          <TokenIcon m={market} size={24} /><span className="mkt-name">{market.label}</span><span className="mkt-caret">▾</span>
        </div>
        {marketSel && (<>
          <div className="mkt-overlay" onClick={() => setMarketSel(false)} />
          <div className="mkt-menu">
            <div className="mkt-menu-head"><span>Market</span><span>Price</span><span>24h</span><span>Vol</span></div>
            {MARKETS.map((m) => {
              const t = tickers[m.binance];
              return (
                <div key={m.key} className={`mkt-row ${m.key === market.key ? "on" : ""}`} onClick={() => { setMarket(m); setMarketSel(false); }}>
                  <span className="mr-name"><TokenIcon m={m} size={20} />{m.base}{m.live ? <i className="live">live</i> : <i className="soon">soon</i>}</span>
                  <span className="mr-px">{t ? fmt(t.price, dec(t.price)) : "—"}</span>
                  <span className={`mr-chg ${t && t.changePct >= 0 ? "up" : "down"}`}>{t ? `${t.changePct >= 0 ? "+" : ""}${fmt(t.changePct, 2)}%` : "—"}</span>
                  <span className="mr-vol">{t ? fmtUsd(t.volUsd * t.price) : "—"}</span>
                </div>
              );
            })}
          </div>
        </>)}
        <div className="mkt-price">
          <span className={`big-px ${stats && stats.changePct >= 0 ? "up" : "down"}`}>{stats ? fmt(stats.price, dec(stats.price)) : "—"}</span>
          {stats && <span className={`chg ${stats.changePct >= 0 ? "up" : "down"}`}>{stats.changePct >= 0 ? "+" : ""}{fmt(stats.changePct, 2)}%</span>}
        </div>
        <div className="mkt-stats">
          <div className="stat"><span className="lab">24h High</span><span className="val">{stats ? fmt(stats.high, dec(stats.high)) : "—"}</span></div>
          <div className="stat"><span className="lab">24h Low</span><span className="val">{stats ? fmt(stats.low, dec(stats.low)) : "—"}</span></div>
          <div className="stat"><span className="lab">24h Vol</span><span className="val">{stats ? fmtUsd(stats.volUsd * stats.price) : "—"}</span></div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: `${leftOpen ? leftW : 0}px ${leftOpen ? 6 : 18}px minmax(0,1fr) 6px ${rightW}px` }}>
        {/* LEFT */}
        <section className="panel book-panel">
          <div className="tabs">
            <button className={leftTab === "book" ? "on" : ""} onClick={() => setLeftTab("book")}>Book</button>
            <button className={leftTab === "trades" ? "on" : ""} onClick={() => setLeftTab("trades")}>Trades</button>
            <span className={`book-src ${src === "ER" ? "live" : ""}`}>{market.live ? (src === "ER" ? "● live · rollup" : src === "base" ? "base layer" : "connect") : "book soon"}</span>
            <button className="collapse" title="collapse" onClick={() => setLeftOpen(false)}>‹</button>
          </div>
          {leftTab === "book" ? (
            !market.live ? (
              <div className="empty-book"><div className="eb-title">{market.label} dark book launching</div><div className="eb-sub">chart is live market data. the on-chain dark book is live on SOL/USDC — more markets rolling out.</div></div>
            ) : (
              <>
                <div className="book-cols"><span>Price</span><span>Size</span><span>Total</span></div>
                <div className="book-asks">
                  {asks.slice().reverse().map((o) => (<div className="brow ask" key={`a${o.id}`}><span className="bar" style={{ width: `${(o.size / maxSz) * 100}%` }} /><span className="p">{fmt(px(o.price))}</span><span className="s">{fmt(sz(o.size), 4)}</span><span className="t">{fmt(sz(o.size) * px(o.price))}</span></div>))}
                  {!asks.length && <div className="mini-empty">no asks</div>}
                </div>
                <div className="book-mid"><span className={`ml ${lastDir}`}>{book?.lastPrice ? fmt(px(book.lastPrice)) : "—"} {book?.lastPrice ? (lastDir === "up" ? "↑" : "↓") : ""}</span><span className="ms">spread {spread != null ? fmt(spread) : "—"}</span></div>
                <div className="book-bids">
                  {bids.map((o) => (<div className="brow bid" key={`b${o.id}`}><span className="bar" style={{ width: `${(o.size / maxSz) * 100}%` }} /><span className="p">{fmt(px(o.price))}</span><span className="s">{fmt(sz(o.size), 4)}</span><span className="t">{fmt(sz(o.size) * px(o.price))}</span></div>))}
                  {!bids.length && <div className="mini-empty">no bids — be the first maker</div>}
                </div>
                <div className="ratio"><div className="ratio-bar"><span className="rb-buy" style={{ width: `${buyPct}%` }} /><span className="rb-sell" style={{ width: `${100 - buyPct}%` }} /></div><div className="ratio-lab"><span className="up">Buy {buyPct}%</span><span className="down">{100 - buyPct}% Sell</span></div></div>
              </>
            )
          ) : (
            <div className="trades-list">
              {(book?.fills || []).slice(0, 16).map((f) => (<div className="trow" key={f.id}><span className="p up">{fmt(px(f.price))}</span><span className="s">{fmt(sz(f.size), 4)}</span><span className={`tag ${f.buyer === me || f.seller === me ? "you" : ""}`}>{f.buyer === me ? "buy" : f.seller === me ? "sell" : "fill"}</span></div>))}
              {!book?.fills?.length && <div className="mini-empty" style={{ padding: 20 }}>no trades yet</div>}
            </div>
          )}
        </section>

        {/* left resizer (doubles as expand rail when collapsed) */}
        <div className={`rz rz-v ${leftOpen ? "" : "rail"}`} onMouseDown={(e) => leftOpen && startDrag("left", e)} onDoubleClick={() => setLeftOpen((o) => !o)} title={leftOpen ? "drag to resize · double-click to collapse" : "double-click to expand"}>{!leftOpen && <span className="rail-i">›</span>}</div>

        {/* CENTER */}
        <section className="panel center-panel">
          <div className="tabs chart-tabs">
            <button className={centerTab === "chart" ? "on" : ""} onClick={() => setCenterTab("chart")}>Chart</button>
            <button className={centerTab === "depth" ? "on" : ""} onClick={() => setCenterTab("depth")}>Depth</button>
            <span className="chart-note">{market.tv.replace("BINANCE:", "")} · live</span>
          </div>
          <div className="chart-wrap">{centerTab === "chart" ? <TradingViewChart symbol={market.tv} /> : <DepthView bids={bids} asks={asks} pxScale={px} />}</div>

          <div className="rz rz-h" onMouseDown={(e) => botOpen && startDrag("bottom", e)} title="drag to resize" />
          <div className="bottom" style={{ height: botOpen ? botH : 36 }}>
            <div className="tabs bot-tabs">
              <button className={botTab === "orders" ? "on" : ""} onClick={() => setBotTab("orders")}>Open Orders {myOrders.length ? `(${myOrders.length})` : ""}</button>
              <button className={botTab === "history" ? "on" : ""} onClick={() => setBotTab("history")}>Trade History</button>
              <button className="collapse" title={botOpen ? "minimize" : "expand"} onClick={() => setBotOpen((o) => !o)}>{botOpen ? "▾" : "▴"}</button>
            </div>
            {botOpen && (
              <div className="bot-body">
                {botTab === "orders" ? (
                  myOrders.length ? (
                    <table className="bt"><thead><tr><th>Market</th><th>Side</th><th>Price</th><th>Size</th><th>Value</th><th></th></tr></thead>
                      <tbody>{myOrders.map((o) => (<tr key={`${o.s}${o.id}`}><td>{market.label}</td><td className={o.s === "bid" ? "up" : "down"}>{o.s === "bid" ? "Buy" : "Sell"}</td><td className="m">{fmt(px(o.price))}</td><td className="m">{fmt(sz(o.size), 4)}</td><td className="m">${fmt(sz(o.size) * px(o.price))}</td><td><button className="cancel" onClick={() => run("cancel order", "er", () => client!.cancelOrder(o.id))}>cancel</button></td></tr>))}</tbody></table>
                  ) : <div className="bot-empty">{!me ? "connect wallet to see your orders" : "no open orders"}</div>
                ) : (
                  (book?.fills || []).length ? (
                    <table className="bt"><thead><tr><th>Market</th><th>Side</th><th>Price</th><th>Size</th><th>Value</th></tr></thead>
                      <tbody>{(book?.fills || []).slice(0, 12).map((f) => (<tr key={f.id}><td>{market.label}</td><td className={f.buyer === me ? "up" : f.seller === me ? "down" : ""}>{f.buyer === me ? "Buy" : f.seller === me ? "Sell" : "—"}</td><td className="m">{fmt(px(f.price))}</td><td className="m">{fmt(sz(f.size), 4)}</td><td className="m">${fmt(sz(f.size) * px(f.price))}</td></tr>))}</tbody></table>
                  ) : <div className="bot-empty">no trade history yet</div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* right resizer */}
        <div className="rz rz-v" onMouseDown={(e) => startDrag("right", e)} title="drag to resize" />

        {/* RIGHT */}
        <section className="panel trade-panel" style={{ width: rightW }}>
          <div className="tp-head">Market</div>
          <div className="seg2"><button className={side === SIDE_BID ? "on buy" : ""} onClick={() => setSide(SIDE_BID)}>Buy</button><button className={side === SIDE_ASK ? "on sell" : ""} onClick={() => setSide(SIDE_ASK)}>Sell</button></div>
          <div className="tp-field"><div className="tp-flab"><span>Size</span><span className="avail">{market.base}</span></div><input value={size} onChange={(e) => setSize(e.target.value)} placeholder="0.00" inputMode="decimal" /></div>
          <div className="tp-field"><div className="tp-flab"><span>Limit price</span><span className="avail">{stats ? `mkt ${fmt(stats.price, dec(stats.price))}` : ""}</span></div><input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" inputMode="decimal" /></div>
          <button className={`tp-cta ${side === SIDE_BID ? "buy" : "sell"}`} disabled={!client || !market.live || !sizeNum || !priceNum || underfunded} onClick={placeOrder}>{!market.live ? "book launching soon" : !client ? "connect wallet" : underfunded ? `deposit ${side === SIDE_BID ? "USDC" : "SOL"} to ${side === SIDE_BID ? "buy" : "sell"}` : `${side === SIDE_BID ? "Buy" : "Sell"} ${market.base} in shade`}</button>
          <div className="slip-row"><span>Slippage</span><div className="slip-opts">{[0.1, 0.5, 1].map((s) => (<button key={s} className={slip === s ? "on" : ""} onClick={() => setSlip(s)}>{s}%</button>))}</div></div>
          <div className="summary">
            <div className="sr"><span>Order Value</span><span>${fmt(orderValue)}</span></div>
            <div className="sr"><span>Est. Fill Price</span><span>{priceNum ? fmt(priceNum) : "—"}</span></div>
            <div className="sr"><span>Taker Fee (0.05%)</span><span>${fmt(fee)}</span></div>
            <div className="sr"><span>Network Fee</span><span>~$0.01</span></div>
            <div className="sr total"><span>Total</span><span>${fmt(orderValue + fee)}</span></div>
          </div>
          {engine && (
            <div className={`engine ${engine.funded ? "ok" : "warn"}`}>
              <span className="eng-dot" />
              <span className="eng-phase">{engine.funded ? engine.phase : "engine needs gas"}</span>
              {!engine.funded && (
                <span className="eng-fund">fund <code>{engine.address.slice(0, 4)}…{engine.address.slice(-4)}</code> · {engine.balanceSol.toFixed(3)}◎</span>
              )}
            </div>
          )}
          <button className="ops-toggle" onClick={() => setFunds((v) => !v)}>{funds ? "▾" : "▸"} funds · deposit / withdraw</button>
          {funds && (
            <div className="funds">
              {FAUCET_URL && (
                <div className="faucet-row">
                  <button className="faucet-btn" disabled={!me || faucetBusy} onClick={claimFaucet}>{faucetBusy ? "sending…" : "🚰 get test USDC + gas"}</button>
                  {faucetMsg && <div className="faucet-msg">{faucetMsg}</div>}
                </div>
              )}
              <div className="bal-row"><span>wSOL credited</span><span className="m">{bal ? (bal.baseFree / 1e9).toFixed(4) : "—"}</span></div>
              <div className="bal-row"><span>USDC credited</span><span className="m">{bal ? (bal.quoteFree / 1e6).toFixed(2) : "—"}</span></div>
              <div className="dep-grid">
                <input value={depSol} onChange={(e) => setDepSol(e.target.value)} inputMode="decimal" />
                <button disabled={!client} onClick={() => run("deposit SOL", "base", () => client!.depositBaseSol(parseFloat(depSol) || 0))}>deposit SOL</button>
                <button disabled={!client} onClick={() => run("withdraw SOL", "base", () => client!.withdrawBaseSol(parseFloat(depSol) || 0))}>withdraw</button>
              </div>
              <div className="dep-grid">
                <input value={depUsdc} onChange={(e) => setDepUsdc(e.target.value)} inputMode="decimal" />
                <button disabled={!client} onClick={() => run("deposit USDC", "base", () => client!.depositQuoteUsdc(parseFloat(depUsdc) || 0))}>deposit USDC</button>
                <button disabled={!client} onClick={() => run("withdraw USDC", "base", () => client!.withdrawQuoteUsdc(parseFloat(depUsdc) || 0))}>withdraw</button>
              </div>
            </div>
          )}
          <button className="ops-toggle" onClick={() => setOps((v) => !v)}>{ops ? "▾" : "▸"} under the hood · verifiable machinery</button>
          {ops && (<div className="ops">
            <div className="ops-note">the engine runs these automatically — exposed here so every step is verifiable on-chain.</div>
            <button disabled={!client} onClick={() => run("create book", "base", () => client!.initializeBook(100, 1))}>create book + mints</button>
            <button disabled={!client} onClick={() => run("init vaults", "base", () => client!.initVaults())}>init vaults</button>
            <button disabled={!client} onClick={() => run("delegate to rollup", "base", () => client!.delegate())}>delegate to rollup</button>
            <button disabled={!client} onClick={() => run("run matching", "er", () => client!.matchBook())}>run matching</button>
            <button disabled={!client} onClick={() => run("settle & undelegate", "er", () => client!.settleAndUndelegate())}>settle &amp; undelegate</button>
            <button disabled={!client} onClick={() => run("settle fills", "base", () => client!.settleAll())}>settle fills → balances</button>
          </div>)}
          <div className={`tp-status ${status.kind}`}>{status.kind === "busy" && <span className="spin" />}{status.kind === "ok" && "✓ "}{status.kind === "err" && "✕ "}<span>{status.msg}</span>{status.ms != null && <span className="ms">{status.ms}ms</span>}</div>
          {lastTx && (
            <a className="solscan-link" href={lastTx.layer === "base" ? txUrl(lastTx.sig) : (bookAcct ? accUrl(bookAcct.toBase58()) : "#")} target="_blank" rel="noopener">
              ↗ {lastTx.layer === "base" ? "view transaction on Solscan" : "verify book state on Solscan"}
            </a>
          )}
          {bookAcct && programId && (
            <div className="verify-row">
              <span>verify on-chain</span>
              <a href={accUrl(programId.toBase58())} target="_blank" rel="noopener">program ↗</a>
              <a href={accUrl(bookAcct.toBase58())} target="_blank" rel="noopener">book ↗</a>
            </div>
          )}
        </section>
      </div>

      <footer className="term-foot">
        <span className="ft-l"><span className="ft-dot" /> devnet · MagicBlock ER · Pyth-ready</span>
        <span>chart: live market data · book &amp; matching: on-chain · settled on Solana</span>
      </footer>
    </div>
  );
}

function DepthView({ bids, asks, pxScale }: { bids: any[]; asks: any[]; pxScale: (n: number) => number }) {
  if (!bids.length && !asks.length) return <div className="mini-empty" style={{ padding: 40 }}>no depth — order book is empty</div>;
  let cumB = 0, cumA = 0;
  const maxCum = Math.max(bids.reduce((s, o) => s + o.size, 0), asks.reduce((s, o) => s + o.size, 0), 1);
  return (
    <div className="depthview">
      <div className="dv-side bids">{bids.map((o) => { cumB += o.size; return (<div className="dv-row" key={o.id}><span className="dv-bar bid" style={{ width: `${(cumB / maxCum) * 100}%` }} /><span className="dv-p bid">{pxScale(o.price).toFixed(2)}</span><span className="dv-c">{(cumB * SIZE_PER_UNIT).toFixed(4)}</span></div>); })}</div>
      <div className="dv-side asks">{asks.map((o) => { cumA += o.size; return (<div className="dv-row" key={o.id}><span className="dv-bar ask" style={{ width: `${(cumA / maxCum) * 100}%` }} /><span className="dv-p ask">{pxScale(o.price).toFixed(2)}</span><span className="dv-c">{(cumA * SIZE_PER_UNIT).toFixed(4)}</span></div>); })}</div>
    </div>
  );
}
