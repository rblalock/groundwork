import Link from "next/link";
import type { ReactNode } from "react";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { cn } from "@/ui/lib/utils";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { QuoteStatus } from "@/lib/pages/quotes";

// The pieces the business pages share: the card and table look, status pills, and the
// read-only notice for super admins.

/** The page's content column inside the paper panel. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-5xl space-y-6", className)}>{children}</div>;
}

/** A super admin looking at a business they don't belong to: everything shows, nothing can change. */
export function ViewingNotice({ language }: { language: Language }) {
  return (
    <p className="rounded-[10px] bg-accent-tint px-3 py-2 text-[13px] text-accent-ink" role="note">
      {pageCopyFor(language).common.viewing}
    </p>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  flush,
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** No padding around the body: for tables that run edge to edge. */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cn("min-w-0 overflow-hidden rounded-card bg-surface text-ink shadow-card", className)}>
      {title || actions ? (
        <header className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            {title ? <h2 className="text-[13px] font-medium">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[12px] text-ink-3 text-pretty">{description}</p> : null}
          </div>
          {actions}
        </header>
      ) : null}
      <div className={flush ? undefined : "p-4"}>{children}</div>
    </section>
  );
}

/** A table: hairline rows on a surface card, scrolling sideways on a narrow screen. */
export function Table({ head, children, className }: { head: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0 overflow-x-auto", className)}>
      <table className="w-full text-left text-[13px]">
        <thead className="text-[12px] text-ink-3">
          <tr className="border-b border-line">{head}</tr>
        </thead>
        <tbody className="divide-y divide-line text-ink">{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn("primitive-table-cell font-medium whitespace-nowrap", className)}>{children}</th>;
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn("primitive-table-cell align-top", className)}>{children}</td>;
}

/** A table row that opens `href`: the link in its first cell stretches over the whole row. */
export function LinkRow({ href, label, children }: { href: string; label: ReactNode; children: ReactNode }) {
  return (
    <tr className="relative transition-colors hover:bg-hover">
      <td className="primitive-table-cell align-top">
        <Link className="font-medium text-ink after:absolute after:inset-0 focus-visible:outline-none" href={href}>
          {label}
        </Link>
      </td>
      {children}
    </tr>
  );
}

const STATUS_TONES = {
  draft: "neutral",
  needs_owner: "orange",
  approved: "accent",
  sent: "accent",
  won: "green",
  lost: "red",
  void: "neutral",
} as const;

export function QuoteStatusPill({ status, language }: { status: QuoteStatus; language: Language }) {
  return (
    <StatusPill className="whitespace-nowrap" dot={status !== "void"} tone={STATUS_TONES[status]}>
      {pageCopyFor(language).status[status]}
    </StatusPill>
  );
}

/** A label and its value, stacked, for detail cards. */
export function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="text-[13px] text-ink">{children}</dd>
    </div>
  );
}

/** The quiet line a list or card shows when it has nothing. */
export function Nothing({ children }: { children: ReactNode }) {
  return <p className="px-4 py-8 text-center text-[13px] text-ink-3 text-pretty">{children}</p>;
}

/** A detail page's title: the list it belongs to, then the record. */
export function Crumb({ href, parent, children }: { href: string; parent: string; children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Link className="shrink-0 font-normal text-ink-3 hover:text-ink" href={href}>
        {parent}
      </Link>
      <span aria-hidden="true" className="font-normal text-ink-3">
        /
      </span>
      <span className="truncate">{children}</span>
    </span>
  );
}
