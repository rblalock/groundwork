"use client";

import { Building2, CalendarDays, X, FileText, Layers, Mail, MessageSquare, MessageSquareText, NotebookText, Plus, ReceiptText, Settings, Tags, Users, UsersRound } from "lucide-react";
import { Dialog as DrawerPrimitive } from "@base-ui/react/dialog";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import SidebarNav, { type SidebarSection } from "@/ui/beautiful/primitives/SidebarNav";
import { AccountMenu, BusinessMark, type BusinessOption } from "@/components/account-menu";
import { ShellChromeProvider, type ShellChrome } from "@/components/shell-chrome";
import { ThreadRailProvider, useThreadRail } from "@/components/threads/rail-context";
import { ThreadRailPanel } from "@/components/threads/thread-rail";
import { copyFor } from "@/lib/copy";
import type { Language } from "@/core/language";
import type { Role } from "@/core/members";

export type ShellProps = {
  user: { name: string; email: string; superAdmin: boolean };
  /**
   * The open business; null for a super admin who hasn't opened one. `logoVersion` is null without a logo.
   * `member` is false for a super admin looking in, who has no threads.
   */
  business: { id: string; name: string; role: Role; logoVersion: string | null; member: boolean } | null;
  businesses: BusinessOption[];
  language: Language;
  children: ReactNode;
};

type NavItem = { id: string; href: string; label: string; icon: ReactNode; badge?: string };

/** Where each nav item goes; "" is the assistant, the home page. Threads open in the panel instead. */
function hrefFor(id: string) {
  return id === "assistant" ? "/" : id === "jobs" ? "/threads" : `/${id}`;
}

const RECENT_IN_SIDEBAR = 5;

/**
 * The app's layout: the sidebar sits on the canvas and pages live on a rounded paper panel beside it.
 * Below `lg` the sidebar becomes a drawer that slides over from the left, opened from the menu button in
 * each page's title bar, which also carries the account (components/shell-chrome.tsx).
 * The sidebar runs in groups: the assistant and the member's threads, then the work (schedule, quotes,
 * customers, invoices), then the business's setup (price book, notes, team, settings), then admin.
 * Crew see the work, customers, schedule, and notes; owners and admins also see invoices and payments, prices, the
 * team, and settings; super admins also see every business. The pages check the same roles on the server.
 * Threads open in a panel beside the page (components/threads/thread-rail.tsx).
 */
export function AppShell(props: ShellProps) {
  const { business, user } = props;
  const storageKey = business?.member ? `gw:threads:${business.id}:${user.email}` : null;
  return (
    <ThreadRailProvider language={props.language} storageKey={storageKey}>
      <Shell {...props} />
    </ThreadRailProvider>
  );
}

