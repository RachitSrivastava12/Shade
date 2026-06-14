// Market registry for the Shade terminal.
export type Market = {
  key: string; label: string; base: string; quote: string;
  tv: string; binance: string; live: boolean; icon: string; logo: string;
};

// logos: CoinMarketCap icon CDN (hotlink-friendly); falls back to letter glyph on error.
const CMC = (id: number) => `https://s2.coinmarketcap.com/static/img/coins/64x64/${id}.png`;

export const MARKETS: Market[] = [
  { key: "SOL",  label: "SOL/USDC",  base: "SOL",  quote: "USDC", tv: "BINANCE:SOLUSDT",  binance: "SOLUSDT",  live: true,  icon: "S",  logo: CMC(5426) },
  { key: "JUP",  label: "JUP/USDC",  base: "JUP",  quote: "USDC", tv: "BINANCE:JUPUSDT",  binance: "JUPUSDT",  live: false, icon: "J",  logo: CMC(29210) },
  { key: "BONK", label: "BONK/USDC", base: "BONK", quote: "USDC", tv: "BINANCE:BONKUSDT", binance: "BONKUSDT", live: false, icon: "B",  logo: CMC(23095) },
  { key: "WIF",  label: "WIF/USDC",  base: "WIF",  quote: "USDC", tv: "BINANCE:WIFUSDT",  binance: "WIFUSDT",  live: false, icon: "W",  logo: CMC(28752) },
  { key: "JTO",  label: "JTO/USDC",  base: "JTO",  quote: "USDC", tv: "BINANCE:JTOUSDT",  binance: "JTOUSDT",  live: false, icon: "JT", logo: CMC(28541) },
];

export type Stats = { price: number; changePct: number; high: number; low: number; volUsd: number } | null;

export async function fetchStats(binanceSymbol: string): Promise<Stats> {
  try {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binanceSymbol}`);
    if (!r.ok) return null;
    const d = await r.json();
    return { price: +d.lastPrice, changePct: +d.priceChangePercent, high: +d.highPrice, low: +d.lowPrice, volUsd: +d.quoteVolume };
  } catch { return null; }
}

export async function fetchAllTickers(symbols: string[]): Promise<Record<string, Stats>> {
  try {
    const param = encodeURIComponent(JSON.stringify(symbols));
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${param}`);
    if (!r.ok) return {};
    const arr = await r.json();
    const out: Record<string, Stats> = {};
    for (const d of arr) out[d.symbol] = { price: +d.lastPrice, changePct: +d.priceChangePercent, high: +d.highPrice, low: +d.lowPrice, volUsd: +d.quoteVolume };
    return out;
  } catch { return {}; }
}
