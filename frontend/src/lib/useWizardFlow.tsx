"use client";

import { useCallback, useState } from "react";
import { useWallet } from "@/components/WalletProvider";
import { ConnectGate } from "@/components/ui/Page";
import { ProgressSteps } from "@/components/ui/ProgressSteps";
import { useToast } from "@/components/ui/Toast";
import { friendlyError } from "@/lib/errors";

export interface WizardGate {
  /** Page title shown by the ConnectGate empty state. */
  title: string;
  /** Prompt text shown by the ConnectGate empty state. */
  prompt: string;
}

export interface WizardFlowOptions<Step extends string> {
  /**
   * Ordered step keys that make up the flow, used to render the shared
   * <ProgressSteps> bar. Omit for pages that don't have a step machine.
   */
  steps?: readonly Step[];
  /** Human-readable label for each step (used by the progress bar). */
  labels?: Record<Step, string>;
  /**
   * When provided, the hook returns a `walletGate` node rendering
   * <ConnectGate> whenever no wallet is connected.
   */
  gate?: WizardGate;
}

/**
 * Shared multi-step flow state for the deposit / withdraw / compliance pages.
 *
 * Encapsulates the state that those pages previously reimplemented
 * independently: the current step + ordered progress steps (withdraw),
 * loading/error/confirmation transitions with standardized friendly-error
 * handling, and wallet-connection gating.
 */
export function useWizardFlow<Step extends string>(
  options: WizardFlowOptions<Step> = {},
) {
  const { address, signTransaction } = useWallet();
  const { toast } = useToast();
  const [step, setStep] = useState<Step | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  /**
   * Normalize an error into a friendly message and surface it through the
   * shared toast system. Returns the friendly message so callers can also
   * attach it to their own state (e.g. per-note error rows).
   */
  const reportError = useCallback(
    (err: unknown): string => {
      const msg = friendlyError(err);
      toast(msg, "error");
      return msg;
    },
    [toast],
  );

  /**
   * Run an async operation with the global loading guard. Catches errors,
   * reports them via `reportError`, and always clears the loading flag.
   * Returns the operation's result, or undefined when it threw.
   */
  const run = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setIsLoading(true);
      try {
        return await fn();
      } catch (err) {
        reportError(err);
        return undefined;
      } finally {
        setIsLoading(false);
      }
    },
    [reportError],
  );

  /**
   * Renders the shared <ProgressSteps> bar for the current step, or null
   * when the flow has no steps / isn't active. `label` overrides the label
   * looked up from `options.labels` (withdraw page uses this to show
   * proof-stage sub-labels).
   */
  const renderProgress = useCallback(
    (label?: string) => {
      if (!options.steps || !step) return null;
      const resolved =
        label ?? (options.labels ? options.labels[step] : "") ?? "";
      return (
        <ProgressSteps
          label={resolved}
          steps={options.steps}
          current={step}
        />
      );
    },
    [options.steps, options.labels, step],
  );

  /** ConnectGate empty state when gating is enabled and no wallet is linked. */
  const walletGate =
    options.gate && !address ? (
      <ConnectGate title={options.gate.title} prompt={options.gate.prompt} />
    ) : null;

  return {
    address,
    signTransaction,
    step,
    setStep,
    isLoading,
    setIsLoading,
    reportError,
    run,
    renderProgress,
    walletGate,
  };
}