function Shell({ user, business, businesses, language, children }: ShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const emailList = pathname === "/threads" && searchParams.get("source") === "email";
  const copy = copyFor(language);
  const privileged = business?.role === "owner" || business?.role === "admin";
  const rail = useThreadRail();

  const item = (id: string, label: string, icon: ReactNode): NavItem => ({ id, href: hrefFor(id), label, icon });
  const assistant: NavItem[] = business
    ? [
        item("assistant", copy.nav.assistant, <MessageSquareText size={18} />),
        ...(rail ? [item("new-thread", copy.nav.newThread, <Plus size={18} />)] : []),
      ]
    : [];
  // The member's latest open threads, then the list of all of them.
  const threads: NavItem[] = business
    ? [
        ...(rail?.recents ?? []).slice(0, RECENT_IN_SIDEBAR).map((thread) => ({
          id: `thread:${thread.id}`,
          href: `/threads/${thread.id}`,
          label: thread.title || copy.nav.newThread,
          icon: <MessageSquare size={16} />,
        })),
        // Email threads have their own list, with how many have news, so they don't crowd the rest.
        ...(rail
          ? [
              {
                id: "email",
                href: "/threads?source=email",
                label: copy.nav.email,
                icon: <Mail size={18} />,
                badge: rail.emailUnread > 0 ? String(rail.emailUnread) : undefined,
              },
            ]
          : []),
        item("jobs", copy.nav.allThreads, <Layers size={18} />),
      ]
    : [];
  const work: NavItem[] = business
    ? [
        item("schedule", copy.nav.schedule, <CalendarDays size={18} />),
        item("quotes", copy.nav.quotes, <FileText size={18} />),
        item("customers", copy.nav.customers, <Users size={18} />),
        ...(privileged ? [item("invoices", copy.nav.invoices, <ReceiptText size={18} />)] : []),
      ]
    : [];
  const setup: NavItem[] = business
    ? [
        ...(privileged ? [item("price-book", copy.nav.pricebook, <Tags size={18} />)] : []),
        item("notes", copy.nav.notes, <NotebookText size={18} />),
        ...(privileged
          ? [item("team", copy.nav.team, <UsersRound size={18} />), item("settings", copy.nav.settings, <Settings size={18} />)]
          : []),
      ]
    : [];
  const admin: NavItem[] = user.superAdmin ? [item("admin", copy.nav.admin, <Building2 size={18} />)] : [];

  const groups: Array<{ key: string; items: NavItem[]; label?: string }> = [
    { key: "assistant", items: assistant },
    { key: "threads", items: threads, label: copy.nav.jobs },
    { key: "work", items: work, label: copy.nav.sections.work },
    { key: "business", items: setup, label: copy.nav.sections.business },
    { key: "admin", items: admin, label: copy.nav.sections.admin },
  ].filter((group) => group.items.length > 0);
  const sections: SidebarSection[] = groups.map(({ key, items, label }) => ({
    key,
    label,
    items: items.map(({ id, label, icon, badge }) => ({ id, label, icon, badge })),
  }));

  const all = groups.flatMap((group) => group.items.map((i) => ({ ...i, section: group.key })));
  // A thread is selected while it's the panel's open tab; a page by its path.
  const openThread = rail?.open && rail.active ? `thread:${rail.active}` : null;
  const active =
    all.find((i) => i.id === openThread) ??
    (emailList ? all.find((i) => i.id === "email") : undefined) ??
    all
      .filter((i) => !i.id.startsWith("thread:") && i.id !== "new-thread" && i.id !== "email")
      .filter((i) => (i.href === "/" ? pathname === "/" : pathname === i.href || pathname.startsWith(`${i.href}/`)))
      .at(0);

  // The sidebar's pages, fetched ahead once the browser is idle, so a click shows its page (or its
  // loading shape) without waiting on the server first.
  const pageHrefs = all.filter((i) => !i.id.startsWith("thread:") && i.id !== "new-thread").map((i) => i.href).join("\n");
  useEffect(() => {
    const hrefs = pageHrefs.split("\n").filter(Boolean);
    const prefetch = () => hrefs.forEach((href) => router.prefetch(href));
    if (typeof window.requestIdleCallback !== "function") {
      const timer = setTimeout(prefetch, 1500);
      return () => clearTimeout(timer);
    }
    const idle = window.requestIdleCallback(prefetch, { timeout: 3000 });
    return () => window.cancelIdleCallback(idle);
  }, [pageHrefs, router]);

  const [navOpen, setNavOpen] = useState(false);
  // A pick in the drawer navigates; the drawer closes once the new page is in.
  useEffect(() => setNavOpen(false), [pathname]);

  const account = {
    activeBusinessId: business?.id ?? null,
    businesses,
    copy: copy.menu,
    hasAccountPage: business !== null,
    name: user.name,
    subtitle: business?.name ?? user.email,
    superAdmin: user.superAdmin,
  };
  const chrome: ShellChrome = { openNav: () => setNavOpen(true), navOpen, menuLabel: copy.menu.openNav, account };

  const sidebar = (footer: ReactNode) => (
    <SidebarNav
      activeItem={active ? `${active.section}:${active.id}` : undefined}
      activeNav=""
      fill
      footer={footer}
      navItems={[]}
      newChat={false}
      onPickItem={(_section, id) => {
        if (rail && id === "new-thread") {
          setNavOpen(false);
          void rail.startThread({ topic: "new" });
          return;
        }
        const picked = all.find((i) => i.id === id);
        if (rail && id.startsWith("thread:") && picked) {
          setNavOpen(false);
          rail.openThread(id.slice("thread:".length), picked.label);
          return;
        }
        const href = picked?.href ?? hrefFor(id);
        if (href === pathname) setNavOpen(false);
        router.push(href);
      }}
      sections={sections}
      workspace={{
        name: business?.name ?? "Admin",
        logo: (
          <BusinessMark
            logoSrc={business?.logoVersion ? `/api/branding/logo?v=${business.logoVersion}` : null}
            name={business?.name ?? "Admin"}
          />
        ),
      }}
      workspaceItems={[]}
    />
  );

  return (
    <ShellChromeProvider value={chrome}>
      <div className="flex h-dvh overflow-hidden bg-canvas md:p-2.5 lg:pl-0">
        <div className="hidden h-full shrink-0 flex-col pt-0.5 lg:flex">{sidebar(<AccountMenu {...account} />)}</div>
        <main className="flex min-h-0 min-w-0 flex-1 gap-2.5">
          {children}
          <ThreadRailPanel language={language} />
        </main>
      </div>

      {/* Phone and tablet: the same navigation in a drawer. The account stays in the top bar. */}
      <DrawerPrimitive.Root onOpenChange={setNavOpen} open={navOpen}>
        <DrawerPrimitive.Portal>
          <DrawerPrimitive.Backdrop className="fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 lg:hidden" />
          <DrawerPrimitive.Popup
            aria-label={copy.menu.nav}
            className="shell-drawer fixed inset-y-0 left-0 z-50 flex w-[272px] max-w-[85vw] flex-col bg-canvas shadow-overlay outline-none transition-transform duration-[260ms] ease-[cubic-bezier(0.16,1,0.3,1)] data-ending-style:-translate-x-full data-starting-style:-translate-x-full motion-reduce:transition-none lg:hidden"
          >
            <DrawerPrimitive.Title className="sr-only">{copy.menu.nav}</DrawerPrimitive.Title>
            {sidebar(null)}
            <DrawerPrimitive.Close
              aria-label={copy.menu.closeNav}
              className="absolute top-[max(10px,env(safe-area-inset-top))] right-2 flex size-10 items-center justify-center rounded-[10px] text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink"
            >
              <X aria-hidden="true" className="size-[18px]" />
            </DrawerPrimitive.Close>
          </DrawerPrimitive.Popup>
        </DrawerPrimitive.Portal>
      </DrawerPrimitive.Root>
    </ShellChromeProvider>
  );
}
