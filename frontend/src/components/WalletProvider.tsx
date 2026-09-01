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
import {
  LedgerModule,
  LEDGER_ID,
} from "@creit.tech/stellar-wallets-kit/modules/ledger";

interface WalletContextType {
  address: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  isConnecting: boolean;
  /** True when the connected wallet is a hardware device (Ledger). */
  isHardwareWallet: boolean;
}

const WalletContext = createContext<WalletContextType>({
  address: null,
  connect: async () => {},
  disconnect: () => {},
  signTransaction: async () => "",
  isConnecting: false,
  isHardwareWallet: false,
});

/**
 * Whether the wallet currently selected in the kit is a hardware device.
 * The kit's `selectedModule` getter throws when no wallet has been set yet,
 * which is fine here: before a connect the answer is simply "no".
 */
function getSelectedWalletIsHardware(): boolean {
  try {
    return StellarWalletsKit.selectedModule.productId === LEDGER_ID;
  } catch {
    return false;
  }
}

export function useWallet() {
  return useContext(WalletContext);
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const initialized = useRef(false);
  const [address, setAddress] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isHardwareWallet, setIsHardwareWallet] = useState(false);

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
        // Hardware wallet option: signs every transaction on-device, so
        // signing is slower and needs a "confirm on your device" UX (see
        // the Ledger-await states on the deposit/withdraw pages).
        new LedgerModule(),
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
        setIsHardwareWallet(false);
      } else {
        const { address: addr } = await StellarWalletsKit.authModal();
        setAddress(addr);
        localStorage.setItem("dshield_wallet", addr);
        setIsHardwareWallet(getSelectedWalletIsHardware());
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
    setIsHardwareWallet(false);
    localStorage.removeItem("dshield_wallet");
  }, []);

  // Already async end-to-end: it awaits the wallet's own signing prompt, so it
  // also covers hardware wallets — the Ledger module resolves only after the
  // user confirms on-device (unlike a browser extension popup, this can take
  // several seconds and fails with device-specific errors, hence the
  // "confirm on your device" UI states and friendlyError hardware handling).
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
        isHardwareWallet,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}
