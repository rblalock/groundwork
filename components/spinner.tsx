"use client";

import { Blocks, BouncingDots, Eclipse } from "loading-dev";
import { cn } from "@/ui/lib/utils";

// The app's loading indicators (loading-dev): one per kind of wait.

/** loading: fetching or translating · thinking: the assistant working · saving: writes and uploads */
export type SpinnerVariant = "loading" | "thinking" | "saving";

const INDICATORS = { loading: Eclipse, thinking: BouncingDots, saving: Blocks } as const;

export function Spinner({ size = 14, variant = "loading", className }: { size?: number; variant?: SpinnerVariant; className?: string }) {
  const Indicator = INDICATORS[variant];
  return (
    <span aria-hidden="true" className={cn("inline-flex shrink-0 items-center text-accent", className)}>
      <Indicator color="currentColor" size={size} />
    </span>
  );
}

/** A spinner with what it's waiting on. `announce` false inside a region that already announces itself. */
export function LoadingState({
  label,
  variant = "loading",
  className,
  announce = true,
}: {
  label?: string;
  variant?: SpinnerVariant;
  className?: string;
  announce?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2 text-sm text-ink-2", className)} role={announce ? "status" : undefined}>
      <Spinner variant={variant} />
      {label ? <span>{label}</span> : null}
    </div>
  );
}
