"use client";

import { Languages } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LANGUAGES, type Language } from "@/core/language";
import type { TranslationResult } from "@/core/translation";
import { copyFor } from "@/lib/copy";
import type { TranslatableItem } from "@/lib/translatable";
import { Spinner } from "@/components/spinner";
import { cn } from "@/ui/lib/utils";

// A conversation's translated view: its messages in English or Spanish, whoever wrote them. A job's
// conversation, where people who speak different languages meet, starts in the viewer's language; the
// member's own thread starts as sent, since the assistant already answers them in their language. The
// viewer's choice is remembered per conversation (localStorage), and choosing the language that's
// already on shows every message as sent. Translations already fetched are kept for the browser
// session (sessionStorage), so coming back to a conversation doesn't ask for them again. A translation is only a view: the browser asks
// for messages by id (lib/translatable.ts), the server reads and translates their stored text
// (app/api/conversations/[id]/translate, cached there per business), and the message itself never
// changes. A message already in the chosen language shows as it is.
//
// The newest messages, the ones on screen, go first and in a small batch, so the view changes within
// seconds; the rest follow, two batches at a time. A message still waiting on its translation says so.

export type ViewLanguage = Language | "off";

const FIRST_BATCH = 8;
const BATCH = 40;
const PARALLEL = 2;
const storageKey = (conversationId: string) => `gw:view-language:${conversationId}`;
const cacheKey = (conversationId: string, target: Language) => `gw:translations:${conversationId}:${target}`;

/** The translations this browser session already has for a conversation, by id. */
function readCache(conversationId: string, target: Language): Record<string, TranslationResult> {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(cacheKey(conversationId, target)) ?? "{}") as unknown;
    return saved && typeof saved === "object" ? (saved as Record<string, TranslationResult>) : {};
  } catch {
    return {};
  }
}

function writeCache(conversationId: string, target: Language, fresh: Record<string, TranslationResult>): void {
  try {
    window.sessionStorage.setItem(cacheKey(conversationId, target), JSON.stringify({ ...readCache(conversationId, target), ...fresh }));
  } catch {
    // Full or off: fetched again next time.
  }
}
const resultKey = (target: Language, id: string) => `${target}\u0000${id}`;
const isView = (value: unknown): value is ViewLanguage => value === "en" || value === "es" || value === "off";

export type ConversationTranslation = {
  target: ViewLanguage;
  setTarget: (next: ViewLanguage) => void;
  pending: boolean;
  /** Why some texts show as sent: the business's usage limit, or anything else. */
  problem: "limited" | "failed" | null;
  /** The text to show in place of the item with this id, or null to show it as sent. */
  translationOf: (id: string) => string | null;
  /** Whether the item with this id is still waiting on its translation. */
  isPending: (id: string) => boolean;
};

/** The newest first, in a small batch so the screen changes soon, then the rest in full batches. */
export function translationBatches(ids: readonly string[]): string[][] {
  const newestFirst = [...ids].reverse();
  const batches = [newestFirst.slice(0, FIRST_BATCH)];
  for (let start = FIRST_BATCH; start < newestFirst.length; start += BATCH) batches.push(newestFirst.slice(start, start + BATCH));
  return batches.filter((batch) => batch.length > 0);
}

