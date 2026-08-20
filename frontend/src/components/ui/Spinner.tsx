import { cn } from "@/lib/cn";

/** Indeterminate loading spinner. Inherits size via className (default h-4 w-4). */
export function Spinner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={cn(
        "h-4 w-4 animate-spin rounded-full border-2 border-ink-muted border-t-ink-primary",
        className,
      )}
    />
  );
}
