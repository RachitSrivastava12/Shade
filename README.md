# Shade — the open dark order book for Solana

Resting orders are matched **privately inside a MagicBlock Ephemeral Rollup**, then
settled trustlessly on Solana as real SPL transfers (wSOL ↔ USDC). Your orders stay
hidden until they fill.

- Program (devnet): `EN1GWHvfvuW2fbxKop3xzUrZm2RoDobVpYwrtk2mRDk1`
- Base mint: wSOL `So11111111111111111111111111111111111111112`
- Quote mint: your mock USDC (6 decimals) — set via `USDC_MINT`

This build uses a **fresh book (`book_v4`)** so there is zero leftover rollup/delegation
state from earlier testing. The engine runs as **one standalone process** (`npm run crank`),
not in the browser, so multiple wallets/tabs never fight over delegating the same book.

---

## 0. Prerequisites

- Rust + Solana CLI + Anchor (same toolchain you already deployed with: anchor-lang 1.0.2)
- Node 18+ and `ts-node`
- A devnet wallet at `~/.config/solana/id.json` funded with **~6–10 SOL**
- Your mock USDC mint (you already have one): `DANN41Tukr829a3zzXy81QpzfqNyYendveiuvwDnho4R`

Set these in **every terminal** you use:

```bash
export ANCHOR_WALLET=~/.config/solana/id.json
export PROVIDER_ENDPOINT=https://divine-fittest-season.solana-devnet.quiknode.pro/17750ffdb134b9cfe0539702c9f709ff4a855f60/
export USDC_MINT=DANN41Tukr829a3zzXy81QpzfqNyYendveiuvwDnho4R
```

---

## 1. Install

```bash
npm install
cd app && npm install && cd ..
```

---

## 2. Build + deploy the program (fresh book)

Only a constant changed (`book_v3` → `book_v4`) plus TypeScript, so the Rust compiles as before.
Because the book seed changed, you must rebuild and redeploy.

### Keep your existing program ID (recommended — deck/submission stay valid)

Copy your **existing** program keypair into this project so the ID stays `EN1GW…`,
then build + upgrade-deploy:

```bash
mkdir -p target/deploy
cp "/path/to/your/old/project/target/deploy/shade-keypair.json" target/deploy/shade-keypair.json

anchor build

# deploy via QuickNode devnet (public devnet RPC times out on deploys):
solana program deploy target/deploy/shade.so \
  --program-id target/deploy/shade-keypair.json \
  --url $PROVIDER_ENDPOINT --use-rpc \
  --with-compute-unit-price 50000 --max-sign-attempts 1000
```

> If a deploy fails midway and locks SOL in a buffer, recover it:
> `solana program close --buffers --url $PROVIDER_ENDPOINT`

### OR: brand-new program ID

```bash
solana-keygen new -o target/deploy/shade-keypair.json   # new id
anchor keys sync                                         # updates declare_id! + Anchor.toml
anchor build
solana program deploy target/deploy/shade.so --program-id target/deploy/shade-keypair.json \
  --url $PROVIDER_ENDPOINT --use-rpc --with-compute-unit-price 50000 --max-sign-attempts 1000
```
…then update the program address in your deck/submission.

After deploy, confirm the IDL exists at `target/idl/shade.json` (Anchor writes it on build).

---

## 3. Create the book + vaults (run once)

```bash
npm run bootstrap
```

Expected:

```
initialize_book OK ...
init_vaults     OK ...
book ready — asks:0 bids:0 fills:0 seq:1
```

---

## 4. Start the engine (Terminal 1 — leave running)

```bash
npm run crank
```

It delegates the book to the rollup and prints the book every ~6s:

```
book on rollup — asks:0 bids:0 fills:0 settled:0
```

When a trade fills, it logs `N fill(s) to settle -> settled fill #N -> re-delegated`.

---

## 5. Start the app (Terminal 2)

```bash
cd app
npm run dev
```

Open the printed URL. The app reads these from `app/.env` (copy from `app/.env.example`):

```
VITE_USDC_MINT=DANN41Tukr829a3zzXy81QpzfqNyYendveiuvwDnho4R
VITE_PROVIDER_ENDPOINT=https://divine-fittest-season.solana-devnet.quiknode.pro/17750ffdb134b9cfe0539702c9f709ff4a855f60/
```

---

## 6. The two-wallet demo (the money shot)

Use two wallets (e.g. Phantom = buyer, Backpack = seller). Each needs a little devnet SOL
for fees; the quote side needs mock USDC.

1. **Seller (Backpack):** funds panel -> **deposit SOL** `0.05` -> place **Sell** `10 @ 18700`.
   Watch Terminal 1: the book should show `asks:1`.
2. **Buyer (Phantom):** **deposit USDC** (e.g. `100`) -> place **Buy** `10 @ 18700`.
   Terminal 1 should show `fills:1 -> settled fill #... -> re-delegated`.
3. Within ~15s the funds panels move:
   - **Seller:** USDC `100 -> 101.87`, wSOL `0.05 -> 0.04`
   - **Buyer:** wSOL `0.05 -> 0.06`, USDC `100 -> 98.13`

Orders now surface **real errors** instead of a false success — if a placement fails, the
app throws the actual rollup error (and program logs), so you see exactly what happened.

---

## 7. Rock-solid proof (no UI needed)

The self-contained, two-wallet settlement proof — real wSOL <-> USDC on devnet:

```bash
npm run demo:settle
```

Prints before/after balances for two fresh wallets. Undeniable evidence (also verifiable
on Solscan via the program address).

---

## Scripts

| command | what it does |
|---|---|
| `npm run bootstrap`   | create the book + vaults (run once after deploy) |
| `npm run crank`       | the engine: delegate + auto-settle fills (leave running) |
| `npm run demo:settle` | self-contained two-wallet real-token settlement proof |
| `npm run place:test`  | place one order with preflight ON to surface real errors |
| `npm run reset`       | undelegate + reset book state |

---

## Troubleshooting

- **`asks:0` after placing an order** -> the place tx is failing. Run `npm run place:test`
  to see the real program error. On a fresh `book_v4` this should not happen.
- **Order placement is slow / retries** -> the book wasn't delegated yet. Make sure
  `npm run crank` is running (it delegates on start).
- **Deploy times out** -> use the QuickNode `--url $PROVIDER_ENDPOINT --use-rpc` form above.
- **`init_vaults` says already exists** -> fine, vaults already created; ignore.

---

## How the Ephemeral Rollup is used

1. The order book PDA is **delegated** to a MagicBlock ER validator.
2. Orders are placed **on the rollup** — gasless, sub-10ms, app-controlled sequencing,
   invisible to the public mempool. Matching is inline in `place_order`.
3. When fills exist, the book is **committed + undelegated** back to Solana
   (`settle_and_undelegate`), and `settle_fill` moves real balances buyer <-> seller.
4. Withdraw moves real SPL tokens out of the program vaults.

Private before, verifiable after.
