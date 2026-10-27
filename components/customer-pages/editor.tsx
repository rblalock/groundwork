"use client";

import type { EveMessage } from "eve/client";
import { Monitor, Smartphone } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CustomerPageKind } from "@/core/customer-page-template";
import type { Language } from "@/core/language";
import { AssistantChat, type ChatContent } from "@/components/assistant/assistant-chat";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";
import { SegmentedControl } from "@/ui/beautiful/atoms/SegmentedControl";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { ErrorLine, useMutation } from "../pages/client-kit";

export type EditorProps = {
  page: CustomerPageKind;
  language: Language;
  /** The member's conversation with the designer about this page; null for a super admin's read-only view. */
  sessionId: string | null;
  published: number | null;
  latest: number | null;
  versions: Array<{ version: number; request: string | null }>;
  hasRecent: boolean;
  /** The version to show first (a preview link names one); the newest otherwise. */
  initialVersion: number | null;
};

const STATES = { quote: ["open", "approved", "expired"], invoice: ["payable", "paid", "void"] } as const;
// The tools whose results change what the editor shows: a new version, which one is live, or the logo.
const PAGE_TOOLS = new Set(["write_customer_page", "edit_customer_page", "publish_customer_page", "set_logo"]);
const DRAFT_EVERY_MS = 400;

/**
 * The `html` of a tool call's input while it's still being written: the JSON string's text so far,
 * unescaped, stopping where the model has got to. Null before it starts.
 */
