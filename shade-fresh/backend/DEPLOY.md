# Shade backend — Hostinger VPS deploy

Three always-on services keep Shade tradable:

| Service | What it does |
|---|---|
| `shade-crank` | Watches the rollup, settles fills on Solana, keeps the book delegated. |
| `shade-maker` | Quotes bids + asks around the live SOL price so visitors always have a counterparty. Auto-funds its own inventory (mints mock USDC, wraps SOL). |
| `shade-faucet` | HTTP service (`:8787`) that drips mock USDC + a little devnet SOL to a visitor's wallet so they can trade. |

All three share one wallet — the **program authority + USDC mint authority** (`5Nnv9…` on the current deploy). It needs a few devnet SOL for gas.

---

## 0 · What you need

- A Hostinger Ubuntu VPS (22.04/24.04) with root or sudo SSH.
- The authority wallet keypair JSON (the same `~/.config/solana/id.json` used to deploy the program / create the USDC mint).
- A devnet RPC URL (QuickNode/Helius — public devnet is rate-limited).

---

## 1 · Base setup (run on the VPS)

```bash
# Node 20 + build tools + pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2
```

## 2 · Get the code onto the VPS

Option A — from your machine, rsync just the backend (recommended):
```bash
# run locally, from shade-fresh/
rsync -av --exclude node_modules --exclude .env backend/ root@YOUR_VPS_IP:/opt/shade-backend/
```

Option B — clone the repo on the VPS:
```bash
git clone https://github.com/RachitSrivastava12/shade /opt/shade && cd /opt/shade/shade-fresh/backend
```

## 3 · Upload the wallet keypair

```bash
# locally
scp ~/.config/solana/id.json root@YOUR_VPS_IP:/root/.config/solana/id.json
# on the VPS
chmod 600 /root/.config/solana/id.json
```

## 4 · Configure

```bash
cd /opt/shade-backend          # (or .../shade-fresh/backend)
npm install
cp .env.example .env
nano .env                      # set ANCHOR_WALLET, PROVIDER_ENDPOINT, USDC_MINT
```

## 5 · Start everything with pm2

```bash
pm2 start ecosystem.config.cjs
pm2 logs                       # watch — you should see the maker quote + the crank tick
pm2 save                       # remember the process list
pm2 startup                    # prints a command — run it so pm2 restarts on reboot
```

Useful: `pm2 status`, `pm2 restart shade-maker`, `pm2 logs shade-crank --lines 100`.

## 6 · Expose the faucet (so the UI button works)

The faucet listens on `:8787`. Two options:

**Quick (open the port):**
```bash
sudo ufw allow 8787/tcp
# UI env:  VITE_FAUCET_URL=http://YOUR_VPS_IP:8787
```

**Proper (nginx + TLS on a subdomain like `api.tradeshade.online`):**
```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo tee /etc/nginx/sites-available/shade-faucet >/dev/null <<'NGINX'
server {
  server_name api.tradeshade.online;
  location / { proxy_pass http://127.0.0.1:8787; proxy_set_header Host $host; }
}
NGINX
sudo ln -s /etc/nginx/sites-available/shade-faucet /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.tradeshade.online
# then in .env: FAUCET_CORS_ORIGIN=https://tradeshade.online
# and in the app build: VITE_FAUCET_URL=https://api.tradeshade.online
```

Point the `api` DNS A record at the VPS IP first.

---

## systemd alternative (instead of pm2)

Copy the units in `systemd/`, then:
```bash
sudo cp systemd/shade-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now shade-crank shade-maker shade-faucet
journalctl -u shade-maker -f
```
Edit the `WorkingDirectory`, `User`, and `EnvironmentFile` paths in each unit to match where you put the code.

---

## Sanity checks

```bash
# faucet alive?
curl -s http://127.0.0.1:8787/health
# claim test funds for an address
curl -s -X POST http://127.0.0.1:8787/faucet -H 'Content-Type: application/json' -d '{"address":"<WALLET>"}'
# is the wallet funded for gas? (needs a couple SOL)
solana balance <AUTHORITY> --url <RPC>
```

If the maker says `needs funding` / txns fail with insufficient lamports, top up the authority wallet with devnet SOL.
