import Link from "next/link";
import { Card } from "@/components/pages/kit";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { BeforeAfterOutlines } from "./before-after-outlines";

// A quote's before-and-after, read-only: on the quote page (`outlinedHref`) it opens the image and can
// show the outlines; elsewhere (`quoteHref`) it goes to the quote, where each photo is edited.

export function BeforeAfterCard({
  href,
  outlinedHref,
  quoteHref,
  description,
  language,
}: {
  href: string;
  outlinedHref?: string;
  quoteHref?: string;
  description?: string;
  language: Language;
}) {
  const q = pageCopyFor(language).quotes;
  if (outlinedHref) {
    return (
      <Card description={description} title={q.beforeAfter}>
        <BeforeAfterOutlines href={href} language={language} outlinedHref={outlinedHref} />
      </Card>
    );
  }
  const frame = "block overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90";
  // eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size
  const image = <img alt={q.beforeAfterAlt} className="block h-auto w-full" loading="lazy" src={href} />;
  return (
    <Card description={description} title={q.beforeAfter}>
      <figure className="space-y-1.5">
        {quoteHref ? (
          <Link className={frame} href={quoteHref}>
            {image}
          </Link>
        ) : (
          <a className={frame} href={href} rel="noopener" target="_blank">
            {image}
          </a>
        )}
        {quoteHref ? null : <figcaption className="text-[12px] text-ink-3 text-pretty">{q.beforeAfterCaption}</figcaption>}
      </figure>
    </Card>
  );
}
