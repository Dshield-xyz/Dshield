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
import {
  getNetworkPassphrase,
  getDevKeypair,
  getDevSecretKeyWarning,
  devSignTransaction,
} from "@/lib/stellar";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { HanaModule } from "@creit.tech/stellar-wallets-kit/modules/hana";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";

interface WalletContextType {
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  isConnecting: boolean;
}

const WalletContext = createContext<WalletContextType>({
  address: null,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
  isConnecting: false,
});

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const initialized = useRef(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [devSecretWarning, setDevSecretWarning] = useState<string | null>(null);

  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const warning = getDevSecretKeyWarning();
    setDevSecretWarning(warning);
    if (warning) {
      console.error(warning);
    }

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
      value={{ address, connect, disconnect, signTransaction, isConnecting }}
    >
      {devSecretWarning ? (
        <div role="alert" style={{ color: "#fca5a5", padding: "0.75rem" }}>
          {devSecretWarning}
        </div>
      ) : null}
      {children}
    </WalletContext.Provider>
  );
}
