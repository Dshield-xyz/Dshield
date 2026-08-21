// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, render } from "@testing-library/react";
import { useWizardFlow } from "./useWizardFlow";

// --- Mock wallet (default: no address) ---
const mockWallet: { address: string | null; signTransaction: ReturnType<typeof vi.fn> } = { address: null, signTransaction: vi.fn() };
vi.mock("@/components/WalletProvider", () => ({
  useWallet: () => mockWallet,
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// --- Mock toast ---
const mockToast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({
  useToast: () => ({ toast: mockToast }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// --- Mock ConnectGate ---
vi.mock("@/components/ui/Page", () => ({
  ConnectGate: ({ title }: { title: string; prompt: string }) => (
    <div data-testid="connect-gate">{title}</div>
  ),
  PageShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PageHeader: () => null,
}));

// --- Mock ProgressSteps ---
vi.mock("@/components/ui/ProgressSteps", () => ({
  ProgressSteps: ({
    label,
    steps,
    current,
  }: {
    label: string;
    steps: readonly string[];
    current: string;
  }) => (
    <div data-testid="progress-steps">
      {label} | steps:{steps.join(",")} | current:{current}
    </div>
  ),
}));

// --- Mock errors ---
vi.mock("@/lib/errors", () => ({
  friendlyError: (err: unknown) => {
    if (err instanceof Error) return err.message;
    return String(err);
  },
}));

beforeEach(() => {
  mockWallet.address = null;
  mockToast.mockClear();
});

describe("useWizardFlow", () => {
  it("returns default state when called without options", () => {
    const { result } = renderHook(() => useWizardFlow());

    expect(result.current.step).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.walletGate).toBeNull();
    expect(result.current.renderProgress()).toBeNull();
  });

  it("returns walletGate when gate is configured and no address", () => {
    const { result } = renderHook(() =>
      useWizardFlow({ gate: { title: "Deposit", prompt: "Connect wallet" } }),
    );

    expect(result.current.walletGate).not.toBeNull();
    const { getByTestId } = render(<>{result.current.walletGate}</>);
    expect(getByTestId("connect-gate")).toBeTruthy();
  });

  it("returns null walletGate when wallet is connected", () => {
    mockWallet.address = "G1234567890abcdef";
    const { result } = renderHook(() =>
      useWizardFlow({ gate: { title: "Deposit", prompt: "Connect wallet" } }),
    );

    expect(result.current.walletGate).toBeNull();
  });

  it("setStep updates the step value", () => {
    const steps = ["a", "b", "c"] as const;
    const { result } = renderHook(() => useWizardFlow({ steps }));

    act(() => {
      result.current.setStep("b");
    });

    expect(result.current.step).toBe("b");
  });

  it("setIsLoading toggles isLoading", () => {
    const { result } = renderHook(() => useWizardFlow());

    expect(result.current.isLoading).toBe(false);

    act(() => {
      result.current.setIsLoading(true);
    });

    expect(result.current.isLoading).toBe(true);

    act(() => {
      result.current.setIsLoading(false);
    });

    expect(result.current.isLoading).toBe(false);
  });

  it("reportError calls friendlyError and toast with error tone", () => {
    const { result } = renderHook(() => useWizardFlow());

    const msg = result.current.reportError(new Error("Something went wrong"));

    expect(msg).toBe("Something went wrong");
    expect(mockToast).toHaveBeenCalledWith("Something went wrong", "error");
  });

  it("run returns the result when fn succeeds", async () => {
    const { result } = renderHook(() => useWizardFlow());

    let output: string | undefined;
    await act(async () => {
      output = await result.current.run(async () => "success");
    });

    expect(output).toBe("success");
    expect(result.current.isLoading).toBe(false);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("run reports error when fn throws and returns undefined", async () => {
    const { result } = renderHook(() => useWizardFlow());

    let output: string | undefined;
    await act(async () => {
      output = await result.current.run(async () => {
        throw new Error("oops");
      });
    });

    expect(output).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
    expect(mockToast).toHaveBeenCalledWith("oops", "error");
  });

  it("renderProgress returns null when no steps configured", () => {
    const { result } = renderHook(() => useWizardFlow());

    expect(result.current.renderProgress()).toBeNull();
  });

  it("renderProgress returns null when step is null", () => {
    const steps = ["a", "b"] as const;
    const { result } = renderHook(() => useWizardFlow({ steps }));

    expect(result.current.renderProgress()).toBeNull();
  });

  it("renderProgress renders ProgressSteps when step is set", () => {
    const steps = ["a", "b", "c"] as const;
    const labels: Record<string, string> = { a: "Step A", b: "Step B", c: "Step C" };
    const { result } = renderHook(() => useWizardFlow({ steps, labels }));

    act(() => {
      result.current.setStep("b");
    });

    const el = result.current.renderProgress();
    expect(el).not.toBeNull();
    const { getByTestId } = render(<>{el}</>);
    expect(getByTestId("progress-steps")).toBeTruthy();
  });

  it("renderProgress accepts override label", () => {
    const steps = ["a", "b"] as const;
    const labels: Record<string, string> = { a: "Step A", b: "Step B" };
    const { result } = renderHook(() => useWizardFlow({ steps, labels }));

    act(() => {
      result.current.setStep("a");
    });

    const el = result.current.renderProgress("Override label");
    const { getByText } = render(<>{el}</>);
    expect(getByText(/Override label/)).toBeTruthy();
  });

  it("returns signTransaction from wallet", () => {
    const { result } = renderHook(() => useWizardFlow());

    expect(result.current.signTransaction).toBe(mockWallet.signTransaction);
  });
});