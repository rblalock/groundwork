import type { ReactNode } from "react";
import { HeaderSlot, HeaderSlotProvider } from "@/components/header-slot";
import { ShellAccountButton, ShellMenuButton } from "@/components/shell-chrome";
import { RailToggleButton } from "@/components/threads/rail-toggle";
import { cn } from "@/ui/lib/utils";

/**
 * The content surface: a rounded "paper" panel inset on the canvas beside the sidebar. On a phone it
 * runs edge to edge under the status bar; on a tablet it sits inset on the canvas without the sidebar.
 */
export function Paper({ className, children }: { className?: string; children?: ReactNode }) {
  return (
    <section
      className={cn(
        "@container/paper flex min-h-0 min-w-0 flex-col overflow-hidden bg-page md:rounded-[14px] md:border md:border-line",
        className,
      )}
    >
      <HeaderSlotProvider>{children}</HeaderSlotProvider>
    </section>
  );
}

/**
 * A page's title bar. Below `lg` it is also the app's top bar: the menu button, the title, and the
 * account, with the page's actions on a row of their own beneath (see `.paper-title` in globals.css).
 * At its end: what the page's chat puts there (its language toggle) and the thread panel's toggle.
 */
export function PaperTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="paper-title shrink-0 border-b border-line" data-actions={actions ? "" : undefined}>
      <ShellMenuButton />
      <h1 className="min-w-0 truncate text-[15px] font-semibold text-ink [grid-area:title] lg:text-[13px]">{children}</h1>
      {actions ? <div className="paper-title-actions flex min-w-0 items-center gap-2 overflow-x-auto [grid-area:actions] [scrollbar-width:none]">{actions}</div> : null}
      <HeaderSlot className="[grid-area:slot]" />
      <RailToggleButton className="[grid-area:rail]" />
      <ShellAccountButton />
    </div>
  );
}

/** A page: its title bar and a scrolling body. */
export function PaperPage({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <Paper className="flex-1">
      <PaperTitle actions={actions}>{title}</PaperTitle>
      <div className="paper-body @container min-h-0 flex-1 overflow-y-auto px-4 pt-5 sm:px-10 sm:pt-8">{children}</div>
    </Paper>
  );
}

/** What a page shows before it has anything of its own. */
export function EmptyState({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col items-center gap-3 text-center">
      {icon ? (
        <span className="flex size-10 items-center justify-center rounded-[10px] bg-inset text-ink-2 shadow-hairline">{icon}</span>
      ) : null}
      <p className="text-sm text-ink-2 text-pretty">{children}</p>
    </div>
  );
}
