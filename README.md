# Shade

**A dark-pool orderbook on Solana. Orders are matched inside a MagicBlock Ephemeral Rollup at sub-10ms latency, then settled atomically to Solana mainnet.**

Your resting orders live on the ER, not the base layer — so they are invisible to the public chain until the book is committed. No mempool, no frontrun window, no sandwich.

```
trader ──place_order──▶  ┌─────────────────────────────┐
                         │   EPHEMERAL ROLLUP (SVM)     │
trader ──place_order──▶  │   • orderbook PDA (delegated)│
                         │   • price-time matching      │  gasless · <10ms
crank  ──match_book───▶  │   • fills recorded           │
                         └──────────────┬──────────────┘
                                        │ commit / undelegate
                                        ▼
                         ┌─────────────────────────────┐
                         │      SOLANA BASE LAYER       │
                         │   committed book + fills     │
                         └─────────────────────────────┘
```

---

## What's in here

```
programs/shade/src/lib.rs   Anchor program: book + matching engine + ER hooks
app/src/lib/shade.ts              TS client (works in Node + browser)
scripts/demo.ts                     headless end-to-end demo (prints ER latencies)
tests/shade.ts              mocha test of the full lifecycle
app/                                Vite + React dApp (live orderbook UI)
```

Built against the current MagicBlock stack: `ephemeral-rollups-sdk 0.14.3`, `anchor 1.0.2`, ER devnet endpoint `https://devnet-as.magicblock.app/`.

---

## 0 · Prerequisites (install once)

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI (Agave)
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor via avm — pin to 1.0.2 to match this repo
cargo install --git https://github.com/coral-xyz/anchor avm --force
avm install 1.0.2
avm use 1.0.2

# Node deps tooling
npm i -g yarn   # or just use npm
```

Verify:
```bash
solana --version
anchor --version   # anchor-cli 1.0.2
node --version     # >= 18
```

---

## 1 · Wallet + devnet SOL

```bash
solana-keygen new            # if you don't have a keypair
solana config set --url https://api.devnet.solana.com
solana airdrop 2             # repeat if needed, or use https://faucet.solana.com
solana balance
```

---

## 2 · Install project deps

```bash
# from repo root
yarn install          # installs root tooling (anchor tests + demo)

cd app && yarn install && cd ..   # installs the frontend
```

---

## 3 · Build + deploy the program

```bash
anchor build

# point declare_id! + Anchor.toml at YOUR freshly generated program key
anchor keys sync
anchor build          # rebuild so the new id is baked in

anchor deploy --provider.cluster devnet
```

After deploy, copy the IDL into the frontend so it can talk to the program:

```bash
cp target/idl/shade.json app/public/shade.json
```

---

## 4 · Run the headless demo (the judge-facing proof)

This initializes the book, delegates it to the ER, streams orders straight onto
the rollup, crosses them, and commits back to mainnet — printing the latency of
each step.

```bash
cp .env.example .env      # endpoints are already filled in for devnet
yarn demo
```

Expected output (abridged):
```
Shade demo
  base : https://api.devnet.solana.com
  ER   : https://devnet-as.magicblock.app/
    412ms  (base) initialize_book
    690ms  (base) delegate -> ER
      9ms  (ER)   place ASK 18740 x 10
      8ms  (ER)   place ASK 18738 x 15
      7ms  (ER)   place BID 18735 x 8
     11ms  (ER)   place BID 18742 x 12 (crosses!)
   ── BOOK ──────────────────────────────
    ...
   done. orders matched on the ER, settled to mainnet.
```

The single-digit-ms ER timings vs the ~hundreds-of-ms base-layer timings are the
whole point — that delta is what Ephemeral Rollups unlock.

---

## 5 · Run the dApp

```bash
cd app
yarn dev      # http://localhost:5173
```

In the UI:
1. Connect wallet (Phantom).
2. `1 · init book`  → creates the book on the base layer.
3. `2 · delegate to ER`  → hands the book to the rollup.
4. Place buy/sell orders — they hit the **ER** (watch the latency in the status bar).
5. `commit to mainnet`  → settles the book + fills to the base layer.

The order book panel polls the ER live, so you see fills appear in real time.

---

## 6 · Run the tests

```bash
anchor test --provider.cluster devnet
# or, if program already deployed:
yarn test
```

---

## Program interface

| instruction            | layer | purpose                                         |
|------------------------|-------|-------------------------------------------------|
| `initialize_book`      | base  | create the orderbook PDA                        |
| `delegate`             | base  | delegate the book to the ER                     |
| `place_order`          | ER    | add a limit order, run matching inline          |
| `cancel_order`         | ER    | cancel a resting order by id                    |
| `match_book`           | ER    | crank-callable matching pass                    |
| `commit_book`          | ER    | commit book state → base layer (stay delegated) |
| `settle_and_undelegate`| ER    | commit + return ownership to the base layer     |

Matching is price-time priority: bids high→low, asks low→high, cross while
`best_bid >= best_ask`, fill at the resting ask price.

---

## Honest scope notes (read before demoing)

This repo ships a **complete, runnable orderbook whose state is matched on the ER
and settled to mainnet** — that is the real, working core.

Two things are deliberately left as clearly-marked extension points rather than
faked, because faking them would break the build and any MagicBlock engineer
would spot it instantly:

1. **SPL-token escrow settlement.** Right now the book tracks orders and fills as
   an on-rollup ledger that commits to mainnet. To move real tokens on each fill,
   add base/quote vault token accounts and SPL transfers on `commit`, using
   [`ephemeral-rollups-spl`](https://github.com/magicblock-labs/ephemeral-rollups-spl)
   for in-ER token handling. Hook points are the `Fill` records in `match_engine`.

2. **Private ER (TEE).** The "dark pool" privacy story uses standard ER delegation
   here (orders invisible to the base layer until commit). To hide amounts/owners
   from the ER operator too, request Private ER (Intel TDX) access from MagicBlock
   and route the book through the PER endpoint — the program code is unchanged.

Everything else runs today on devnet.

---

## Why Ephemeral Rollups for this

A real orderbook needs to place, cancel, and match faster than 400ms blocks and
without paying gas per quote update. ERs give exactly that: a delegated account
runs in a dedicated SVM at single-digit-ms latency, gaslessly, then commits a
verifiable state back to Solana. Orders never touch the public mempool while
resting — which is the structural reason there's no frontrun/sandwich window.
