import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const card = cva("aurora-border rounded-2xl border bg-surface-card/70 backdrop-blur-sm", {
  variants: {
    border: {
      default: "border-edge-default",
      brand: "border-brand-500/30 bg-brand-950/10",
    },
    interactive: {
      true: "transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-500/40 hover:shadow-lg hover:shadow-brand-950/40",
    },
    padding: {
      none: "",
      sm: "p-4",
      md: "p-6",
    },
  },
  defaultVariants: {
    border: "default",
    padding: "md",
  },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof card> {}

export function Card({
  className,
  border,
  interactive,
  padding,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(card({ border, interactive, padding }), className)}
      {...props}
    />
  );
}

/** Small uppercase-weight section label used as a card heading. */
export function CardLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn("text-sm font-medium text-ink-muted", className)}
      {...props}
    />
  );
}
