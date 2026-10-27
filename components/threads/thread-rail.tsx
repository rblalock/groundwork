"use client";

import { Check, CircleAlert, Expand, Link2, MessageSquarePlus, PanelRightClose, Plus, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Language } from "@/core/language";
import { AssistantChat } from "@/components/assistant/assistant-chat";
import { HeaderSlot, HeaderSlotProvider } from "@/components/header-slot";
import { LoadingState } from "@/components/spinner";
import { copyFor } from "@/lib/copy";
import type { ThreadJson } from "@/lib/pages/jobs";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";
import { cn } from "@/ui/lib/utils";
import { useThreadRail, withoutRail, type StartThread } from "./rail-context";

// The thread panel: docked beside the page on a wide screen, over it on a phone. A tab per open thread,
// a new one, open it full screen, or put the panel away. Each tab is one thread's chat
// (`AssistantChat variant="job"`), the same conversation as its own page at /threads/[id].

const iconButton =
  "flex size-7 shrink-0 items-center justify-center rounded-[7px] text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-50";

export function ThreadRailPanel({ language }: { language: Language }) {
  const rail = useThreadRail();
  const pathname = usePathname();
  if (!rail) return null;
  const copy = copyFor(language).rail;
  // A thread's own page already shows it full size.
  const onOwnPage = rail.active !== null && pathname === `/threads/${rail.active}`;
  if (onOwnPage || withoutRail(pathname)) return null;

  // Put away, it comes back from the toggle in the page's title bar (rail-toggle.tsx).
  if (!rail.open) return null;

  return (
    <HeaderSlotProvider>
    <aside
      aria-label={copy.label}
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-page pt-[env(safe-area-inset-top)] lg:relative lg:inset-auto lg:z-auto lg:w-[420px] lg:shrink-0 lg:rounded-[14px] lg:border lg:border-line lg:pt-0"
    >
      <div className="flex h-11 shrink-0 items-center border-b border-line pl-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist">
          {rail.tabs.map((tab) => {
            const active = tab.id === rail.active;
            const title = tab.title || copy.newThread;
            return (
              <div
                className={cn(
                  "group/tab flex h-7 w-32 shrink-0 items-center gap-0.5 rounded-[7px] pr-0.5 pl-2.5 text-[12px] font-medium transition-colors",
                  active ? "bg-hover-2 text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
                )}
                key={tab.id}
              >
                <button
                  aria-selected={active}
                  className="min-w-0 flex-1 text-left"
                  onClick={() => rail.openThread(tab.id)}
                  role="tab"
                  title={title}
                  type="button"
                >
                  <span className="block truncate">{title}</span>
                </button>
                <button aria-label={copy.close(title)} className="flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover-2 hover:text-ink" onClick={() => rail.closeTab(tab.id)} type="button">
                  <X aria-hidden="true" size={11} strokeWidth={2.4} />
                </button>
              </div>
            );
          })}
          <button aria-label={copy.newThread} className={iconButton} disabled={rail.starting} onClick={() => void rail.startThread({ topic: "new" })} title={copy.newThread} type="button">
            <Plus aria-hidden="true" size={15} />
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 border-l border-line px-2">
          {rail.active ? <CopyLinkButton id={rail.active} label={copy.copyLink} /> : null}
          {rail.active ? (
            <Link aria-label={copy.expand} className={iconButton} href={`/threads/${rail.active}`} title={copy.expand}>
              <Expand aria-hidden="true" size={14} />
            </Link>
          ) : null}
          <button aria-label={copy.hide} className={iconButton} onClick={rail.hide} title={copy.hide} type="button">
            <PanelRightClose aria-hidden="true" className="hidden lg:block" size={15} />
            <X aria-hidden="true" className="lg:hidden" size={16} />
          </button>
        </div>
      </div>
      {rail.starting ? (
        <LoadingState className="justify-center pt-16 text-ink-3" label={copy.starting} />
      ) : rail.startError ? (
        <RailNotice>{rail.startError === "text_first" ? copy.textFirst : copy.startFailed}</RailNotice>
      ) : rail.active ? (
        <ThreadPane id={rail.active} key={rail.active} language={language} />
      ) : null}
    </aside>
    </HeaderSlotProvider>
  );
}

/** Copies the thread's own address (`/threads/<id>`), to open it again or send it to someone who may. */
function CopyLinkButton({ id, label }: { id: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      aria-label={label}
      className={iconButton}
      onClick={() => void navigator.clipboard?.writeText(`${window.location.origin}/threads/${id}`).then(() => setCopied(true), () => undefined)}
      title={label}
      type="button"
    >
      {copied ? <Check aria-hidden="true" size={14} /> : <Link2 aria-hidden="true" size={14} />}
    </button>
  );
}

function RailNotice({ children }: { children: string }) {
  return (
    <p className="mx-4 mt-6 flex items-start gap-2 rounded-[10px] bg-inset px-3 py-2.5 text-[13px] text-ink-2 text-pretty" role="alert">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-3" />
      {children}
    </p>
  );
}

// What each thread was when last loaded, so switching back to its tab shows it at once while it reloads.
const knownThreads = new Map<string, ThreadJson>();