export function partialHtml(inputText: string): string | null {
  const start = /"html"\s*:\s*"/.exec(inputText);
  if (!start) return null;
  let out = "";
  for (let i = start.index + start[0].length; i < inputText.length; i++) {
    const c = inputText[i];
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = inputText[++i];
    if (next === undefined) break;
    if (next === "u") {
      const hex = inputText.slice(i + 1, i + 5);
      if (hex.length < 4) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next;
  }
  return out;
}

/**
 * A customer page's designer: the member's conversation with the page designer (agents/designer/)
 * beside the page itself, filled with a sample or the business's newest real document. The preview draws
 * the page while the designer writes it, then shows each saved version. Customers see one only once
 * it's published.
 */
export function CustomerPageEditor({ page, language, sessionId: openedSession, published, latest, versions, hasRecent, initialVersion }: EditorProps) {
  const t = pageCopyFor(language).customerPages;
  const copy = pageCopyFor(language);
  const router = useRouter();
  const { send: mutate, busy: mutating, error: mutationError } = useMutation(copy.common.failed);

  // The conversation, and a send its predecessor refused once eve stopped running it: a fresh one takes it.
  const [conversation, setConversation] = useState<{ sessionId: string | null; pending?: ChatContent }>({ sessionId: openedSession });
  const sessionId = conversation.sessionId;
  const onSessionEnded = useCallback(
    async (content: ChatContent) => {
      const response = await fetch(`/api/customer-pages/${page}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ended: sessionId }),
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { sessionId?: string } | null;
      if (!response?.ok || !body?.sessionId || body.sessionId === sessionId) return false;
      setConversation({ sessionId: body.sessionId, pending: content });
      return true;
    },
    [page, sessionId],
  );
  const canEdit = sessionId !== null;
  const [html, setHtml] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [writing, setWriting] = useState(false);
  const [source, setSource] = useState<"sample" | "recent">("sample");
  const [state, setState] = useState<string>(STATES[page][0]);
  const [docLanguage, setDocLanguage] = useState<Language>(language);
  const [width, setWidth] = useState<"phone" | "desktop">("phone");
  const [viewing, setViewing] = useState<number | null>(initialVersion && versions.some((v) => v.version === initialVersion) ? initialVersion : null);
  const shown = viewing ?? latest;

  // Every preview request is numbered; only the newest one's answer is shown.
  const request = useRef(0);
  const preview = useCallback(
    async (draft?: string) => {
      const n = ++request.current;
      const response = await fetch(`/api/customer-pages/${page}/preview`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, state, language: docLanguage, ...(draft !== undefined ? { html: draft } : viewing ? { version: viewing } : {}) }),
      }).catch(() => null);
      const body = (await response?.json().catch(() => null)) as { html?: string | null } | null;
      if (n !== request.current) return;
      if (response?.ok && (draft === undefined || body?.html)) setHtml(body?.html ?? null);
      setLoaded(true);
    },
    [page, source, state, docLanguage, viewing],
  );

  useEffect(() => {
    if (!writing) void preview();
    // `latest` changes after a save: the preview follows the newest version.
  }, [preview, writing, latest]);

  // The page as the designer writes it, from the conversation's stream.
  const lastDraft = useRef({ text: "", at: 0 });
  const seen = useRef(new Set<string>());
  const onMessages = useCallback(
    (messages: readonly EveMessage[]) => {
      const parts = messages.at(-1)?.parts ?? [];
      for (const part of parts) {
        if (part.type !== "dynamic-tool" || !PAGE_TOOLS.has(part.toolName)) continue;
        if (part.state === "input-streaming" && part.toolName === "write_customer_page") {
          const draft = partialHtml(part.inputText);
          const now = Date.now();
          if (!draft || draft === lastDraft.current.text || now - lastDraft.current.at < DRAFT_EVERY_MS) continue;
          lastDraft.current = { text: draft, at: now };
          setWriting(true);
          setViewing(null);
          void preview(draft);
        } else if ((part.state === "output-available" || part.state === "output-error") && !seen.current.has(part.toolCallId)) {
          // Saved (or refused): back to the newest saved version, and the versions list catches up.
          seen.current.add(part.toolCallId);
          setWriting(false);
          setViewing(null);
          router.refresh();
        }
      }
    },
    [preview, router],
  );
  // What was already in the conversation when it opened isn't news.
  const primed = useRef(false);
  const onFirstMessages = useCallback(
    (messages: readonly EveMessage[]) => {
      if (!primed.current) {
        primed.current = true;
        for (const message of messages) for (const part of message.parts) if (part.type === "dynamic-tool") seen.current.add(part.toolCallId);
        return;
      }
      onMessages(messages);
    },
    [onMessages],
  );

  async function act(key: string, path: string, body: object = {}) {
    if ((await mutate(key, `/api/customer-pages/${page}/${path}`, { method: "POST", body })) && key === "restore") setViewing(null);
  }

  const sampleStates = STATES[page] as readonly string[];
  const stateLabels = sampleStates.map((s) => t.states[s]);

  return (
    <div className="grid gap-4 @4xl:h-[calc(100svh-10.25rem)] @4xl:min-h-[560px] @4xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
      {/* The page: its preview, and what to do with it. */}
      <section
        aria-label={t.preview}
        className="order-1 flex h-[min(80svh,860px)] min-h-[480px] min-w-0 flex-col overflow-hidden rounded-card bg-surface shadow-card @4xl:order-2 @4xl:h-full @4xl:min-h-0"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5">
          {hasRecent ? (
            <SegmentedControl
              onChange={(label) => setSource(label === t.recent ? "recent" : "sample")}
              options={[t.sample, t.recent] as const}
              value={source === "recent" ? t.recent : t.sample}
            />
          ) : null}
          {source === "sample" ? (
            <SegmentedControl onChange={(label) => setState(sampleStates[stateLabels.indexOf(label)])} options={stateLabels} value={t.states[state]} />
          ) : null}
          {source === "sample" ? <SegmentedControl onChange={(v) => setDocLanguage(v === "ES" ? "es" : "en")} options={["EN", "ES"] as const} value={docLanguage === "es" ? "ES" : "EN"} /> : null}
          <div className="ml-auto flex items-center gap-1">
            <Button aria-label={t.phone} aria-pressed={width === "phone"} onClick={() => setWidth("phone")} size="xs" variant={width === "phone" ? "ghost" : "quiet"}>
              <Smartphone aria-hidden="true" className="size-3.5" />
            </Button>
            <Button aria-label={t.desktop} aria-pressed={width === "desktop"} onClick={() => setWidth("desktop")} size="xs" variant={width === "desktop" ? "ghost" : "quiet"}>
              <Monitor aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>

        <div className={`flex min-h-0 flex-1 justify-center bg-inset ${width === "phone" ? "p-4" : ""}`}>
          {html ? (
            <div className={`h-full overflow-hidden bg-white transition-[width] duration-200 ${width === "phone" ? "w-[390px] max-w-full rounded-[20px] shadow-card ring-1 ring-line" : "w-full"}`}>
              <iframe
                className="block size-full border-0"
                // No scripts, no forms, no same origin: the page can't do anything but show itself.
                sandbox=""
                srcDoc={html}
                title={t.preview}
              />
            </div>
          ) : (
            <p className="self-center text-[13px] text-ink-3">{loaded ? t.empty : copy.common.loading}</p>
          )}
        </div>

        {canEdit && latest !== null ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
            <label className="sr-only" htmlFor="page-version">
              {t.version(shown ?? 0)}
            </label>
            <select
              className="h-[27px] w-full max-w-[min(18rem,100%)] min-w-0 truncate rounded-full border border-line bg-surface px-2.5 text-[13px] text-ink @md:w-auto"
              disabled={writing}
              id="page-version"
              onChange={(event) => setViewing(Number(event.target.value) === latest ? null : Number(event.target.value))}
              value={shown ?? ""}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {t.version(v.version)}
                  {v.version === published ? ` · ${t.isLive}` : ""}
                  {v.request ? ` · ${v.request.slice(0, 48)}` : ""}
                </option>
              ))}
            </select>
            {shown === published ? (
              <StatusPill tone="green">{t.isLive}</StatusPill>
            ) : (
              <Button disabled={writing || mutating !== null} onClick={() => void act("publish", "publish", { version: shown })} size="sm" variant="primary">
                {mutating === "publish" ? t.publishing : t.publishVersion(shown ?? 0)}
              </Button>
            )}
            {viewing !== null && viewing !== latest ? (
              <Button disabled={writing || mutating !== null} onClick={() => void act("restore", "restore", { version: viewing })} size="sm" variant="secondary">
                {t.restore}
              </Button>
            ) : null}
            <div className="ml-auto flex items-center gap-3">
              <span className="text-[12px] text-ink-3">{t.customersSee(published)}</span>
              {published !== null ? (
                <Button disabled={writing || mutating !== null} onClick={() => void act("standard", "standard")} size="sm" variant="quiet">
                  {t.useStandard}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        {mutationError ? (
          <div className="border-t border-line px-3 py-2">
            <ErrorLine>{mutationError}</ErrorLine>
          </div>
        ) : null}
      </section>

      {/* The member's conversation with the designer about this page. */}
      {sessionId ? (
        <section
          aria-label={t.designer}
          className="order-2 flex h-[min(80svh,860px)] min-h-[420px] min-w-0 flex-col overflow-hidden rounded-card bg-surface shadow-card @4xl:order-1 @4xl:h-full @4xl:min-h-0"
        >
          <AssistantChat
            agent="designer"
            compact
            initialSend={conversation.pending}
            key={sessionId}
            language={language}
            onMessages={onFirstMessages}
            onSessionEnded={onSessionEnded}
            sessionId={sessionId}
            variant="designer"
          />
        </section>
      ) : null}
    </div>
  );
}
