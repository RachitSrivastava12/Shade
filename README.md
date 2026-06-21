# 🌒 Shade

**The open dark order book for Solana.**

Your orders stay hidden until they fill — matched privately on a [MagicBlock](https://magicblock.gg) Ephemeral Rollup, settled trustlessly on Solana.

> Built for the MagicBlock **Solana Blitz v5** hackathon · live on devnet
> App: [tradeshade.online](https://tradeshade.online) · X: [@tradedotshade](https://x.com/tradedotshade)

---

## Why

On a public on-chain order book, every resting order is visible — so anyone trading size gets front-run, picked off, and sandwiched. Dark pools fix this, but the ones on Solana today (prop AMMs like HumidiFi) are **closed and operator-trusted**, and the open ones (Renegade, Penumbra) use heavy ZK/MPC and **don't live on Solana**.

Shade is the missing piece: an **open, permissionless dark order book, native to Solana**, fast enough to actually trade on.

The full thesis: [`THESIS.md`](./shade-fresh/THESIS.md) · the settlement design: [`SETTLEMENT.md`](./shade-fresh/SETTLEMENT.md)

---

## How it works

Shade keeps custody and settlement on Solana, and moves only the *matching* off the public surface.

1. **Deposit (Solana).** Real SOL is wrapped to wSOL and held in program vaults; your balance is credited on-chain.
2. **Match in the dark (Ephemeral Rollup).** The order book is *delegated* to a MagicBlock Ephemeral Rollup, where orders cross gaslessly and sub-millisecond — never broadcast to Solana's public mempool. While an order rests, the book is locked on Solana, owned by the delegation program.
3. **Settle (Solana).** On a match, the book commits and undelegates back to Solana, where settlement is real and atomic — actual wSOL ↔ USDC moves between the counterparties' on-chain balances. Withdraw anytime.

> **Privacy model — stated honestly:** this is *execution privacy*, not ZK-grade secrecy. Orders are invisible to Solana's public mempool/lit book (which is what kills front-running and sandwiching), but the rollup sequencer can see them. The trade-off buys speed, near-zero cost, a normal wallet, real on-chain settlement, and composability — today.

---

## MagicBlock Ephemeral Rollup integration

The ER integration lives in **`programs/shade/src/lib.rs`** (delegate / commit / undelegate) and **`app/src/lib/shade.ts`** + **`scripts/crank.ts`** (client + settlement engine). Key pieces:

- **Delegation** — `delegate_book` hands the order-book account to MagicBlock's delegation program so matching can run on the rollup.
- **Magic Router** — ER transactions are sent to the **Magic Router** (`https://devnet-router.magicblock.app`), which inspects writable accounts and routes the write to the node holding the delegated copy.
- **`getBlockhashForAccounts`** — the router's custom blockhash RPC is used for ER transactions (standard `getLatestBlockhash` won't work), keyed on the transaction's writable accounts.
- **Commit + undelegate** — `settle_and_undelegate` commits the rollup state back to Solana and returns the book to the base layer, where `settle_fill` moves real SPL balances between buyer and seller.

---

## Tech stack

| Layer | Stack |
|---|---|
| Program | Rust · Anchor 0.32 · MagicBlock Ephemeral Rollups SDK |
| Client / app | TypeScript · React 18 · Vite · `@solana/web3.js` · wallet-adapter · SPL Token |
| Settlement engine | TypeScript crank (state-driven; delegate ⇄ settle ⇄ undelegate) |

---

## Project structure ( in the shade-fresh folder)

```
shade/
├── programs/shade/src/lib.rs   # Anchor program (book, vaults, deposit/withdraw, match, delegate, settle)
├── app/                        # Vite + React dApp (the trading UI)
│   ├── src/App.tsx
│   └── src/lib/shade.ts        # ShadeClient — base + ER providers, Magic Router, routerBlockhash
├── scripts/
│   ├── crank.ts                # the settlement engine (run this alongside the app)
│   ├── bootstrap.ts            # one-time: create the book + vaults
│   └── cli_buyer.ts            # CLI counterparty for testing/demo
├── THESIS.md  ·  SETTLEMENT.md
└── Anchor.toml  ·  Cargo.toml
```

---

## Quickstart (devnet)

### Prerequisites
- Rust + Solana CLI + [Anchor](https://www.anchor-lang.com/) 0.32
- Node 18+
- A devnet RPC endpoint (public devnet is rate-limited for deploys — a [QuickNode](https://quicknode.com) devnet URL is recommended)
- A devnet wallet with ~5 SOL

### 1 · Install
```bash
git clone https://github.com/RachitSrivastava12/shade
cd shade
npm install
cd app && npm install && cd ..
```

### 2 · Environment
Every terminal that runs scripts/deploys needs:
```bash
export ANCHOR_WALLET=~/.config/solana/id.json
export PROVIDER_ENDPOINT=https://YOUR-QUICKNODE-DEVNET-URL/
export USDC_MINT=<your-mock-usdc-mint>     # create one with `spl-token create-token --decimals 6`
```

### 3 · Build & deploy the program
```bash
anchor build
anchor keys sync
solana program deploy target/deploy/shade.so \
  --program-id target/deploy/shade-keypair.json \
  --url $PROVIDER_ENDPOINT --use-rpc \
  --with-compute-unit-price 50000 --max-sign-attempts 1000
cp target/idl/shade.json app/public/shade.json
```

### 4 · Bootstrap the book
```bash
npm run bootstrap        # creates the order book + vault PDAs (once)
```

### 5 · Configure & run the app
```bash
cp app/.env.example app/.env
# set VITE_PROVIDER_ENDPOINT and VITE_USDC_MINT in app/.env
cd app && npm run dev
```

### 6 · Run the backend services
The always-on backend lives in **`shade-fresh/backend/`** (crank · market maker · faucet) and is what makes Shade tradable for real visitors:

```bash
cd backend && npm install
cp .env.example .env     # set ANCHOR_WALLET, PROVIDER_ENDPOINT, USDC_MINT
npm run crank            # settlement engine: delegates, watches for fills, settles + re-delegates
npm run maker            # liquidity: quotes both sides near the live SOL price (auto-funds inventory)
npm run faucet           # HTTP faucet on :8787 — drips mock USDC + gas so fresh wallets can buy
```

Now connect a wallet in the UI, claim test funds, deposit, and place an order — the maker is the counterparty and the crank settles the fill. To match from a second wallet manually:
```bash
PRICE=187 npm run cli:buyer
```

**Deploy the backend to a VPS:** see [`backend/DEPLOY.md`](./shade-fresh/backend/DEPLOY.md) (pm2 or systemd, plus an nginx/TLS faucet proxy).

---

## Deploying the app

The app is a static Vite build (`app/` → `dist/`). Deploy to any static host (e.g. Vercel: root directory `app`, framework **Vite**, build `npm run build`, output `dist`), and set the `VITE_*` env vars in the host. Point your domain at it.

---

## Key addresses (devnet)

| | |
|---|---|
| Program | `EhAEENuUTGpx6a35Xaex6Y6KPnpbxoa7zZsE21wspzxc` |
| Order book (PDA) | `CTLjfMewydqaF1zLoBoeKNW8HdCzHG5BdcFpAr8Xu7QB` |
| Base mint (wSOL) | `So11111111111111111111111111111111111111112` |
| Quote mint (mock USDC) | `DANN41Tukr829a3zzXy81QpzfqNyYendveiuvwDnho4R` |
| MagicBlock delegation program | `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh` |
| Magic Router | `https://devnet-router.magicblock.app` |

To verify the book is delegated (hidden) while an order rests:
```bash
solana account CTLjfMewydqaF1zLoBoeKNW8HdCzHG5BdcFpAr8Xu7QB --url $PROVIDER_ENDPOINT | grep -i owner
# → owner is the MagicBlock delegation program, not the Shade program
```

---

## License

MIT

---

*Shade — privacy as execution, not as cryptography. Built on [MagicBlock](https://magicblock.gg) Ephemeral Rollups.*
