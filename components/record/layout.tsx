import type { ReactNode } from "react";
import { cn } from "@/ui/lib/utils";

/**
 * A record page's body: the main sections, and a rail of the facts you look up (who it's for, its invoice,
 * its link). Side by side on a wide page; on a narrow one the rail comes first, as a compact block of
 * facts, so they aren't at the bottom of a long page. With no facts, just the sections.
 */
export function RecordColumns({ main, rail }: { main: ReactNode; rail?: ReactNode }) {
  if (!rail) return <div className="min-w-0 space-y-6">{main}</div>;
  return (
    <div className="grid items-start gap-6 @3xl:grid-cols-[minmax(0,1fr)_15rem]">
      <aside className="min-w-0 rounded-card bg-surface p-4 shadow-card @3xl:sticky @3xl:top-14 @3xl:order-2 @3xl:bg-transparent @3xl:p-0 @3xl:shadow-none">
        <div className="grid gap-x-6 gap-y-4 @md:grid-cols-2 @3xl:grid-cols-1">{rail}</div>
      </aside>
      <div className="min-w-0 space-y-6 @3xl:order-1">{main}</div>
    </div>
  );
}

/** One fact in the rail: a small label over its value. */
export function RailFact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 space-y-1", className)}>
      <p className="text-[12px] text-ink-3">{label}</p>
      <div className="text-[13px] text-ink">{children}</div>
    </div>
  );
}

/** A section the jump bar can land on. */
export function RecordSection({ id, children }: { id: string; children: ReactNode }) {
  return (
    <section className="scroll-mt-14" id={id}>
      {children}
    </section>
  );
}

/** Empty sections, folded into one quiet line with what can be added. */
export function EmptyFold({ children, actions }: { children: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-dashed border-line-strong px-4 py-2.5 text-[13px] text-ink-3">
      <span>{children}</span>
      {actions}
    </div>
  );
}
