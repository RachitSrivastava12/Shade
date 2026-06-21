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
  (import.meta as any).env?.VITE_BASE_RPC ||
  (import.meta as any).env?.VITE_PROVIDER_ENDPOINT ||
  "https://api.devnet.solana.com";
const SolanaConnectionProvider = ConnectionProvider as any;
const SolanaWalletProvider = WalletProvider as any;
const SolanaWalletModalProvider = WalletModalProvider as any;

function Root() {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <SolanaConnectionProvider endpoint={BASE_RPC}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <SolanaWalletModalProvider>
          <App />
        </SolanaWalletModalProvider>
      </SolanaWalletProvider>
    </SolanaConnectionProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
