# Shade — real token settlement (wSOL / USDC) on devnet

This adds a **real custody + settlement layer** on top of the ER order book:
tokens move on the **base layer** at deposit/withdraw; the **ER only matches**;
settlement reallocates a credited ledger after the book commits home. Costs only devnet SOL.

## What changed
- **Program** (`programs/shade/src/lib.rs`): added `init_vaults`, `init_user`,
  `deposit_base`, `deposit_quote`, `withdraw_base`, `withdraw_quote`, `settle_fill`.
  `OrderBook` now stores `base_mint` / `quote_mint` / `settled_seq`; `Fill` now records
  `buyer` / `seller`. **Book seed bumped to `book_v2`** (fresh PDA — no clash with the old book).
- **Cargo.toml**: added `anchor-spl = "1.0.2"` (matches your `anchor-lang 1.0.2`).
- **Client** (`app/src/lib/shade.ts`): deposit/withdraw/settle + SOL→wSOL wrapping.
- **UI** (`App.tsx`): a **Funds** panel (deposit/withdraw + live credited balances) and a
  7-step operator lifecycle.
- **`scripts/demo_settle.ts`**: full two-wallet proof (seller sells SOL, buyer pays USDC).

### Settlement scaling (fixed integers, program & client agree)
- `size` unit = 0.001 base → base lamports = `size × 1_000_000`
- `price` = quote-per-base ×100 (e.g. 18738 = $187.38)
- quote (6-dec USDC) = `price × size × 10`
- check: price 18738, size 10 → 0.01 wSOL ↔ 1.8738 USDC ✓

---

## Commands (run in order)

All from the inner project dir (the one with `Anchor.toml`).

### 1. Install deps
```bash
yarn                 # root
cd app && yarn       # installs @solana/spl-token
cd ..
```

### 2. Create a mock USDC mint (6 decimals) and mint yourself some
```bash
solana config get                         # confirm devnet
spl-token create-token --decimals 6       # ⤷ COPY this mint address
spl-token create-account <USDC_MINT>
spl-token mint <USDC_MINT> 100000         # 100,000 test USDC
```
(Base mint is wSOL `So11111111111111111111111111111111111111112` — nothing to create.)

### 3. Build the program  ← the one thing I couldn't test for you
```bash
anchor build
```
If it errors, **paste me the full error output** — the SPL API is verified against
anchor-spl 1.0.2, but the ER macros + SPL combo is the only untested part. We fix and rebuild.

### 4. Sync the IDL to the app
```bash
cp target/idl/shade.json app/src/lib/
cp target/idl/shade.json app/public/
```

### 5. Deploy (upgrade — same program id)
```bash
anchor deploy
# or via QuickNode if devnet airdrop/RPC is flaky:
# solana program deploy target/deploy/shade.so \
#   --url <your-quicknode-devnet-url> \
#   --with-compute-unit-price 50000 --max-sign-attempts 1000
```

### 6. Point the app + script at your USDC mint
```bash
echo "VITE_USDC_MINT=<USDC_MINT>" > app/.env
export USDC_MINT=<USDC_MINT>
export ANCHOR_WALLET=~/.config/solana/id.json
```

### 7a. Reliable proof — CLI lifecycle (no Phantom friction)
```bash
npm run demo:settle
```
Expected tail:
```
── RESULT (real on-chain token movement) ──
  buyer  wSOL: 0.0000 → 0.0100
  seller USDC: X → X+1.87
SOL sold for USDC, matched privately on the ER, settled on Solana devnet.
```

### 7b. The UI
```bash
cd app && yarn dev
```
Operator controls (gear): **01** create book + mints → **02** init vaults →
**03** init my balance → **04** delegate → place Buy/Sell → **05** run matching →
**06** settle & undelegate → **07** settle fills → balances.
**Funds** panel: deposit wSOL/USDC, watch credited balances, withdraw.
(Place/match are ER txs — Phantom shows the “reverted during simulation” notice; that’s the
known devnet-ER quirk, check “I understand”. Deposit/withdraw/settle are base-layer and sign clean.)

---

## Two-wallet UI demo (real transfer between people)
Single Phantom wallet self-trades net to zero (custody is still real). To show SOL→USDC
*between parties* in the UI, open a second browser profile with a second Phantom wallet,
fund it, and have one side post the bid and the other the ask. The CLI `demo:settle` already
does the two-wallet version automatically.

## If `anchor build` fails
Paste the errors. Most likely fixes live in `init_vaults` (token-account init constraints) —
all isolated from your working ER/match code, which is unchanged in structure.
