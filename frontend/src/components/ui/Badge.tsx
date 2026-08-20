import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badge = cva(
  "inline-block rounded-full px-2.5 py-0.5 text-xs font-medium",
  {
    variants: {
      tone: {
        green: "bg-green-900/30 text-green-400",
        blue: "bg-blue-900/30 text-blue-400",
        purple: "bg-purple-900/30 text-purple-400",
        zinc: "bg-surface-raised text-ink-secondary",
      },
    },
    defaultVariants: { tone: "zinc" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badge> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)} {...props} />;
}
