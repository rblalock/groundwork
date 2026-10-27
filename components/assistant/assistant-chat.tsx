"use client";

import { ClientError, type EveMessage, type EveMessagePart, type MessageStreamEvent } from "eve/client";
import { useEveAgent } from "eve/react";
import type { AgentName } from "@/core/agent-name";
import { Eye, FileText, Layers, Mail, MessageSquareText, Paperclip, RotateCw, Smartphone, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseForwardedEmailText, type ForwardedEmailParts } from "@/core/forwarded-email";
import { localeFor, type Language } from "@/core/language";
import type { TextedJson } from "@/lib/pages/assistant";
import { interleave, messageTimes } from "@/lib/thread-merge";
import { messageItems, messageTextId, textedItems, textedTextId, textPartsOf } from "@/lib/translatable";
import { toolLabelsFor, type ToolLabel } from "@/core/tool-labels";
import { AgentProgress } from "@/components/assistant/agent-progress";
import { LoadingState } from "@/components/spinner";
import { cachedSession, loadSession, rememberSession, sessionInMemory } from "@/components/assistant/session-cache";
import { LanguageToggle, TranslatedNote, useConversationTranslation, type ConversationTranslation } from "@/components/assistant/translation";
import { copyFor } from "@/lib/copy";
import { useThreadRail } from "@/components/threads/rail-context";
import { asFilePart, ATTACH_ACCEPT, MAX_ATTACHED, MAX_ATTACHED_CHARS, prepareAttachment, storeAttachment, type Attached } from "@/components/assistant/attach";
import { ChatLink, QuoteCard, ToolSteps } from "@/components/assistant/reply-extras";
import { UnderTheHood } from "@/components/assistant/under-the-hood";
import { linkRecords, type RecordLink } from "@/lib/chat-tools";
import { ON_SCREEN_HEADER, onScreenHeader, type OnScreenRecord } from "@/lib/on-screen";
import { replyExtras, type ReplyExtras } from "@/lib/chat-tools";
import { InHeader } from "@/components/header-slot";
import { Button } from "@/ui/beautiful/atoms/Button";
import { useIsMobile } from "@/ui/hooks/use-mobile";
import PromptBar from "@/ui/beautiful/primitives/PromptBar";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/ui/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/ui/components/ai-elements/message";
import { chatRemarkPlugins } from "@/lib/chat-markdown";

// The member's thread is one eve session that their iMessage texts also run in, so resuming it from
// the start replays texts and web turns together. eve's routes are on this origin, so the Better Auth
// cookie goes along and the eve channel checks the session is this member's (lib/eve-auth.ts).

type Part = EveMessage["parts"][number];
type FilePart = Extract<Part, { type: "file" }>;

function MessageFiles({ parts }: { parts: FilePart[] }) {
  if (parts.length === 0) return null;
  return (
    <div className="ml-auto flex flex-wrap justify-end gap-1.5">
      {parts.map((part, index) =>
        part.url && part.mediaType.startsWith("image/") ? (
          <a href={part.url} key={part.url} rel="noreferrer" target="_blank">
            <img
              alt={part.filename ?? ""}
              className="size-20 rounded-[10px] object-cover shadow-hairline"
              src={part.url}
            />
          </a>
        ) : (
          <span
            className="rounded-full bg-inset px-2.5 py-1 text-[12px] text-ink-2 shadow-hairline"
            key={`${part.filename ?? "file"}-${index}`}
          >
            {part.filename ?? part.mediaType}
          </span>
        ),
      )}
    </div>
  );
}

const JOB_TOOLS = new Set(["start_job", "continue_job", "close_job"]);

type JobLink = { key: string; id: string; title: string; href: string; label: string };

