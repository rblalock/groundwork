"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BookA, CreditCard, Gauge, Mail, Palette, SlidersHorizontal, type LucideIcon } from "lucide-react";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { cn } from "@/ui/lib/utils";
import { ViewingNotice } from "./kit";
import { ActiveTabInView } from "./active-tab-in-view";

export type SettingsTab = "general" | "payments" | "branding" | "glossary" | "email" | "usage";

const TABS: Array<{ key: SettingsTab; href: string; icon: LucideIcon }> = [
  { key: "general", href: "/settings", icon: SlidersHorizontal },
  { key: "payments", href: "/settings/payments", icon: CreditCard },
  { key: "branding", href: "/settings/branding", icon: Palette },
  { key: "glossary", href: "/settings/glossary", icon: BookA },
  { key: "email", href: "/settings/email", icon: Mail },
  { key: "usage", href: "/settings/usage", icon: Gauge },
];

/** Settings' sections, one page each, as a row of tabs under the title. Lives in Settings' layout, so it stays put between them. */
export function SettingsTabs({ language }: { language: Language }) {
  const copy = pageCopyFor(language).settings;
  const pathname = usePathname();
  const active = TABS.find((tab) => tab.href === pathname)?.key ?? "general";
  return (
    <nav aria-label={copy.title} className="-mx-1 flex gap-5 overflow-x-auto overflow-y-hidden border-b border-line px-1 [scrollbar-width:none]">
      {TABS.map(({ key, href, icon: Icon }) => (
        <Link
          aria-current={active === key ? "page" : undefined}
          className={cn(
            "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 pb-2.5 text-[13px] transition-colors",
            active === key ? "border-ink font-medium text-ink" : "border-transparent text-ink-2 hover:text-ink",
          )}
          href={href}
          key={key}
          prefetch
        >
          <Icon aria-hidden="true" className="size-3.5" />
          {copy.tabs[key]}
        </Link>
      ))}
      <ActiveTabInView />
    </nav>
  );
}

/** One Settings section, under the layout's title and tabs. `viewing` is someone who can look but not change anything here. */
export function SettingsPage({ language, viewing, children }: { language: Language; viewing: boolean; children: ReactNode }) {
  return (
    <>
      {viewing ? <ViewingNotice language={language} /> : null}
      {children}
    </>
  );
}

/** A section loading, under the tabs that stay. */
export function SettingsSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4" role="status">
      <span className="sr-only">Loading…</span>
      {[0, 1].map((card) => (
        <div className="space-y-4 rounded-card bg-surface p-5 shadow-card" key={card}>
          <span className="block h-3.5 w-32 animate-pulse rounded bg-hover-2" />
          {[0, 1, 2].map((row) => (
            <span className="block h-8 w-full animate-pulse rounded-[8px] bg-hover-2" key={row} />
          ))}
        </div>
      ))}
    </div>
  );
}
