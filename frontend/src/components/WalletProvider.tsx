"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
import { KitEventType } from "@creit.tech/stellar-wallets-kit";

interface WalletContextType {
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  isConnecting: boolean;
  /** The wallet's current network passphrase, or null when disconnected */
  walletNetwork: string | null;
  /** True when the wallet is connected to a different network than the app expects */
  networkMismatch: boolean;
  /** Monotonically increasing counter bumped on every disconnect/network-change event */
  walletEventCount: number;
}

const WalletContext = createContext<WalletContextType>({
  address: null,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
  isConnecting: false,
  walletNetwork: null,
  networkMismatch: false,
  walletEventCount: 0,
});

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const initialized = useRef(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [walletNetwork, setWalletNetwork] = useState<string | null>(null);
  const [walletEventCount, setWalletEventCount] = useState(0);

  const expectedNetwork = getNetworkPassphrase();
  const networkMismatch =
    !!address && !!walletNetwork && walletNetwork !== expectedNetwork;

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const devKeypair = getDevKeypair();
    if (devKeypair) {
      const addr = devKeypair.publicKey();
      localStorage.setItem("dshield_wallet", addr);
      setAddress(addr);
      setWalletNetwork(expectedNetwork);
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
  }, [expectedNetwork]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Subscribe to StellarWalletsKit events for disconnect/network-change
  useEffect(() => {
    if (typeof window === "undefined") return;

    const unsubs: (() => void)[] = [];

    // Listen for kit-level disconnect events
    try {
      const unsubDisconnect = StellarWalletsKit.on(
        KitEventType.DISCONNECT,
        () => {
          setAddress(null);
          setWalletNetwork(null);
          localStorage.removeItem("dshield_wallet");
          setWalletEventCount((c) => c + 1);
        },
      );
      unsubs.push(unsubDisconnect);
    } catch {
      // Kit may not be initialized yet in tests
    }

    // Listen for kit-level state changes (address/network switch)
    try {
      const unsubState = StellarWalletsKit.on(
        KitEventType.STATE_UPDATED,
        (event) => {
          const { address: newAddress, networkPassphrase } = event.payload;

          // If address became undefined (external disconnect), clear state
          if (newAddress === undefined) {
            setAddress(null);
            localStorage.removeItem("dshield_wallet");
          } else if (newAddress !== null && newAddress !== undefined) {
            setAddress(newAddress);
          }

          if (networkPassphrase) {
            setWalletNetwork(networkPassphrase);
          }

          setWalletEventCount((c) => c + 1);
        },
      );
      unsubs.push(unsubState);
    } catch {
      // Kit may not be initialized yet in tests
    }

    // Listen for module-level changes (wallet extension external events)
    const subscribeModuleOnChange = async () => {
      try {
        const module = StellarWalletsKit.selectedModule;
        if (module && typeof module.onChange === "function") {
          module.onChange((event) => {
            if (event.address) {
              setAddress(event.address);
            }
            if (event.networkPassphrase) {
              setWalletNetwork(event.networkPassphrase);
            }
            setWalletEventCount((c) => c + 1);
          });
        }
      } catch {
        // Module not selected yet
      }
    };
    subscribeModuleOnChange();

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, []);

  const connect = useCallback(async () => {
    setIsConnecting(true);
    try {
      const devKeypair = getDevKeypair();
      if (devKeypair) {
        const addr = devKeypair.publicKey();
        setAddress(addr);
        setWalletNetwork(expectedNetwork);
        localStorage.setItem("dshield_wallet", addr);
      } else {
        const { address: addr } = await StellarWalletsKit.authModal();
        setAddress(addr);
        setWalletNetwork(expectedNetwork);
        localStorage.setItem("dshield_wallet", addr);
      }
    } catch {
      // user closed modal
    } finally {
      setIsConnecting(false);
    }
  }, [expectedNetwork]);

  const disconnect = useCallback(async () => {
    try {
      await StellarWalletsKit.disconnect();
    } catch {
      // ignore
    }
    setAddress(null);
    setWalletNetwork(null);
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
      value={{
        address,
        connect,
        disconnect,
        signTransaction,
        isConnecting,
        walletNetwork,
        networkMismatch,
        walletEventCount,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}