/** The jobs a message opened, continued, or closed: the thread's record of its jobs. */
function jobLinksOf(parts: readonly Part[], toolLabels: Record<string, ToolLabel>): JobLink[] {
  return parts.flatMap((part) => {
    if (part.type !== "dynamic-tool" || !JOB_TOOLS.has(part.toolName) || part.state !== "output-available") return [];
    const output = part.output as { jobId?: unknown; title?: unknown } | null;
    if (typeof output?.jobId !== "string") return [];
    const title = typeof output.title === "string" ? output.title : "";
    return [{ key: part.toolCallId, id: output.jobId, title, href: `/threads/${output.jobId}`, label: `${toolLabels[part.toolName]?.done ?? ""}: ${title}` }];
  });
}

/** The threads a message touched. Each opens in the thread panel beside the page, or on its own page without one. */
function JobLinks({ links }: { links: JobLink[] }) {
  const rail = useThreadRail();
  return (
    <div className="flex flex-wrap gap-1.5">
      {links.map((link) => (
        <Link
          className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 text-[12px] text-ink-2 shadow-hairline transition-colors hover:text-ink"
          href={link.href}
          key={link.key}
          onClick={(event) => {
            if (!rail || event.metaKey || event.ctrlKey || event.shiftKey) return;
            event.preventDefault();
            rail.openThread(link.id, link.title);
          }}
        >
          <Layers aria-hidden="true" className="size-3.5" />
          {link.label}
        </Link>
      ))}
    </div>
  );
}

/** One text, as sent or in the conversation's translated view, with a way back to what was sent. */
function MessageText({
  id,
  text,
  streaming,
  translation,
  language,
  links = [],
}: {
  /** Its id in the translated view (lib/translatable.ts). */
  id: string;
  text: string;
  streaming: boolean;
  translation: ConversationTranslation | null;
  language: Language;
  /** Records its reply's tools returned: their first mention links to their page. */
  links?: RecordLink[];
}) {
  const [showingOriginal, setShowingOriginal] = useState(false);
  const translated = streaming ? null : (translation?.translationOf(id) ?? null);
  // Still waiting on its translation: shown as sent, dimmed and pulsing, until the translation lands.
  const waiting = !streaming && !translated && Boolean(translation?.isPending(id));
  return (
    <>
      <div aria-busy={waiting || undefined} className={waiting ? "opacity-60 motion-safe:animate-pulse" : undefined}>
        <MessageResponse components={{ a: ChatLink }} isAnimating={streaming} remarkPlugins={chatRemarkPlugins}>
          {streaming ? text : linkRecords(translated && !showingOriginal ? translated : text, links)}
        </MessageResponse>
      </div>
      {translated ? <TranslatedNote language={language} onToggle={() => setShowingOriginal((v) => !v)} showingOriginal={showingOriginal} /> : null}
    </>
  );
}

type EmailCopy = Pick<ReturnType<typeof copyFor>["assistant"], "forwardedEmail" | "emailFrom" | "emailOriginal" | "emailSubject" | "emailAttachments" | "emailShow" | "emailCut">;

/**
 * An email the member forwarded, as its turn's text carries it (core/forwarded-email.ts): who it's
 * from, its subject, and its attachments, with the email itself folded away.
 */
