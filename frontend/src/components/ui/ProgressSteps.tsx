import { Spinner } from "./Spinner";

export interface ProgressStepsProps {
  /** Human-readable label for the current step. */
  label: string;
  /** Ordered list of step keys that make up the flow. */
  steps: readonly string[];
  /** The currently active step key. */
  current: string;
}

/**
 * Spinner + label + segmented progress bar. Shared by the withdraw and
 * compliance flows, which both advance through an ordered list of step keys.
 * A segment is filled once the current step's index reaches it.
 */
export function ProgressSteps({ label, steps, current }: ProgressStepsProps) {
  const currentIndex = steps.indexOf(current);
  const progress = Math.round(((currentIndex + 1) / steps.length) * 100);

  return (
    <div className="rounded-xl bg-zinc-800/80 p-4">
      <div className="flex items-center gap-3">
        <Spinner />
        <span className="text-sm text-zinc-300">{label}</span>
      </div>
      <div
        className="mt-3 flex gap-1"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Progress: ${label}`}
      >
        {steps.map((step, i) => (
          <div
            key={step}
            className={`h-1 flex-1 rounded-full ${
              currentIndex >= i ? "bg-white" : "bg-zinc-700"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