/** The translated view of one conversation's `items` (finished texts only; a reply still streaming waits). */
export function useConversationTranslation(
  conversationId: string | undefined,
  items: readonly TranslatableItem[],
  viewer: Language,
  /** Whether it starts in the viewer's language (a job's conversation) rather than as sent (their own thread). */
  translateByDefault: boolean,
): ConversationTranslation {
  const [target, setTargetState] = useState<ViewLanguage>(translateByDefault ? viewer : "off");
  const [results, setResults] = useState<Record<string, TranslationResult>>({});
  const [inFlight, setInFlight] = useState(0);
  const [problem, setProblem] = useState<ConversationTranslation["problem"]>(null);
  // Bumped when a round of batches ends, so ids it gave up on stop showing as waiting.
  const [, setSettled] = useState(0);
  const requested = useRef(new Set<string>());

  // The saved choice, read after the first render so the server's and the browser's first renders match.
  useEffect(() => {
    if (!conversationId) return;
    try {
      const saved = window.localStorage.getItem(storageKey(conversationId));
      // In the member's own thread their own language changes nothing worth a round trip: it shows as sent.
      if (isView(saved)) setTargetState(!translateByDefault && saved === viewer ? "off" : saved);
    } catch {
      // Storage can be off (private browsing): the view just starts in the viewer's language.
    }
  }, [conversationId, translateByDefault, viewer]);

  const setTarget = (next: ViewLanguage) => {
    setTargetState(next);
    setProblem(null);
    if (!conversationId) return;
    try {
      window.localStorage.setItem(storageKey(conversationId), next);
    } catch {
      // Not remembered, but still shown.
    }
  };

  // By id, not identity: the stream hands over a new array of the same messages on every update.
  const signature = items.map((item) => item.id).join("\u0001");
  const ids = useMemo(() => [...new Set(items.map((item) => item.id))], [signature]);

  // What this browser session already fetched comes first, so only new messages are asked for.
  useEffect(() => {
    if (!conversationId || target === "off") return;
    const cached = readCache(conversationId, target);
    const known = Object.entries(cached).filter(([id]) => !requested.current.has(resultKey(target, id)));
    if (known.length === 0) return;
    for (const [id] of known) requested.current.add(resultKey(target, id));
    setResults((current) => ({ ...current, ...Object.fromEntries(known.map(([id, result]) => [resultKey(target, id), result])) }));
  }, [conversationId, target]);

  useEffect(() => {
    if (!conversationId || target === "off") return;
    const needed = ids.filter((id) => !requested.current.has(resultKey(target, id)));
    if (needed.length === 0) return;
    for (const id of needed) requested.current.add(resultKey(target, id));
    setProblem(null);
    setInFlight((n) => n + 1);
    const [first, ...rest] = translationBatches(needed);
    let limited = false;
    const run = async (batch: string[]) => {
      if (limited) {
        for (const id of batch) requested.current.delete(resultKey(target, id));
        return;
      }
      let failure: "limited" | "failed" | null = null;
      try {
        const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/translate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target, ids: batch }),
        });
        if (response.ok) {
          const data = (await response.json()) as { translations: Array<TranslationResult & { id: string }> };
          setResults((current) => ({ ...current, ...Object.fromEntries(data.translations.map((result) => [resultKey(target, result.id), result])) }));
          writeCache(conversationId, target, Object.fromEntries(data.translations.filter((result) => !result.failed).map(({ id, ...result }) => [id, result])));
          const missed = data.translations.filter((result) => result.failed).map((result) => result.id);
          for (const id of missed) requested.current.delete(resultKey(target, id));
          if (missed.length) setProblem("failed");
        } else {
          failure = response.status === 429 ? "limited" : "failed";
        }
      } catch {
        failure = "failed";
      }
      if (failure) {
        // Asked again the next time the view or the messages change.
        for (const id of batch) requested.current.delete(resultKey(target, id));
        setProblem(failure);
        if (failure === "limited") limited = true;
      }
    };
    void (async () => {
      await run(first);
      // The rest, two at a time: each worker takes the next batch until none are left.
      const queue = [...rest];
      await Promise.all(
        Array.from({ length: Math.min(PARALLEL, queue.length) }, async () => {
          for (let batch = queue.shift(); batch; batch = queue.shift()) await run(batch);
        }),
      );
      setInFlight((n) => n - 1);
      setSettled((n) => n + 1);
    })();
  }, [conversationId, target, ids]);

  return {
    target,
    setTarget,
    pending: inFlight > 0,
    problem,
    translationOf: (id) => {
      if (target === "off") return null;
      const result = results[resultKey(target, id)];
      return result?.translated ? result.text : null;
    },
    isPending: (id) => target !== "off" && requested.current.has(resultKey(target, id)) && !results[resultKey(target, id)],
  };
}

/**
 * The conversation's "English / Español" switch, and a line when some messages show as sent. `compact`
 * (the narrow thread panel) shows EN / ES at every width.
 */
export function LanguageToggle({ translation, language, compact = false }: { translation: ConversationTranslation; language: Language; compact?: boolean }) {
  const t = copyFor(language).translation;
  const { target, setTarget, pending, problem } = translation;
  return (
    <div className="flex items-center justify-end gap-x-3">
      {problem ? (
        <p className="max-w-[16rem] truncate text-[12px] text-ink-3" role="status" title={problem === "limited" ? t.limited : t.failed}>
          {problem === "limited" ? t.limited : t.failed}
        </p>
      ) : pending ? (
        <div className="flex items-center gap-1.5 text-[12px] text-ink-2" role="status" title={t.translating}>
          <Spinner size={12} />
          <span className={compact ? "sr-only" : "sr-only sm:not-sr-only"}>{t.translating}</span>
        </div>
      ) : null}
      <div aria-label={t.label} className="flex items-center gap-1 rounded-full bg-inset p-0.5 shadow-hairline" role="group" title={t.hint}>
        <Languages aria-hidden="true" className="ml-1.5 size-3.5 text-ink-3" />
        {LANGUAGES.map((option) => (
          <button
            aria-busy={pending && target === option ? true : undefined}
            aria-pressed={target === option}
            className={cn(
              "h-6 rounded-full px-2.5 text-[12px] transition-colors",
              target === option ? "bg-surface font-medium text-ink shadow-hairline" : "text-ink-2 hover:text-ink",
              // The language being translated into pulses until it's done.
              pending && target === option && "motion-safe:animate-pulse",
            )}
            key={option}
            lang={option}
            onClick={() => setTarget(target === option ? "off" : option)}
            type="button"
          >
            <span className={compact ? undefined : "sm:hidden"}>{option.toUpperCase()}</span>
            {compact ? null : <span className="hidden sm:inline">{t.languages[option]}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Under a translated message: says so, and switches between the translation and what was sent. */
export function TranslatedNote({ showingOriginal, onToggle, language }: { showingOriginal: boolean; onToggle: () => void; language: Language }) {
  const t = copyFor(language).translation;
  return (
    <p className="flex items-center gap-1.5 text-[12px] text-ink-3 group-[.is-user]:justify-end">
      <Languages aria-hidden="true" className="size-3" />
      <span>{showingOriginal ? t.original : t.translated}</span>
      <span aria-hidden="true">·</span>
      <button className="underline-offset-2 hover:text-ink hover:underline" onClick={onToggle} type="button">
        {showingOriginal ? t.showTranslation : t.showOriginal}
      </button>
    </p>
  );
}
