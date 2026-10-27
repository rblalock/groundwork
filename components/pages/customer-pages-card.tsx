import Link from "next/link";
import { LayoutTemplate } from "lucide-react";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import type { CustomerPageKind } from "@/core/customer-page-template";
import type { CustomerPageState } from "@/core/customer-pages";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { Card } from "./kit";

// The secondary button's look, on a link (the button's helper is client-only).
const LINK_BUTTON =
  "inline-flex h-[27px] shrink-0 items-center gap-1.5 rounded-full bg-surface px-3 text-[13px] leading-none font-medium text-ink shadow-btn transition-colors hover:bg-inset";

/** Settings → Branding: the business's own quote and invoice pages, where each stands, and the way in to design them. */
export function CustomerPagesCard({ states, language, canEdit }: { states: Record<CustomerPageKind, CustomerPageState>; language: Language; canEdit: boolean }) {
  const t = pageCopyFor(language).customerPages;
  return (
    <Card
      flush
      title={
        <span className="flex items-center gap-1.5">
          <LayoutTemplate aria-hidden="true" className="size-3.5 text-ink-3" />
          {t.title}
        </span>
      }
    >
      <ul className="divide-y divide-line">
        {(["quote", "invoice"] as const).map((page) => {
          const { published, latest } = states[page];
          const ahead = latest !== null && latest.version !== published?.version;
          return (
            <li className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" key={page}>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-[13px] font-medium text-ink">{t.pages[page]}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={published ? "green" : "neutral"}>{published ? t.live(published.version) : t.standard}</StatusPill>
                  {ahead ? <span className="text-[12px] text-ink-3">{t.unpublished}</span> : null}
                </div>
              </div>
              {canEdit ? (
                <Link className={LINK_BUTTON} href={`/customer-pages/${page}`}>
                  {latest ? t.edit : t.design}
                </Link>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
