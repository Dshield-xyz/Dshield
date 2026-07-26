import { cva } from "class-variance-authority";
import { cn } from "@/lib/cn";

const status = cva("rounded-xl p-3 text-sm", {
  variants: {
    tone: {
      error: "bg-red-900/30 text-red-400",
      success: "bg-green-900/30 text-green-400",
      info: "bg-zinc-800 text-zinc-300",
    },
  },
  defaultVariants: { tone: "info" },
});

/**
 * Infer tone from a status string the same way the flows always have: anything
 * starting with "Error" is an error, anything containing one of `successHints`
 * is a success, everything else is neutral progress text.
 */
function inferTone(
  message: string,
  successHints: string[],
): "error" | "success" | "info" {
  if (message.startsWith("Error")) return "error";
  if (successHints.some((hint) => message.includes(hint))) return "success";
  return "info";
}

export interface StatusMessageProps {
  message: string;
  /** Substrings that mark the message as a success. Defaults to ["successful"]. */
  successHints?: string[];
  className?: string;
}

export function StatusMessage({
  message,
  successHints = ["successful"],
  className,
}: StatusMessageProps) {
  if (!message) return null;
  const tone = inferTone(message, successHints);
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className={cn(status({ tone }), className)}
    >
      {message}
    </div>
  );
}
