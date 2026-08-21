"use client";

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StellarWalletsKit, type Networks } from "@creit.tech/stellar-wallets-kit";
import { getNetworkPassphrase, getDevKeypair, devSignTransaction } from "@/lib/stellar";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";

interface WalletContextType {
  address: string | null;
  network: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  isConnecting: boolean;
  /** Incremented on every connect or disconnect so pages can detect wallet
   *  state changes mid-flow (e.g., to pause a running operation). */
  connectionVersion: number;
  /** Timestamp of the most recent disconnect, or null if never disconnected
   *  since mount. Pages check this alongside address to distinguish a
   *  mid-flow disconnect from initial mount. */
  lastDisconnectAt: number | null;
}

const WalletContext = createContext<WalletContextType>({
  address: null,
  network: "",
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
  isConnecting: false,
  connectionVersion: 0,
  lastDisconnectAt: null,
});

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const initialized = useRef(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionVersion, setConnectionVersion] = useState(0);
  const [lastDisconnectAt, setLastDisconnectAt] = useState<number | null>(null);
  const network = getNetworkPassphrase();

  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const devKeypair = getDevKeypair();
    if (devKeypair) {
      const addr = devKeypair.publicKey();
      localStorage.setItem("dshield_wallet", addr);
      setAddress(addr);
    } else {
      const saved = localStorage.getItem("dshield_wallet");
      if (saved) {
        setAddress(saved);
      }
    }

    const passphrase = getNetworkPassphrase();
    StellarWalletsKit.init({
      network: passphrase as Networks,
      selectedWalletId: "freighter",
      modules: [
        new FreighterModule(),
        new xBullModule(),
        new LobstrModule(),
        new HanaModule(),
        new AlbedoModule(),
      ],
    });
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const devKeypair = getDevKeypair();
      if (devKeypair) {
        const addr = devKeypair.publicKey();
        setAddress(addr);
        localStorage.setItem("dshield_wallet", addr);
      } else {
        const { address: addr } = await StellarWalletsKit.authModal();
        setAddress(addr);
        localStorage.setItem("dshield_wallet", addr);
      }
      setConnectionVersion((v) => v + 1);
    } catch {
      // user closed modal
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch {
      // ignore
    }
    setAddress(null);
    setConnectionVersion((v) => v + 1);
    setLastDisconnectAt(Date.now());
    localStorage.removeItem("dshield_wallet");
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (getDevKeypair()) {
        return devSignTransaction(xdr);
      }
      const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: getNetworkPassphrase(),
      });
      return signedTxXdr;
    },
    [],
  );

  return (
    <WalletContext.Provider
      value={{ address, network, connect, disconnect, signTransaction, isConnecting, connectionVersion, lastDisconnectAt }}
    >
      {children}
    </WalletContext.Provider>
  );
}
