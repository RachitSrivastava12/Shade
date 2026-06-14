# SHADE — the open dark order book for Solana

**One-liner:** the open dark order book for Solana — your orders stay hidden until they fill.

1. **What it is** — Shade is the open, permissionless dark order book for Solana: a venue where buy/sell orders stay hidden until they fill.
2. **Motto** — the open dark order book for Solana. your orders stay hidden until they fill.
3. **The problem** — on normal on-chain order books, your order becomes public the moment you place it. bots, searchers, and other traders react to your intent before you get filled.
4. **Why it matters** — public orders hurt large traders, funds, whales, and market makers because their trading intent leaks before execution.
5. **The deeper problem** — visible orders hurt maker economics. makers get picked off when prices move, so they widen spreads, pull liquidity, or avoid on-chain books entirely.
6. **The thesis** — Shade is not just a dark pool. It is application-controlled execution (ACE) for hidden spot liquidity — live today on MagicBlock.
7. **What ACE means here** — instead of letting public-chain ordering decide who matches first, Shade controls its own execution rules: how orders are sequenced, when cancels happen, when matches happen, how fills settle.
8. **How the ER enables it** — Shade runs the matching engine inside a MagicBlock Ephemeral Rollup: a fast, gasless, app-controlled runtime where orders are placed, cancelled, matched, and scheduled before the result settles to Solana.
9. **How it works** — users submit hidden order intents. Shade keeps the resting order private, matches inside the ER, applies maker-protective rules (cancel-before-take / stale-quote protection), then settles the fill trustlessly on Solana.
10. **Private before, verifiable after** — hidden before it fills; after execution Shade can publish a fill receipt: order hash, match price, time/slot, settlement tx, execution rule used.
11. **Better than closed dark pools** — closed pools hide everything and require trusting the operator. Shade hides only what must be hidden before execution, and makes the result verifiable after.
12. **The wedge** — dark pools exist, but most are closed, permissioned, or single-market-maker. Shade is the open version: anyone can access it, rules enforced by code, execution path transparent after fill.
13. **Flash Trade** — internalization-first: match privately inside the dark book; if no internal match, route to Flash Trade liquidity as the fallback execution path.
14. **Who it's for** — traders moving size: makers, funds, whales, prop desks, aggregators, trading apps. retail benefits downstream via better execution routes; the core customer is serious order flow.
15. **How it makes money** — protocol fee on settlement, maker/taker fees, private-routing fees, API/integration fees — once real volume exists.

---
**Stack:** MagicBlock Ephemeral Rollups (matching) · Solana (settlement) · Anchor (program) · Flash Trade (liquidity fallback) · roadmap: Pyth, Jupiter, Jito, Helius.

**Live:** program deployed to devnet · `yarn demo` runs the full lifecycle · React dApp + coming-soon page + brand kit in /brand.
