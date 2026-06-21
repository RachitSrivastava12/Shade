# Shade backend

Always-on services that make Shade tradable on devnet.

- **`src/crank.ts`** — settlement engine. Keeps the book delegated to the MagicBlock rollup and settles fills (commit + undelegate → move balances → re-delegate).
- **`src/maker.ts`** — market maker. Continuously quotes bids + asks around the live SOL/USDC price so any visitor has a counterparty. Auto-tops up its own inventory (mints mock USDC, wraps SOL).
- **`src/faucet.ts`** — HTTP faucet. `POST /faucet { address }` drips mock USDC + a little devnet SOL so a fresh wallet can trade.
- **`src/config.ts`** — shared providers, PDAs, Magic Router helpers. All services read `.env`.

## Run locally

```bash
npm install
cp .env.example .env      # set ANCHOR_WALLET, PROVIDER_ENDPOINT, USDC_MINT
npm run crank             # terminal 1
npm run maker             # terminal 2
npm run faucet            # terminal 3 (serves :8787)
```

The wallet in `ANCHOR_WALLET` must be the **program authority + USDC mint authority** and hold a few devnet SOL for gas.

## Deploy to a VPS

See [`DEPLOY.md`](./DEPLOY.md) — pm2 (`ecosystem.config.cjs`) or systemd (`systemd/`).
