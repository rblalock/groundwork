"use client";

import { useState } from "react";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";

// The quote page's before-and-after: plain photos, and a toggle that swaps in the copy with each quoted
// line outlined on both.

export function BeforeAfterOutlines({ href, outlinedHref, language }: { href: string; outlinedHref: string; language: Language }) {
  const q = pageCopyFor(language).quotes;
  const [outlines, setOutlines] = useState(false);
  const src = outlines ? outlinedHref : href;
  return (
    <figure className="space-y-1.5">
      <a className="block overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90" href={src} rel="noopener" target="_blank">
        {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
        <img alt={outlines ? q.beforeAfterOutlinedAlt : q.beforeAfterAlt} className="block h-auto w-full" src={src} />
      </a>
      <figcaption className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1.5 text-[12px] text-ink-3">
        <span className="text-pretty">{q.beforeAfterCaption}</span>
        <label className="flex shrink-0 items-center gap-1.5 text-[13px] text-ink">
          <input checked={outlines} className="size-4 accent-[var(--color-ink)]" onChange={(event) => setOutlines(event.target.checked)} type="checkbox" />
          {q.showOutlines}
        </label>
      </figcaption>
    </figure>
  );
}
