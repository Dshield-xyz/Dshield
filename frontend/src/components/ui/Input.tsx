import { forwardRef, useId } from "react";
import { cn } from "@/lib/cn";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  /** Helper text rendered under the field. Accepts rich content. */
  hint?: React.ReactNode;
  /** Render value in a monospace font (addresses, hashes, amounts). */
  mono?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, label, hint, mono, id, ...props },
  ref,
) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;

  return (
    <div>
      {label && (
        <label htmlFor={inputId} className="mb-1.5 block text-xs text-ink-subtle">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        aria-describedby={hint ? hintId : undefined}
        className={cn(
          "aurora-field w-full rounded-xl p-3 text-sm text-ink-primary placeholder-ink-faint outline-none",
          mono && "font-mono text-xs",
          className,
        )}
        {...props}
      />
      {hint && (
        <p id={hintId} className="mt-1.5 text-xs text-ink-faint">
          {hint}
        </p>
      )}
    </div>
  );
});
