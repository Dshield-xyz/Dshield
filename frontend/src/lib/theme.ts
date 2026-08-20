/**
 * Semantic theme tokens for DShield.
 *
 * All tokens are defined in `@theme inline { … }` in `globals.css` and
 * available as first-class Tailwind utility classes.  Use these semantic
 * class names instead of hardcoded zinc-* / brand-* utilities so that
 * (a) theming is consistent across every component and (b) a future light
 * theme can be added by overriding the custom-property values in a
 * `:root[data-theme="light"]` selector.
 *
 * ── Surface tokens ────────────────────────────────────────────────────
 *   bg-surface-page       Page-level background               (zinc-950)
 *   bg-surface-card       Card / panel / container bg          (zinc-900)
 *   bg-surface-raised     Elevated surfaces (progress, badge)  (zinc-800)
 *   bg-surface-interactive Hover / active surfaces             (zinc-700)
 *
 *   Opacity modifiers work as usual:  bg-surface-card/70  → 70% opacity.
 *
 * ── Ink (foreground) tokens ───────────────────────────────────────────
 *   text-ink-primary      Highest-emphasis text (headings)    (white)
 *   text-ink-secondary    Body / secondary text               (zinc-300)
 *   text-ink-muted        Muted text (descriptions)           (zinc-400)
 *   text-ink-subtle       Subtle text (metadata)              (zinc-500)
 *   text-ink-faint        Faint text (placeholders)           (zinc-600)
 *
 * ── Edge (border) tokens ──────────────────────────────────────────────
 *   border-edge-default   Default hairline / card border      (zinc-800)
 *   border-edge-strong    Stronger border (hover, dashes)     (zinc-700)
 *
 * ── Brand tokens (existing) ───────────────────────────────────────────
 *   bg-brand-* / text-brand-* / border-brand-*   Indigo accent ramp
 *   bg-accent-400 / text-accent-400              Cyan accent
 *
 * ── Example ───────────────────────────────────────────────────────────
 *   // Before (hardcoded zinc-*)
 *   <div className="bg-zinc-900/70 border-zinc-800 text-zinc-200" />
 *
 *   // After (semantic tokens)
 *   <div className="bg-surface-card/70 border-edge-default text-ink-primary" />
 */
export const THEME = {
  /** Semantic surface class names (for reference / advanced usage). */
  surface: {
    page: "bg-surface-page",
    card: "bg-surface-card",
    raised: "bg-surface-raised",
    interactive: "bg-surface-interactive",
  } as const,

  /** Semantic ink (foreground) class names. */
  ink: {
    primary: "text-ink-primary",
    secondary: "text-ink-secondary",
    muted: "text-ink-muted",
    subtle: "text-ink-subtle",
    faint: "text-ink-faint",
  } as const,

  /** Semantic edge (border) class names. */
  edge: {
    default: "border-edge-default",
    strong: "border-edge-strong",
  } as const,
} as const;

export type SurfaceToken = keyof typeof THEME.surface;
export type InkToken = keyof typeof THEME.ink;
export type EdgeToken = keyof typeof THEME.edge;