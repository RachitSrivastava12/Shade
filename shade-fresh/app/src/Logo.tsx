// Shade — canonical eclipse mark (matches the PFP + website exactly).
export function ShadeMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden>
      <defs>
        <radialGradient id="shadeCorona" cx="42%" cy="60%" r="62%">
          <stop offset="0%" stopColor="#fff7e4" />
          <stop offset="52%" stopColor="#f3cd8e" />
          <stop offset="100%" stopColor="#cf9c54" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="49" fill="none" stroke="#e9b872" strokeWidth="0.5" opacity="0.2" />
      <circle cx="51.3" cy="53.5" r="33.9" fill="url(#shadeCorona)" />
      <circle cx="64.2" cy="43.2" r="33.9" fill="#08090c" />
    </svg>
  );
}

export function ShadeWordmark({ size = 32 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <ShadeMark size={size} />
      <span style={{
        fontFamily: "'Schibsted Grotesk', sans-serif",
        fontWeight: 700,
        fontSize: size * 0.6,
        letterSpacing: "0.14em",
        color: "var(--corona)",
      }}>
        SHADE
      </span>
    </span>
  );
}
