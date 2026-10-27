import Link from "next/link";
import type { ReactNode } from "react";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { cn } from "@/ui/lib/utils";
import type { Language } from "@/core/language";
import type { InvoiceStatus } from "@/core/invoices";
import { pageCopyFor } from "@/lib/page-copy";

// The pieces the invoice pages share: the status pill, the Invoices | Payments tabs, and a stat card.

const TONES = { draft: "neutral", sent: "accent", partially_paid: "orange", paid: "green", void: "neutral", overdue: "red" } as const;

/** An invoice's status; a sent or partly paid one past its due date shows as overdue. */
export function InvoiceStatusPill({ status, overdue, language }: { status: InvoiceStatus; overdue?: boolean; language: Language }) {
  const key = overdue && (status === "sent" || status === "partially_paid") ? "overdue" : status;
  return (
    <StatusPill className="whitespace-nowrap" dot={key !== "void"} tone={TONES[key]}>
      {pageCopyFor(language).invoices.status[key]}
    </StatusPill>
  );
}

/** Invoices and Payments, the two views of the business's money. */
export function MoneyTabs({ active, language }: { active: "invoices" | "payments"; language: Language }) {
  const tabs = pageCopyFor(language).invoices.tabs;
  return (
    <nav aria-label={tabs.invoices} className="flex gap-1">
      {(["invoices", "payments"] as const).map((key) => (
        <Link
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "flex h-7 items-center rounded-full px-3 text-[13px] transition-colors",
            active === key ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-2 hover:bg-hover",
          )}
          href={key === "invoices" ? "/invoices" : "/invoices/payments"}
          key={key}
        >
          {tabs[key]}
        </Link>
      ))}
    </nav>
  );
}

export function Stat({ label, value, help, tone }: { label: string; value: ReactNode; help?: ReactNode; tone?: "red" }) {
  return (
    <div className="min-w-0 rounded-card bg-surface px-4 py-3 shadow-card">
      <p className="text-[12px] text-ink-3">{label}</p>
      <p className={cn("mt-0.5 text-xl font-semibold tabular-nums text-ink", tone === "red" && "text-red")}>{value}</p>
      {help ? <p className="mt-0.5 text-[12px] text-ink-3 text-pretty">{help}</p> : null}
    </div>
  );
}
