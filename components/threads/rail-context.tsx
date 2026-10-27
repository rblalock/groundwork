"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Language } from "@/core/language";
import type { ThreadTopic } from "@/core/jobs";
import type { OnScreenRecord } from "@/lib/on-screen";
import type { ThreadJson } from "@/lib/pages/jobs";

// The threads a member has open beside the page: a docked panel with a tab per thread (thread-rail.tsx),
// opened from the sidebar, a thread link in the assistant's replies, or "Ask the assistant" on a quote or
// customer. Which tabs are open is kept in this browser, per business, so it survives a reload.

export type StartThread = { topic?: ThreadTopic; quoteId?: string; customerId?: string; invoiceId?: string; reuse?: boolean };
type Tab = { id: string; title: string };
type Saved = { tabs: Tab[]; active: string | null; open: boolean };

export type ThreadRail = {
  /** The member's language, for the panel's controls outside it (its toggle in a page's title bar). */
  language: Language;
  tabs: Tab[];
  active: string | null;
  open: boolean;
  /** The member's open threads (not email ones), most recent first, for the sidebar. */
  recents: ThreadJson[];
  /** How many of their email threads have news they haven't opened. */
  emailUnread: number;
  starting: boolean;
  /** Why the last start failed: "text_first" before their first text, "failed" otherwise. */
  startError: "text_first" | "failed" | null;
  openThread: (id: string, title?: string) => void;
  startThread: (input: StartThread) => Promise<void>;
  closeTab: (id: string) => void;
  retitle: (id: string, title: string) => void;
  show: () => void;
  hide: () => void;
  refresh: () => void;
  /** The record the page beside the panel shows (a quote, invoice, or customer), which messages carry along. */
  onScreen: OnScreenRecord | null;
  setOnScreen: (record: OnScreenRecord | null) => void;
};

const RailContext = createContext<ThreadRail | null>(null);

/**
 * Pages with a chat of their own, where the thread panel would be a second one beside it: the customer
 * page designer. The panel steps aside there and comes back as it was on the next page.
 */
export const withoutRail = (pathname: string) => pathname.startsWith("/customer-pages/");
const EMPTY: Saved = { tabs: [], active: null, open: false };
const MAX_TABS = 8;

/** The member's thread panel, or null outside it (a super admin looking in has none). */
export function useThreadRail(): ThreadRail | null {
  return useContext(RailContext);
}

function load(key: string): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null") as Saved | null;
    if (saved && Array.isArray(saved.tabs)) {
      const tabs = saved.tabs.filter((tab) => typeof tab?.id === "string" && typeof tab?.title === "string").slice(0, MAX_TABS);
      const active = tabs.some((tab) => tab.id === saved.active) ? saved.active : (tabs[0]?.id ?? null);
      return { tabs, active, open: Boolean(saved.open) && tabs.length > 0 };
    }
  } catch {
    // A bad or blocked store starts empty.
  }
  return { tabs: [], active: null, open: false };
}

export function ThreadRailProvider({ storageKey, language, children }: { storageKey: string | null; language: Language; children: ReactNode }) {
  // Null until this browser's saved tabs are read, so nothing is saved over them before then.
  const [saved, setSaved] = useState<Saved | null>(null);
  const state = saved ?? EMPTY;
  const setState = useCallback((next: (current: Saved) => Saved) => setSaved((current) => next(current ?? EMPTY)), []);
  const [recents, setRecents] = useState<ThreadJson[]>([]);
  const [emailUnread, setEmailUnread] = useState(0);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ThreadRail["startError"]>(null);
  const [onScreen, setOnScreen] = useState<OnScreenRecord | null>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (storageKey) setSaved(load(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || !saved) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(saved));
    } catch {
      // Not kept; the panel still works for this visit.
    }
  }, [saved, storageKey]);

  const refresh = useCallback(() => {
    if (!storageKey) return;
    void fetch("/api/jobs", { cache: "no-store" })
      .then((response) => (response.ok ? (response.json() as Promise<{ threads: ThreadJson[]; emailUnread: number }>) : null))
      .then((body) => {
        if (!body) return;
        setRecents(body.threads);
        setEmailUnread(body.emailUnread);
      })
      .catch(() => undefined);
  }, [storageKey]);

  // The sidebar's list follows what happens elsewhere: a page that changed a thread, a tab come back to.
  useEffect(() => refresh(), [refresh, pathname]);
  useEffect(() => {
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const openThread = useCallback((id: string, title?: string) => {
    setStartError(null);
    setState((current) => {
      const known = current.tabs.find((tab) => tab.id === id);
      const tabs = known
        ? current.tabs.map((tab) => (tab.id === id && title ? { ...tab, title } : tab))
        : [{ id, title: title ?? "" }, ...current.tabs].slice(0, MAX_TABS);
      return { tabs, active: id, open: true };
    });
  }, [setState]);

  const startThread = useCallback(
    async (input: StartThread) => {
      setStarting(true);
      setStartError(null);
      setState((current) => ({ ...current, open: true }));
      try {
        const response = await fetch("/api/jobs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { code?: string } | null;
          setStartError(body?.code === "NO_THREAD" ? "text_first" : "failed");
          return;
        }
        const { thread } = (await response.json()) as { thread: ThreadJson };
        openThread(thread.id, thread.title);
        refresh();
      } catch {
        setStartError("failed");
      } finally {
        setStarting(false);
      }
    },
    [openThread, refresh, setState],
  );

  const closeTab = useCallback((id: string) => {
    setState((current) => {
      const index = current.tabs.findIndex((tab) => tab.id === id);
      const tabs = current.tabs.filter((tab) => tab.id !== id);
      const active = current.active === id ? (tabs[Math.max(0, index - 1)]?.id ?? null) : current.active;
      return { tabs, active, open: current.open && tabs.length > 0 };
    });
  }, [setState]);

  const retitle = useCallback((id: string, title: string) => {
    setState((current) =>
      current.tabs.some((tab) => tab.id === id && tab.title !== title)
        ? { ...current, tabs: current.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab)) }
        : current,
    );
  }, [setState]);

  const show = useCallback(() => setState((current) => ({ ...current, open: current.tabs.length > 0 })), [setState]);
  const hide = useCallback(() => {
    setStartError(null);
    setState((current) => ({ ...current, open: false }));
  }, [setState]);

  const value = useMemo<ThreadRail>(
    () => ({ ...state, language, recents, emailUnread, starting, startError, openThread, startThread, closeTab, retitle, show, hide, refresh, onScreen, setOnScreen }),
    [state, language, recents, emailUnread, starting, startError, openThread, startThread, closeTab, retitle, show, hide, refresh, onScreen],
  );
  if (!storageKey) return <>{children}</>;
  return <RailContext.Provider value={value}>{children}</RailContext.Provider>;
}
