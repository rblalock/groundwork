import Link from "next/link";
import { cn } from "@/ui/lib/utils";
import { ActiveTabInView } from "../pages/active-tab-in-view";

export type RecordTab = { key: string; label: string; href: string; count?: number };

/**
 * A record's lists as a row of tabs (a customer's quotes, work, invoices…), each a link that keeps its
 * tab in the address. Tabs with nothing in them are dimmed but still open.
 */
export function RecordTabs({ tabs, active, label }: { tabs: RecordTab[]; active: string; label: string }) {
  return (
    <nav aria-label={label} className="-mx-1 flex gap-5 overflow-x-auto overflow-y-hidden border-b border-line px-1 [scrollbar-width:none]">
      {tabs.map((tab) => (
        <Link
          aria-current={active === tab.key ? "page" : undefined}
          className={cn(
            "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 text-[13px] transition-colors",
            active === tab.key
              ? "border-ink font-medium text-ink"
              : tab.count === 0
                ? "border-transparent text-ink-3 hover:text-ink-2"
                : "border-transparent text-ink-2 hover:text-ink",
          )}
          href={tab.href}
          key={tab.key}
          scroll={false}
        >
          {tab.label}
          {tab.count ? <span className="text-[11px] text-ink-3 tabular-nums">{tab.count}</span> : null}
        </Link>
      ))}
      <ActiveTabInView />
    </nav>
  );
}
