"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { Language } from "@/core/language";
import type { TranslationResult } from "@/core/translation";
import { LanguageToggle, TranslatedNote, type ConversationTranslation, type ViewLanguage } from "@/components/assistant/translation";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";

// A quote's language on its page. The translated view shows what the quote says (title, lines, rules,
// notes) in English or Spanish, like a conversation's: off until chosen, the choice remembered per quote
// (localStorage), and translations kept for the browser session per revision (sessionStorage). The server
// reads the texts from the quote itself (app/api/quotes/[id]/translation). The language control writes the
// quote in another language, as a new revision.

type Results = Record<string, TranslationResult>;
const viewKey = (quoteId: string) => `gw:quote-view:${quoteId}`;
const cacheKey = (quoteId: string, revision: number, target: Language) => `gw:quote-translations:${quoteId}:${revision}:${target}`;

function readCache(key: string): Results | null {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key) ?? "null") as unknown;
    return saved && typeof saved === "object" ? (saved as Results) : null;
  } catch {
    return null;
  }
}

const QuoteTranslationContext = createContext<ConversationTranslation | null>(null);

export function QuoteTranslationProvider({ quoteId, revision, children }: { quoteId: string; revision: number; children: ReactNode }) {
  const [target, setTargetState] = useState<ViewLanguage>("off");
  const [results, setResults] = useState<Results>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ConversationTranslation["problem"]>(null);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(viewKey(quoteId));
      if (saved === "en" || saved === "es") setTargetState(saved);
    } catch {
      // Off.
    }
  }, [quoteId]);

  const setTarget = useCallback(
    (next: ViewLanguage) => {
      setTargetState(next);
      try {
        if (next === "off") window.localStorage.removeItem(viewKey(quoteId));
        else window.localStorage.setItem(viewKey(quoteId), next);
      } catch {
        // Not remembered.
      }
    },
    [quoteId],
  );

  useEffect(() => {
    setProblem(null);
    if (target === "off") return setResults({});
    const key = cacheKey(quoteId, revision, target);
    const cached = readCache(key);
    if (cached) return setResults(cached);
    let live = true;
    setPending(true);
    setResults({});
    void fetch(`/api/quotes/${encodeURIComponent(quoteId)}/translation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target }),
    })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) return setProblem(response.status === 429 ? "limited" : "failed");
        const body = (await response.json()) as { translations: Array<TranslationResult & { id: string }> };
        const next: Results = Object.fromEntries(body.translations.map(({ id, ...result }) => [id, result]));
        setResults(next);
        if (body.translations.some((t) => t.failed)) setProblem("failed");
        else {
          try {
            window.sessionStorage.setItem(key, JSON.stringify(next));
          } catch {
            // Fetched again next time.
          }
        }
      })
      .catch(() => live && setProblem("failed"))
      .finally(() => live && setPending(false));
    return () => {
      live = false;
    };
  }, [quoteId, revision, target]);

  const value: ConversationTranslation = {
    target,
    setTarget,
    pending,
    problem,
    translationOf: (id) => {
      if (target === "off") return null;
      const result = results[id];
      return result?.translated ? result.text : null;
    },
    isPending: (id) => target !== "off" && pending && !results[id],
  };
  return <QuoteTranslationContext.Provider value={value}>{children}</QuoteTranslationContext.Provider>;
}

/** The quote's "English / Español" view switch. */
export function QuoteViewToggle({ language }: { language: Language }) {
  const translation = useContext(QuoteTranslationContext);
  if (!translation) return null;
  return <LanguageToggle language={language} translation={translation} />;
}

/**
 * One of the quote's texts, translated when the view is on. `note` adds the "Translated · Show original"
 * line under it (block content only, like the notes); a short text (the title, a line's name) carries its
 * original as a tooltip.
 */
export function QuoteText({ id, text, language, note = false }: { id: string; text: string; language: Language; note?: boolean }) {
  const translation = useContext(QuoteTranslationContext);
  const [showingOriginal, setShowingOriginal] = useState(false);
  const translated = translation?.translationOf(id) ?? null;
  const waiting = !translated && Boolean(translation?.isPending(id));
  if (!translated) return <span className={waiting ? "opacity-60 motion-safe:animate-pulse" : undefined}>{text}</span>;
  if (!note) return <span title={text}>{translated}</span>;
  return (
    <>
      <span className="whitespace-pre-line">{showingOriginal ? text : translated}</span>
      <div className="mt-1">
        <TranslatedNote language={language} onToggle={() => setShowingOriginal((v) => !v)} showingOriginal={showingOriginal} />
      </div>
    </>
  );
}

/**
 * The language the quote is written in, and, when it isn't its customer's, a line saying so with a
 * button to switch. Changing it makes a new revision (an approved quote goes back to draft, so that asks
 * first). Read-only for anyone who can't revise it.
 */
export function QuoteLanguageControl({
  quoteId,
  revision,
  status,
  quoteLanguage,
  customer,
  canChange,
  language,
}: {
  quoteId: string;
  revision: number;
  status: string;
  quoteLanguage: Language;
  customer: { name: string; language: Language } | null;
  canChange: boolean;
  language: Language;
}) {
  const q = pageCopyFor(language).quotes;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = q.languageNames;

  const change = async (next: Language) => {
    if (next === quoteLanguage || busy) return;
    if ((status === "approved" || status === "sent") && !window.confirm(q.reapprove)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/language`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: next, revision }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? q.errors.quoteChanged);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const mismatch = customer !== null && customer.language !== quoteLanguage;
  return (
    <div className="space-y-2 text-[13px]">
      <label className="flex items-center gap-2 text-ink-2">
        <span>{q.language}</span>
        {canChange ? (
          <select
            className="rounded-[8px] border border-line bg-page px-2 py-1 text-[13px] text-ink disabled:opacity-60"
            disabled={busy}
            onChange={(event) => void change(event.target.value as Language)}
            value={quoteLanguage}
          >
            <option value="en">English</option>
            <option value="es">Español</option>
          </select>
        ) : (
          <span className="text-ink">{quoteLanguage === "es" ? "Español" : "English"}</span>
        )}
      </label>
      {mismatch ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[10px] bg-orange-tint px-3 py-2" role="status">
          <p className="text-ink">{q.languageMismatch(names[quoteLanguage], customer.name, names[customer.language])}</p>
          {canChange ? (
            <Button disabled={busy} onClick={() => void change(customer.language)} size="sm" type="button" variant="secondary">
              {busy ? q.switching : q.switchTo(customer.language === "es" ? "Español" : "English")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
