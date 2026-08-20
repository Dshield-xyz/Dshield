import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "focus-ring inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
  {
    variants: {
      variant: {
        // High-emphasis call to action.
        primary:
          "bg-gradient-to-b from-brand-500 to-brand-600 text-ink-primary shadow-lg shadow-brand-950/50 hover:from-brand-400 hover:to-brand-500 hover:shadow-xl hover:shadow-brand-950/60",
        // Brand-accented action (e.g. threshold disclosure).
        accent:
          "bg-brand-600 text-ink-primary shadow-lg shadow-brand-950/50 hover:bg-brand-500",
        // Bordered, lower emphasis.
        outline:
          "border border-edge-strong text-ink-secondary hover:border-edge-strong hover:text-ink-primary",
        // Quiet, text-only.
        ghost: "text-ink-muted hover:bg-surface-interactive hover:text-ink-primary",
      },
      size: {
        sm: "px-3 py-1.5 text-xs",
        md: "px-4 py-2 text-sm",
        lg: "px-8 py-3 text-sm",
      },
      fullWidth: {
        true: "w-full",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, fullWidth, ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size, fullWidth }), className)}
        {...props}
      />
    );
  },
);