function ForwardedEmailCard({ email, copy }: { email: ForwardedEmailParts; copy: EmailCopy }) {
  return (
    <article
      aria-label={copy.forwardedEmail}
      className="ml-auto flex w-full max-w-[85%] flex-col gap-2 rounded-[12px] bg-surface px-3.5 py-3 text-sm shadow-hairline"
      data-forwarded-email
    >
      <p className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3">
        <Mail aria-hidden="true" className="size-3.5" />
        {copy.forwardedEmail}
      </p>
      <p className="font-medium text-ink text-pretty break-words">{email.subject}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-ink-3">{copy.emailFrom}</dt>
        <dd className="truncate text-ink-2">{email.from}</dd>
        {email.originalFrom ? (
          <>
            <dt className="text-ink-3">{copy.emailOriginal}</dt>
            <dd className="truncate text-ink-2">{email.originalFrom}</dd>
          </>
        ) : null}
      </dl>
      {email.attachments.length > 0 ? (
        <ul aria-label={copy.emailAttachments} className="flex flex-wrap gap-1.5">
          {email.attachments.map((name, index) => (
            <li className="inline-flex max-w-full items-center gap-1 rounded-full bg-inset px-2.5 py-1 text-[12px] text-ink-2 shadow-hairline" key={`${name}-${index}`}>
              <Paperclip aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{name}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {email.body ? (
        <details className="group text-[13px]">
          <summary className="cursor-pointer text-ink-3 select-none hover:text-ink">{copy.emailShow}</summary>
          <p className="mt-2 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-ink-2">{email.body}</p>
          {email.truncated ? <p className="mt-1 text-[12px] text-ink-3">{copy.emailCut}</p> : null}
        </details>
      ) : null}
    </article>
  );
}

/** One message's text (as Markdown), the jobs it touched, and, for the member's own, the photos they sent or the email they forwarded. */
function ThreadMessage({
  message,
  toolLabels,
  translation,
  language,
  emailCopy,
  settled,
  extras,
  readOnly,
  sessionId,
}: {
  message: EveMessage;
  toolLabels: Record<string, ToolLabel>;
  translation: ConversationTranslation | null;
  language: Language;
  emailCopy: EmailCopy;
  /** The reply is finished: its tools show as chips (while it runs, the progress steps show them). */
  settled: boolean;
  /** The steps, quote cards, and record links that go with this message, the last of its reply (lib/chat-tools.ts). */
  extras: ReplyExtras<EveMessagePart> | undefined;
  readOnly: boolean;
  /** The eve session, for the reply's trace under "Under the hood". */
  sessionId: string;
}) {
  const texts = textPartsOf(message);
  const files = message.parts.filter((part): part is FilePart => part.type === "file");
  const email = message.role === "user" && texts[0] ? parseForwardedEmailText(texts[0].text) : null;
  if (email) {
    // The card names every attachment; its photos also show below it. Attachments read as text (a CSV)
    // are the email's, not words of the member's.
    return (
      <div className="flex flex-col gap-1.5">
        <ForwardedEmailCard copy={emailCopy} email={email} />
        <MessageFiles parts={files.filter((part) => part.mediaType.startsWith("image/"))} />
      </div>
    );
  }
  const jobs = message.role === "assistant" ? jobLinksOf(message.parts, toolLabels) : [];
  const chips = settled ? (extras?.chips ?? []) : [];
  const cards = settled ? (extras?.quoteIds ?? []) : [];
  if (texts.length === 0 && files.length === 0 && jobs.length === 0 && chips.length === 0 && cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {message.role === "user" ? <MessageFiles parts={files} /> : null}
      {jobs.length > 0 ? <JobLinks links={jobs} /> : null}
      {texts.map((part, index) => (
        <Message from={message.role} key={part.id ?? `${message.id}-${index}`}>
          <MessageContent>
            <MessageText
              id={messageTextId(message, index)}
              language={language}
              links={settled ? extras?.links : undefined}
              streaming={message.role === "assistant" && part.state === "streaming"}
              text={part.text}
              translation={translation}
            />
          </MessageContent>
        </Message>
      ))}
      <ToolSteps language={language} steps={chips} toolLabels={toolLabels} />
      {settled && extras ? <UnderTheHood language={language} parts={extras.parts} sessionId={sessionId} turnId={extras.turnId} /> : null}
      {cards.map((quoteId) => (
        <QuoteCard key={quoteId} language={language} quoteId={quoteId} readOnly={readOnly} />
      ))}
    </div>
  );
}

/** "9:02 AM", or "Mon, Oct 12, 9:02 AM" for an earlier day, in the business's time zone. */
function sentLabel(at: string, timeZone: string, language: Language): string {
  const locale = localeFor(language);
  const day = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const sent = new Date(at);
  const sameDay = day(sent) === day(new Date());
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    ...(sameDay ? {} : { weekday: "short", month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(sent);
}

/** A text the assistant sent on its own (a nudge, the morning line, a PDF): read-only, quieter than the thread. */
function TextedMessage({
  texted,
  timeZone,
  language,
  label,
  openLabel,
  translation,
}: {
  texted: TextedJson;
  timeZone: string;
  language: Language;
  label: string;
  openLabel: string;
  translation: ConversationTranslation | null;
}) {
  const file: ReactNode = texted.file ? (
    texted.file.href ? (
      <a
        className="inline-flex max-w-full items-center gap-1.5 self-start rounded-[8px] bg-surface px-2.5 py-1.5 text-[13px] font-medium text-ink shadow-hairline transition-colors hover:bg-hover"
        href={texted.file.href}
        rel="noreferrer"
        target="_blank"
        title={`${openLabel} ${texted.file.name}`}
      >
        <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-2" />
        <span className="truncate">{texted.file.name}</span>
      </a>
    ) : (
      <span className="inline-flex max-w-full items-center gap-1.5 self-start rounded-[8px] bg-surface px-2.5 py-1.5 text-[13px] text-ink-2 shadow-hairline">
        <FileText aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{texted.file.name}</span>
      </span>
    )
  ) : null;
  return (
    <article aria-label={label} className="flex max-w-[95%] flex-col gap-1.5 self-start" data-texted={texted.kind}>
      <p className="flex items-center gap-1.5 text-[12px] text-ink-3">
        <Smartphone aria-hidden="true" className="size-3.5" />
        <span className="font-medium">{label}</span>
        <span aria-hidden="true">·</span>
        <time dateTime={texted.at} suppressHydrationWarning>
          {sentLabel(texted.at, timeZone, language)}
        </time>
      </p>
      <div className="flex flex-col gap-2 rounded-[12px] border border-dashed border-line-strong bg-inset px-3.5 py-2.5 text-ink-2">
        {texted.text ? (
          <div className="flex flex-col gap-1 text-sm [&_a]:text-accent-ink [&_a]:underline">
            <MessageText id={textedTextId(texted)} language={language} streaming={false} text={texted.text} translation={translation} />
          </div>
        ) : null}
        {file}
      </div>
    </article>
  );
}

async function fetchTexted(): Promise<TextedJson[] | null> {
  try {
    const response = await fetch("/api/assistant/texts", { cache: "no-store" });
    return response.ok ? ((await response.json()) as { texts: TextedJson[] }).texts : null;
  } catch {
    return null;
  }
}

/** The assistant's texts, refreshed when a turn ends (it may have texted a PDF), when the tab comes back, and each minute. */
function useTexted(initial: TextedJson[] | undefined, busy: boolean): TextedJson[] {
  const [texted, setTexted] = useState(initial ?? []);
  const enabled = initial !== undefined;
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      void fetchTexted().then((texts) => live && texts && setTexted(texts));
    };
    const timer = setInterval(load, 60_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [enabled]);
  useEffect(() => {
    if (enabled && wasBusy.current && !busy) void fetchTexted().then((texts) => texts && setTexted(texts));
    wasBusy.current = busy;
  }, [busy, enabled]);
  return texted;
}

/** The record on screen beside the thread, over the prompt: it goes with the next message unless left out. */
function OnScreenChip({ label, title, leaveOut, leaveOutLabel }: { label: string; title: string; leaveOut: () => void; leaveOutLabel: string }) {
  return (
    <div className="flex px-0.5 pt-0.5">
      <span className="flex h-6.5 max-w-full items-center gap-1.5 rounded-chip py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline" title={title}>
        <Eye aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
        <span className="min-w-0 truncate">{label}</span>
        <button
          aria-label={leaveOutLabel}
          className="-my-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors hover:bg-line/70 hover:text-ink"
          onClick={leaveOut}
          type="button"
        >
          <X aria-hidden="true" size={10} strokeWidth={2.5} />
        </button>
      </span>
    </div>
  );
}

/** A photo or PDF going with the next message. */
function AttachedChip({ name, remove, removeLabel }: { name: string; remove: () => void; removeLabel: string }) {
  return (
    <div className="flex px-0.5 pt-0.5">
      <span className="flex h-6.5 max-w-full items-center gap-1.5 rounded-chip py-1 pr-1 pl-1.5 text-[11.5px] text-ink-2 shadow-hairline" title={name}>
        <Paperclip aria-hidden="true" className="size-3 shrink-0 text-ink-3" />
        <span className="min-w-0 max-w-[12rem] truncate">{name}</span>
        <button
          aria-label={removeLabel}
          className="-my-1 flex size-6 shrink-0 items-center justify-center rounded-[5px] text-ink-3 transition-colors hover:bg-line/70 hover:text-ink"
          onClick={remove}
          type="button"
        >
          <X aria-hidden="true" size={10} strokeWidth={2.5} />
        </button>
      </span>
    </div>
  );
}

type AssistantChatProps = {
  /** The agent this session belongs to: the assistant, unless named. */
  agent?: AgentName;
  sessionId: string;
  /** The conversation (thread or job) this session is: its translated view is asked for by this id. */
  conversationId?: string;
  language: Language;
  /** A thread or job with the assistant, or the page designer's conversation. */
  variant?: "thread" | "job" | "designer";
  /** Shows the conversation read-only, with this note where the prompt would be. */
  readOnlyNote?: string;
  /** The member's thread only: what the assistant texted them on its own, shown between the messages. */
  texted?: TextedJson[];
  /** The business's time zone, for when those texts were sent. */
  timeZone?: string;
  /** In the narrow thread panel: tighter margins. */
  compact?: boolean;
  /** What an empty conversation says, in place of the usual. */
  emptyBody?: string;
  /** Called when a turn finishes, so whoever shows the thread can catch up (its title, say). */
  onTurnEnd?: () => void;
  /** The record on the page beside the thread panel: shown over the prompt and sent along unless left out. */
  onScreen?: OnScreenRecord | null;
  /** Sees the conversation as it streams, tool calls being written included (a page's designer previews them). */
  onMessages?: (messages: readonly EveMessage[]) => void;
  /**
   * A send eve refused because it no longer runs this session (409 `session_not_active` or
   * `session_stranded`): handed back, with what was being sent, so the page can open a fresh one. It
   * answers false when it couldn't, and the send shows as failed, as it does without it.
   */
  onSessionEnded?: (content: ChatContent) => Promise<boolean>;
  /** Sent once as soon as the conversation opens: what an ended session couldn't take. */
  initialSend?: ChatContent;
};

/** What one send carries: the text, or the text and its attached files. */
export type ChatContent = string | Array<{ type: "text"; text: string } | { type: "file"; data: string; mediaType: string; filename: string }>;

const ENDED_CODES = new Set(["session_not_active", "session_stranded"]);

/**
 * One of the member's conversations with the assistant: their thread (texts and web turns together)
 * or one of their jobs. With `readOnlyNote`, an owner or admin reads a crew member's job without
 * writing in it. Opens from what this tab last saw of it, or else its whole history in one request
 * (components/assistant/session-cache.ts), then follows what's newer.
 */
function chatCopy(all: ReturnType<typeof copyFor>, variant: NonNullable<AssistantChatProps["variant"]>) {
  if (variant === "job") return { ...all.assistant, ...all.job };
  if (variant === "designer") return { ...all.assistant, ...all.job, ...all.designer };
  return all.assistant;
}

export function AssistantChat(props: AssistantChatProps) {
  const { sessionId, agent = "assistant" } = props;
  // From memory only on the first render: what the server rendered (nothing kept) must match on a fresh load.
  const [initial, setInitial] = useState<{ sessionId: string; events: readonly MessageStreamEvent[] } | null>(() => {
    const events = typeof window === "undefined" ? null : sessionInMemory(sessionId);
    return events ? { sessionId, events } : null;
  });
  const ready = initial?.sessionId === sessionId ? initial.events : null;
  useEffect(() => {
    if (ready) return;
    const cached = cachedSession(sessionId);
    if (cached) return setInitial({ sessionId, events: cached });
    const controller = new AbortController();
    // Unreadable in one go: the chat replays it itself, as it always could.
    loadSession(agent, sessionId, controller.signal).then(
      (events) => setInitial({ sessionId, events }),
      () => controller.signal.aborted || setInitial({ sessionId, events: [] }),
    );
    return () => controller.abort();
  }, [agent, ready, sessionId]);
  if (!ready) {
    const copy = chatCopy(copyFor(props.language), props.variant ?? "thread");
    return <LoadingState className="flex-1 justify-center pt-16 text-ink-3" label={copy.loading} />;
  }
  return <ChatSession {...props} initialEvents={ready} key={sessionId} />;
}

function ChatSession({
  agent: agentName = "assistant",
  sessionId,
  conversationId,
  language,
  variant = "thread",
  readOnlyNote,
  texted: initialTexted,
  timeZone = "UTC",
  compact: inPanel = false,
  emptyBody,
  onTurnEnd,
  onScreen = null,
  onMessages,
  onSessionEnded,
  initialSend,
  initialEvents,
}: AssistantChatProps & { initialEvents: readonly MessageStreamEvent[] }) {
  const all = copyFor(language);
  const copy = chatCopy(all, variant);
  const toolLabels = toolLabelsFor(language);
  // A send that didn't go through: refused by the business's hourly usage limit (a 429), or anything else.
  const [sendFailed, setSendFailed] = useState<"failed" | "limited" | null>(null);
  // The last send, and whether eve refused it as no longer running this session and it went to a fresh one.
  const lastSent = useRef<ChatContent | null>(null);
  const [handedOff, setHandedOff] = useState(false);
  const agent = useEveAgent({
    agent: agentName,
    initialSession: { sessionId, streamIndex: initialEvents.length },
    initialEvents,
    resume: true,
    onError: (error) => {
      if (!onSessionEnded || !lastSent.current || !(error instanceof ClientError) || error.status !== 409 || !ENDED_CODES.has(error.code ?? "")) return;
      const content = lastSent.current;
      lastSent.current = null;
      setHandedOff(true);
      void onSessionEnded(content).then((replaced) => {
        if (replaced) return;
        setHandedOff(false);
        setSendFailed("failed");
      });
    },
  });

  // A phone keeps the composer short, so more of the thread shows above the keyboard.
  const compact = useIsMobile();
  const busy = agent.status === "submitted" || agent.status === "streaming";
  const resuming = agent.status === "resuming";
  const messages = agent.data.messages;
  const texted = useTexted(initialTexted, busy);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) onTurnEnd?.();
    wasBusy.current = busy;
  }, [busy, onTurnEnd]);
  useEffect(() => {
    onMessages?.(messages);
  }, [messages, onMessages]);
  // Kept between turns, so opening it again starts from here.
  useEffect(() => {
    if (agent.status === "ready") rememberSession(sessionId, agent.events);
  }, [agent.status, agent.events, sessionId]);
  // The thread panel is narrow: the same layout with less air on the sides.
  const gutter = inPanel ? "px-4" : "px-4 sm:px-8";
  const items = texted.length ? interleave(messages, messageTimes(messages, agent.events), texted) : messages.map((message) => ({ kind: "message" as const, message }));
  const loadFailed = agent.status === "error" && messages.length === 0;
  // Finished texts only: a reply still streaming is translated once it's done.
  // In the order they show, so the translated view can start from the newest.
  const translatable = useMemo(
    () => items.flatMap((item) => (item.kind === "message" ? messageItems([item.message]) : textedItems([item.texted]))),
    [items],
  );
  // What each reply did: its tools as chips, and cards for the quotes it touched (the latest reply about each).
  const extras = useMemo(() => replyExtras(messages), [messages]);
  const lastMessageId = messages.at(-1)?.id;
  const translation = useConversationTranslation(conversationId, translatable, language, variant === "job");
  const translating = conversationId ? translation : null;

  // Left out by its ✕ until the page beside shows something else.
  const [leftOut, setLeftOut] = useState<string | null>(null);
  const sendAlong = onScreen && leftOut !== onScreenHeader(onScreen) ? onScreen : null;
  // Photos and PDFs going with the next message.
  const [attached, setAttached] = useState<Attached[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const attach = async (files: FileList | null) => {
    setAttachError(null);
    for (const file of Array.from(files ?? []).slice(0, MAX_ATTACHED - attached.length)) {
      const ready = await prepareAttachment(file);
      if (ready === "TOO_BIG") setAttachError(all.assistant.fileTooBig);
      else if (ready === "UNSUPPORTED") setAttachError(all.assistant.fileUnsupported);
      else
        setAttached((current) => {
          if (current.reduce((sum, f) => sum + f.data.length, 0) + ready.data.length > MAX_ATTACHED_CHARS) {
            setAttachError(all.assistant.filesTooBig);
            return current;
          }
          return [...current, ready].slice(0, MAX_ATTACHED);
        });
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const deliver = (content: ChatContent) => {
    setSendFailed(null);
    lastSent.current = content;
    agent
      .send(content, sendAlong ? { headers: { [ON_SCREEN_HEADER]: onScreenHeader(sendAlong) } } : undefined)
      .catch((error: unknown) => setSendFailed(error instanceof ClientError && error.status === 429 ? "limited" : "failed"));
  };
  const storing = useRef(false);
  const send = async (text: string) => {
    const message = text.trim();
    if ((!message && attached.length === 0) || busy || resuming || storing.current) return;
    const files = attached;
    setAttached([]);
    setAttachError(null);
    // The assistant's files are stored and logged first, so a quote made from the chat carries them. One
    // that fails stays attached with the reason, and the rest of the message still goes.
    storing.current = true;
    const stored = agentName === "assistant" ? await Promise.all(files.map(storeAttachment)) : files.map(asFilePart);
    storing.current = false;
    const parts = stored.flatMap((part) => ("error" in part ? [] : [part]));
    const failed = files.filter((_, i) => "error" in stored[i]);
    if (failed.length) {
      const reason = stored.find((part): part is { error: string | null } => "error" in part)?.error;
      setAttached(failed);
      setAttachError(reason ?? all.assistant.fileUnsupported);
    }
    if (!message && parts.length === 0) return;
    const content: ChatContent = parts.length ? [...(message ? [{ type: "text" as const, text: message }] : []), ...parts] : message;
    deliver(content);
  };
  // Once, when the conversation is open and idle.
  const sentInitial = useRef(false);
  useEffect(() => {
    if (!initialSend || sentInitial.current || agent.status !== "ready") return;
    sentInitial.current = true;
    deliver(initialSend);
    // deliver is rebuilt each render; the ref keeps this to one send.
  }, [initialSend, agent.status]);

  if (loadFailed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center" role="alert">
        <p className="text-sm text-ink-2">{copy.error}</p>
        <Button onClick={() => void agent.resume()} size="sm" type="button" variant="secondary">
          <RotateCw aria-hidden="true" className="size-3.5" />
          {copy.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {conversationId && translatable.length > 0 ? (
        <InHeader>
          <LanguageToggle compact={inPanel} language={language} translation={translation} />
        </InHeader>
      ) : null}
      <Conversation className="min-h-0">
        <ConversationContent className={`mx-auto w-full max-w-[720px] gap-6 pb-4 ${gutter} ${inPanel ? "pt-5" : "pt-8"}`}>
          {messages.length === 0 && (resuming || items.length === 0) ? (
            resuming ? (
              <LoadingState className="justify-center pt-16 text-ink-3" label={copy.loading} />
            ) : (
              <ConversationEmptyState
                className="pt-16"
                description={emptyBody ?? copy.emptyBody}
                icon={<MessageSquareText className="size-8" />}
                title={copy.emptyTitle}
              />
            )
          ) : (
            items.map((item) =>
              item.kind === "message" ? (
                <ThreadMessage
                  emailCopy={all.assistant}
                  key={item.message.id}
                  language={language}
                  message={item.message}
                  extras={extras.get(item.message.id)}
                  readOnly={readOnlyNote !== undefined}
                  sessionId={sessionId}
                  settled={!(busy && item.message.id === lastMessageId)}
                  toolLabels={toolLabels}
                  translation={translating}
                />
              ) : (
                <TextedMessage
                  key={item.texted.id}
                  label={all.assistant.textedYou}
                  language={language}
                  openLabel={all.assistant.openFile}
                  texted={item.texted}
                  timeZone={timeZone}
                  translation={translating}
                />
              ),
            )
          )}
          {busy || (resuming && messages.length > 0) ? (
            <AgentProgress
              conversation={agent.conversation}
              copy={copy}
              resuming={resuming}
              toolLabels={toolLabels}
            />
          ) : null}
          {!handedOff && (sendFailed || (agent.error && messages.length > 0)) ? (
            <p className="text-sm text-destructive" role="alert">
              {sendFailed === "limited" || (agent.error instanceof ClientError && agent.error.status === 429) ? copy.usageLimited : copy.sendFailed}
            </p>
          ) : null}
          {attachError ? (
            <p className="text-sm text-destructive" role="alert">
              {attachError}
            </p>
          ) : null}
        </ConversationContent>
        <ConversationScrollButton aria-label={copy.latest} />
      </Conversation>

      <div className={`px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-4 ${inPanel ? "" : "sm:px-8"}`}>
        {readOnlyNote !== undefined ? (
          <p className="mx-auto w-full max-w-[720px] rounded-[10px] bg-accent-tint px-3 py-2 text-[13px] text-accent-ink" role="note">
            {readOnlyNote}
          </p>
        ) : (
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
            <div className="flex w-full items-end gap-2">
              <input accept={ATTACH_ACCEPT} className="hidden" multiple onChange={(event) => void attach(event.target.files)} ref={fileInput} type="file" />
              <PromptBar
                busy={busy || resuming}
                demo={false}
                files={
                  sendAlong || attached.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {sendAlong ? (
                        <OnScreenChip label={sendAlong.label} leaveOut={() => setLeftOut(onScreenHeader(sendAlong))} leaveOutLabel={all.assistant.leaveOut(sendAlong.label)} title={all.assistant.onScreen(sendAlong.label)} />
                      ) : null}
                      {attached.map((file, index) => (
                        <AttachedChip
                          key={`${file.name}-${index}`}
                          name={file.name}
                          remove={() => setAttached((current) => current.filter((_, i) => i !== index))}
                          removeLabel={all.assistant.removeFile(file.name)}
                        />
                      ))}
                    </div>
                  ) : undefined
                }
                attachLabel={all.assistant.attach}
                hasFiles={attached.length > 0}
                minimal
                onAttach={readOnlyNote === undefined && attached.length < MAX_ATTACHED ? () => fileInput.current?.click() : undefined}
                onSend={send}
                placeholder={copy.placeholder}
                sendLabel={copy.send}
                tall={!compact && !inPanel}
              />
              {busy ? (
                <Button
                  className="mb-1 shrink-0"
                  onClick={() => void agent.cancel()}
                  size="sm"
                  type="button"
                  variant="secondary"
                >
                  {copy.stop}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
