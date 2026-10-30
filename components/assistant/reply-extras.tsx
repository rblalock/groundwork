"use client";

import { ChevronRight, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ComponentProps, type ComponentType } from "react";
import { defaultComponents } from "streamdown";
import type { Language } from "@/core/language";
import type { PostFormat } from "@/core/social-post";
import type { ToolLabel } from "@/core/tool-labels";
import { humanizeToolName } from "@/components/assistant/agent-progress";
import { QuoteStatusPill } from "@/components/pages/kit";
import { isRecordLink, type ToolChip } from "@/lib/chat-tools";
import { copyFor } from "@/lib/copy";
import { money } from "@/lib/format";
import type { QuoteCard as QuoteCardData } from "@/lib/pages/quotes";
import { Button } from "@/ui/beautiful/atoms/Button";
import { cn } from "@/ui/lib/utils";

// Under one of the assistant's replies: the steps it took, as one quiet line that opens, a card for each
// quote it made or changed there, and the links its words get to the records (lib/chat-tools.ts picks
// which reply gets which).

/**
 * What a reply did, in the Beautiful kit's tool-chips style: one quiet line under the reply ("Read the
 * schedule", or "3 steps"), opening to a row per step with what it touched. A step that failed or was
 * refused is tinted, and the line says so before it's opened.
 */
export function ToolSteps({ steps, toolLabels, language }: { steps: ToolChip[]; toolLabels: Record<string, ToolLabel>; language: Language }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return null;
  const copy = copyFor(language).assistant;
  const label = (step: ToolChip) => toolLabels[step.tool]?.done ?? humanizeToolName(step.tool);
  const total = steps.reduce((sum, step) => sum + step.count, 0);
  const failed = steps.some((step) => step.failed);
  const detail = (step: ToolChip) =>
    step.detail || step.count > 1 ? (
      <span className="inline-flex h-5 min-w-0 items-center truncate rounded-[6px] bg-field px-1.5 text-[11.5px] text-ink-3 shadow-hairline">
        {step.detail ?? ""}
        {step.count > 1 ? <span className="ml-1 tabular-nums">×{step.count}</span> : null}
      </span>
    ) : null;
  // One step: a single line with what it touched, nothing to open.
  if (steps.length === 1) {
    const [step] = steps;
    return (
      <div className="-mt-0.5 flex h-6 min-w-0 items-center gap-2 text-[12.5px]">
        <span className={cn("shrink-0", step.failed ? "text-orange" : "text-ink-3")}>{label(step)}</span>
        {detail(step)}
      </div>
    );
  }
  const summary = copy.steps(total);
  return (
    <div className="-mt-0.5 text-[12.5px]">
      <button
        aria-expanded={open}
        className="-mx-1.5 flex w-fit items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 text-ink-3 transition-colors hover:bg-hover-2 hover:text-ink-2"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ChevronRight aria-hidden="true" className={cn("size-3 transition-transform duration-150", open && "rotate-90")} strokeWidth={2.2} />
        <span>{summary}</span>
        {failed ? <CircleAlert aria-label={copy.stepFailed} className="size-3 text-orange" /> : null}
      </button>
      {open ? (
        <ul className="mt-1 ml-1 flex flex-col gap-0.5 border-l border-line pl-3">
          {steps.map((step) => (
            <li className="flex h-6 min-w-0 items-center gap-2" key={`${step.tool}:${step.failed}`}>
              <span className={cn("shrink-0", step.failed ? "text-orange" : "text-ink-2")}>{label(step)}</span>
              {detail(step)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A link in a reply. A link the chat made to a record opens that page here, in place. Anything else
 * (a link the model or an email wrote) is Streamdown's own, with its link-safety check.
 */
export function ChatLink(props: ComponentProps<"a"> & { node?: unknown }) {
  const { href, children } = props;
  if (href && isRecordLink(href)) {
    return (
      <Link className="font-medium text-ink underline decoration-line-strong underline-offset-2 transition-colors hover:decoration-ink" href={href}>
        {children}
      </Link>
    );
  }
  const Default = defaultComponents.a as ComponentType<typeof props>;
  return <Default {...props} />;
}

/**
 * A quote the reply made or changed, as it is now (`GET /api/quotes/[id]/card`): its priced photo across
 * the top when it has one (or, for a reply that made a post, the `post`), its title, customer, total, and
 * status, a way to open it, and Approve for an owner or admin on a ready draft. Nothing for a quote the
 * viewer can't see.
 */
export function QuoteCard({ quoteId, post, language, readOnly }: { quoteId: string; post?: PostFormat; language: Language; readOnly: boolean }) {
  const copy = copyFor(language).assistant;
  const [quote, setQuote] = useState<QuoteCardData | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/card${post ? `?post=${post}` : ""}`, { cache: "no-store" });
      if (response.ok) setQuote(((await response.json()) as { quote: QuoteCardData }).quote);
    } catch {
      // No card is better than a broken one: the reply's text still says what happened.
    }
  }, [quoteId, post]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!quote) return null;

  const approve = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/quotes/${encodeURIComponent(quote.quoteId)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: quote.revisionNumber }),
      });
      if (!response.ok) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      await load();
      // The page beside the chat (the quote, the Quotes list) shows it approved too.
      router.refresh();
    }
  };

  const top = quote.post
    ? { url: quote.post.url, alt: copy.quotePostAlt, caption: copy.quotePostCaption }
    : quote.pricedPhoto
      ? { url: quote.pricedPhoto.url, alt: copy.quotePricedAlt, caption: copy.quotePricedCaption }
      : null;
  return (
    <article aria-label={quote.title} className="flex max-w-md flex-col gap-2.5 rounded-[12px] bg-surface px-3.5 py-3 shadow-hairline">
      {top ? (
        <figure className="-mx-3.5 -mt-3 flex flex-col gap-1.5">
          <a className="block overflow-hidden rounded-t-[12px] bg-inset" href={top.url} rel="noopener" target="_blank">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
            <img alt={top.alt} className="block h-auto w-full" src={top.url} />
          </a>
          <figcaption className="px-3.5 text-[12px] text-ink-3">{top.caption}</figcaption>
        </figure>
      ) : null}
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{quote.title}</p>
          {quote.customerName ? <p className="truncate text-[12px] text-ink-3">{quote.customerName}</p> : null}
        </div>
        <p className="shrink-0 text-[15px] font-semibold tabular-nums text-ink">{quote.ready ? money(quote.totalCents, language) : "—"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <QuoteStatusPill language={language} status={quote.status} />
        <span className="flex-1" />
        <Link className="rounded-full px-2.5 py-1 text-[12px] font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink" href={`/quotes/${quote.quoteId}`}>
          {copy.quoteOpen}
        </Link>
        {quote.canApprove && !readOnly ? (
          <Button disabled={busy} onClick={() => void approve()} size="sm" type="button" variant="primary">
            {busy ? copy.quoteApproving : copy.quoteApprove}
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p className="text-[12px] text-destructive" role="alert">
          {copy.quoteApproveFailed}
        </p>
      ) : null}
    </article>
  );
}
