// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import {
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { WalletProvider, useWallet } from "./WalletProvider";

// Mock the StellarWalletsKit and its wallet modules wholesale — this stands in
// for a mocked Ledger transport: the LedgerModule class here is a fake device
// whose productId identifies it as hardware, and the kit's sign/connect calls
// are stubbed like a real (mock) device session would behave.
const { kitMock, ledgerMock } = vi.hoisted(() => {
  const kitMock = {
    init: vi.fn(),
    authModal: vi.fn(),
    signTransaction: vi.fn(),
    disconnect: vi.fn(),
    selectedModule: { productId: "FREIGHTER", moduleType: "HOT_WALLET" },
  };
  const ledgerMock = {
    LEDGER_ID: "LEDGER",
    LedgerModule: class LedgerModule {
      productId = "LEDGER";
      productName = "Ledger";
      moduleType = "HW_WALLET";
    },
  };
  return { kitMock, ledgerMock };
});

vi.mock("@creit.tech/stellar-wallets-kit", () => ({
  StellarWalletsKit: kitMock,
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/ledger", () => ledgerMock);
vi.mock("@creit.tech/stellar-wallets-kit/modules/freighter", () => ({
  FreighterModule: class {
    productId = "FREIGHTER";
  },
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/xbull", () => ({
  xBullModule: class {},
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/lobstr", () => ({
  LobstrModule: class {},
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/hana", () => ({
  HanaModule: class {},
}));
vi.mock("@creit.tech/stellar-wallets-kit/modules/albedo", () => ({
  AlbedoModule: class {},
}));

const LEDGER_ADDRESS = "GALEDGERDEVICEADDRESS0000000000000000000000000000000000001";

function Probe() {
  const wallet = useWallet();
  const [signed, setSigned] = useState<string>("");
  return (
    <div>
      <span data-testid="address">{wallet.address ?? "none"}</span>
      <span data-testid="hardware">{String(wallet.isHardwareWallet)}</span>
      <span data-testid="signed">{signed}</span>
      <button data-testid="connect" onClick={() => void wallet.connect()}>
        connect
      </button>
      <button
        data-testid="sign"
        onClick={() => {
          wallet
            .signTransaction("XDR-INPUT")
            .then((s) => setSigned(s))
            .catch(() => setSigned("ERROR"));
        }}
      >
        sign
      </button>
      <button data-testid="disconnect" onClick={() => wallet.disconnect()}>
        disconnect
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <WalletProvider>
      <Probe />
    </WalletProvider>,
  );
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  kitMock.selectedModule = { productId: "FREIGHTER", moduleType: "HOT_WALLET" };
  kitMock.authModal.mockResolvedValue({ address: LEDGER_ADDRESS });
  kitMock.signTransaction.mockResolvedValue({ signedTxXdr: "SIGNED-XDR" });
});

describe("WalletProvider — Ledger hardware wallet", () => {
  it("registers the Ledger module alongside the browser-extension wallets", () => {
    renderProvider();
    expect(kitMock.init).toHaveBeenCalledTimes(1);
    const modules = kitMock.init.mock.calls[0][0].modules as {
      productId: string;
    }[];
    expect(modules.some((m) => m.productId === "LEDGER")).toBe(true);
    // The five software wallets are still registered.
    expect(modules.some((m) => m.productId === "FREIGHTER")).toBe(true);
    expect(modules.length).toBe(6);
  });

  it("flags isHardwareWallet after connecting through the Ledger", async () => {
    kitMock.selectedModule = { productId: "LEDGER", moduleType: "HW_WALLET" };
    renderProvider();

    fireEvent.click(screen.getByTestId("connect"));

    expect((await screen.findByTestId("address")).textContent).toBe(
      LEDGER_ADDRESS,
    );
    expect(screen.getByTestId("hardware").textContent).toBe("true");
    expect(kitMock.authModal).toHaveBeenCalledTimes(1);
  });

  it("does not flag a software wallet as hardware", async () => {
    renderProvider();

    fireEvent.click(screen.getByTestId("connect"));

    expect((await screen.findByTestId("address")).textContent).toBe(
      LEDGER_ADDRESS,
    );
    expect(screen.getByTestId("hardware").textContent).toBe("false");
  });

  it("delegates signing to the kit and returns the signed XDR", async () => {
    renderProvider();

    fireEvent.click(screen.getByTestId("sign"));

    expect((await screen.findByTestId("signed")).textContent).toBe(
      "SIGNED-XDR",
    );
    expect(kitMock.signTransaction).toHaveBeenCalledWith("XDR-INPUT", {
      networkPassphrase: "Standalone Network ; February 2017",
    });
  });

  it("clears the hardware flag on disconnect", async () => {
    kitMock.selectedModule = { productId: "LEDGER", moduleType: "HW_WALLET" };
    renderProvider();

    fireEvent.click(screen.getByTestId("connect"));
    expect((await screen.findByTestId("address")).textContent).toBe(
      LEDGER_ADDRESS,
    );
    expect(screen.getByTestId("hardware").textContent).toBe("true");

    fireEvent.click(screen.getByTestId("disconnect"));
    expect((await screen.findByTestId("address")).textContent).toBe("none");
    expect(screen.getByTestId("hardware").textContent).toBe("false");
    expect(kitMock.disconnect).toHaveBeenCalledTimes(1);
  });
});