/** One tab: the thread's quote and customer, then its chat. */
function ThreadPane({ id, language }: { id: string; language: Language }) {
  const rail = useThreadRail();
  const [thread, setThread] = useState<ThreadJson | null>(() => knownThreads.get(id) ?? rail?.recents.find((t) => t.id === id) ?? null);
  const [failed, setFailed] = useState<"gone" | "error" | null>(null);
  const all = copyFor(language);
  const jobsCopy = pageCopyFor(language).jobs;
  const retitle = rail?.retitle;
  const refreshRecents = rail?.refresh;
  const emailUnread = useRef(false);
  const unreadNow = (rail?.emailUnread ?? 0) > 0;
  useEffect(() => {
    emailUnread.current = unreadNow;
  }, [unreadNow]);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
      if (response.status === 404) return setFailed("gone");
      if (!response.ok) return setFailed("error");
      const body = (await response.json()) as { thread: ThreadJson };
      setFailed(null);
      knownThreads.set(id, body.thread);
      setThread(body.thread);
      retitle?.(id, body.thread.title);
      // Opening it reads it: the sidebar's email count catches up.
      if (emailUnread.current) refreshRecents?.();
    } catch {
      setFailed("error");
    }
  }, [id, retitle, refreshRecents]);

  useEffect(() => {
    void load();
  }, [load]);

  // A turn may have made or changed what the page beside it shows (a quote, a customer): catch both up.
  const onTurnEnd = useCallback(() => {
    void load();
    refreshRecents?.();
    router.refresh();
  }, [load, refreshRecents, router]);

  if (failed === "gone") return <RailNotice>{all.rail.gone}</RailNotice>;
  if (failed === "error") {
    return (
      <div className="flex flex-col items-center gap-3 pt-16 text-center" role="alert">
        <p className="text-sm text-ink-2">{all.job.error}</p>
        <Button onClick={() => void load()} size="sm" type="button" variant="secondary">
          {all.assistant.retry}
        </Button>
      </div>
    );
  }
  if (!thread) return <LoadingState className="justify-center pt-16 text-ink-3" label={all.job.loading} />;
  if (!thread.sessionId) return <RailNotice>{jobsCopy.noSession}</RailNotice>;

  const readOnlyNote = !thread.mine ? all.job.readOnly(thread.memberName) : thread.status === "archived" ? all.job.archived : undefined;
  // The record on the page beside the panel goes along with messages, unless it's what the thread is about.
  const onScreen = rail?.onScreen ?? null;
  const subject =
    onScreen !== null &&
    ((onScreen.kind === "quote" && thread.quote?.id === onScreen.id) ||
      (onScreen.kind === "customer" && thread.customer?.id === onScreen.id && !thread.quote) ||
      (onScreen.kind === "invoice" && thread.title === onScreen.label));
  const emptyBody =
    thread.topic === "quote" ? all.job.emptyQuote : thread.topic === "customer" ? all.job.emptyCustomer : thread.topic === "pricebook" ? all.job.emptyPricebook : thread.topic === "billing" ? all.job.emptyBilling : undefined;
  return (
    <>
      {/* What it's about, and the chat's language toggle (the tab bar has no room for it). Hidden with neither. */}
      <div
        className="rail-about flex shrink-0 items-center gap-3 border-b border-line px-4 py-1.5 text-[12px] text-ink-2"
        data-about={thread.quote || thread.customer ? "" : undefined}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {thread.quote ? (
            <Link className="min-w-0 truncate hover:text-ink" href={`/quotes/${thread.quote.id}`}>
              {jobsCopy.quote(thread.quote.title)}
            </Link>
          ) : null}
          {thread.customer ? (
            <Link className="min-w-0 truncate hover:text-ink" href={`/customers/${thread.customer.id}`}>
              {jobsCopy.customer(thread.customer.name)}
            </Link>
          ) : null}
        </div>
        <HeaderSlot className="shrink-0" />
      </div>
      <AssistantChat
        compact
        conversationId={thread.id}
        emptyBody={emptyBody}
        key={thread.sessionId}
        language={language}
        onScreen={subject ? null : onScreen}
        onTurnEnd={onTurnEnd}
        readOnlyNote={readOnlyNote}
        sessionId={thread.sessionId}
        variant="job"
      />
    </>
  );
}

/**
 * "Ask the assistant" on a page: starts a thread there (or reopens the member's open one about the same
 * quote or customer) in the panel beside it. Nothing for a super admin looking in.
 */
export function AskAssistantButton({
  start,
  label,
  icon = "ask",
  variant = "secondary",
}: {
  start: StartThread;
  label: string;
  icon?: "ask" | "new";
  variant?: "primary" | "secondary";
}) {
  const rail = useThreadRail();
  if (!rail) return null;
  const Icon = icon === "new" ? Plus : MessageSquarePlus;
  return (
    <Button disabled={rail.starting} onClick={() => void rail.startThread(start)} size="sm" title={label} type="button" variant={variant}>
      <Icon aria-hidden="true" className="size-3.5" />
      {/* On a narrow page (beside the thread panel, say), "Ask the assistant" keeps just its icon. */}
      <span className={icon === "ask" ? "@max-3xl/paper:sr-only" : undefined}>{label}</span>
    </Button>
  );
}

