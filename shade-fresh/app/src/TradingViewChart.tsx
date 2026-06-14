import { useEffect, useRef } from "react";

declare global {
  interface Window { TradingView: any }
}

let tvLoading: Promise<void> | null = null;
function loadTV(): Promise<void> {
  if (window.TradingView) return Promise.resolve();
  if (tvLoading) return tvLoading;
  tvLoading = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = () => resolve();
    document.head.appendChild(s);
  });
  return tvLoading;
}

// Real TradingView advanced chart, themed dark to match Shade.
export function TradingViewChart({ symbol }: { symbol: string }) {
  const holder = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadTV().then(() => {
      if (cancelled || !holder.current || !window.TradingView) return;
      const id = "tvchart"; // stable container id
      holder.current.innerHTML = `<div id="${id}" style="width:100%;height:100%"></div>`;
      new window.TradingView.widget({
        container_id: id,
        symbol,
        interval: "5",
        timezone: "Etc/UTC",
        theme: "dark",
        style: "1",
        locale: "en",
        autosize: true,
        toolbar_bg: "#0b0d11",
        backgroundColor: "#0b0d11",
        gridColor: "rgba(240,234,214,0.035)",
        enable_publishing: false,
        allow_symbol_change: false,
        hide_side_toolbar: false,
        save_image: false,
        studies: [],
        overrides: {
          "paneProperties.background": "#0b0d11",
          "paneProperties.backgroundType": "solid",
          "mainSeriesProperties.candleStyle.upColor": "#4ade9e",
          "mainSeriesProperties.candleStyle.downColor": "#f2616b",
          "mainSeriesProperties.candleStyle.borderUpColor": "#4ade9e",
          "mainSeriesProperties.candleStyle.borderDownColor": "#f2616b",
          "mainSeriesProperties.candleStyle.wickUpColor": "#4ade9e",
          "mainSeriesProperties.candleStyle.wickDownColor": "#f2616b",
          "scalesProperties.textColor": "rgba(240,234,214,0.5)",
        },
      });
    });
    return () => { cancelled = true; };
  }, [symbol]);

  return <div ref={holder} style={{ width: "100%", height: "100%" }} />;
}
