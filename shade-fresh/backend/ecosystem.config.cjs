// PM2 process manager config for the Shade backend.
// Usage on the VPS (from this backend/ dir, after `npm install` and creating `.env`):
//   pm2 start ecosystem.config.cjs
//   pm2 logs            # tail all three
//   pm2 save            # persist across reboots (after `pm2 startup`)
//
// Each app loads ./.env via dotenv (imported in src/config.ts).
const ts = "./node_modules/.bin/ts-node";

module.exports = {
  apps: [
    {
      name: "shade-crank",
      script: ts,
      args: "src/crank.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 4000,
      time: true,
    },
    {
      name: "shade-maker",
      script: ts,
      args: "src/maker.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 4000,
      time: true,
    },
    {
      name: "shade-faucet",
      script: ts,
      args: "src/faucet.ts",
      cwd: __dirname,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 4000,
      time: true,
    },
  ],
};
