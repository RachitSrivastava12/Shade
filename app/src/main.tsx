import { Buffer } from "buffer";
// @ts-ignore
window.Buffer = window.Buffer || Buffer;

import React, { useMemo } from "react";
import ReactDOM from "react-dom/client";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import App from "./App";
import "./styles.css";

const BASE_RPC =
  (import.meta as any).env?.VITE_BASE_RPC || "https://api.devnet.solana.com";

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={BASE_RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
