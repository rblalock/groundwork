"use client";

import { Check, Copy, Download, Share2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorLine } from "@/components/pages/client-kit";
import { Card } from "@/components/pages/kit";
import type { Language } from "@/core/language";
import type { PostFormat } from "@/core/social-post";
import { pageCopyFor } from "@/lib/page-copy";
import { Button, buttonVariants } from "@/ui/beautiful/atoms/Button";
import { SegmentedControl } from "@/ui/beautiful/atoms/SegmentedControl";
import { Textarea } from "@/ui/components/textarea";

// The quote page's social post: a Share button under the before-and-after that opens the post in either
// format, its caption to edit, and ways to take it away: download, copy the caption, or the phone's own
// share sheet when the browser can share a file. A business with no phone or email has no line asking for
// the next job, so the panel says where to add one instead of offering it.

type Variants = { withCta: string; withoutCta: string };

export function SocialPostPanel({
  images,
  captions,
  ctaAvailable,
  language,
}: {
  images: Record<PostFormat, Variants>;
  captions: Variants;
  ctaAvailable: boolean;
  language: Language;
}) {
  const p = pageCopyFor(language).quotes.socialPost;
  const [open, setOpen] = useState(false);
  const [format, setFormat] = useState<PostFormat>("square");
  const [cta, setCta] = useState(ctaAvailable);
  const [caption, setCaption] = useState(ctaAvailable ? captions.withCta : captions.withoutCta);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string>();
  // The PNG for the share sheet, fetched ahead so sharing happens in the tap itself (Safari refuses
  // a share that waits on a download), and only offered when the browser can share it.
  const [file, setFile] = useState<{ src: string; file: File } | null>(null);
  const src = images[format][cta ? "withCta" : "withoutCta"];
  const filename = `before-after-${format}.png`;

  useEffect(() => {
    if (!open || typeof navigator.canShare !== "function") return;
    let live = true;
    fetch(src)
      .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
      .then((blob) => {
        const ready = new File([blob], filename, { type: "image/png" });
        if (live && navigator.canShare({ files: [ready] })) setFile({ src, file: ready });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, src, filename]);

  function chooseCta(next: boolean) {
    setCta(next);
    // An untouched caption follows the checkbox; one the member wrote stays theirs.
    if (caption === (next ? captions.withoutCta : captions.withCta)) setCaption(next ? captions.withCta : captions.withoutCta);
  }

  async function share(ready: File) {
    setError(undefined);
    try {
      await navigator.share({ files: [ready], text: caption });
    } catch (failure) {
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(p.shareFailed);
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="sm" type="button">
        <Share2 aria-hidden="true" className="size-3.5" />
        {p.share}
      </Button>
    );
  }

  const formats = { [p.square]: "square", [p.story]: "story" } as Record<string, PostFormat>;
  const ready = file?.src === src ? file.file : null;
  return (
    <Card
      actions={
        <Button onClick={() => setOpen(false)} size="sm" type="button" variant="quiet">
          {p.close}
        </Button>
      }
      description={p.help}
      title={p.title}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <SegmentedControl onChange={(label) => setFormat(formats[label])} options={[p.square, p.story] as const} value={format === "square" ? p.square : p.story} />
          {ctaAvailable ? (
            <label className="flex items-center gap-1.5 text-[13px] text-ink">
              <input checked={cta} className="size-4 accent-[var(--color-ink)]" onChange={(event) => chooseCta(event.target.checked)} type="checkbox" />
              {p.cta}
            </label>
          ) : (
            <p className="text-[12px] text-ink-3 text-pretty">
              {p.ctaNone.lead}
              <Link className="text-ink-2 underline decoration-line-strong underline-offset-2 transition-colors hover:text-ink hover:decoration-ink" href="/settings">
                {p.ctaNone.link}
              </Link>
              {p.ctaNone.rest}
            </p>
          )}
        </div>
        <div className="flex justify-center overflow-hidden rounded-[8px] bg-inset shadow-hairline">
          {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
          <img alt={p.alt} className="block h-auto max-h-[480px] w-auto max-w-full" src={src} />
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-ink-2">{p.caption}</span>
          <Textarea onChange={(event) => setCaption(event.target.value)} rows={3} value={caption} />
        </label>
        <div className="flex flex-wrap items-center gap-1.5">
          <a className={buttonVariants({ size: "sm" })} download={filename} href={src}>
            <Download aria-hidden="true" className="size-3.5" />
            {p.download}
          </a>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(caption).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            }}
            size="sm"
            type="button"
          >
            {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
            {copied ? p.copied : p.copyCaption}
          </Button>
          {ready ? (
            <Button onClick={() => share(ready)} size="sm" type="button" variant="primary">
              <Share2 aria-hidden="true" className="size-3.5" />
              {p.share}
            </Button>
          ) : null}
        </div>
        <ErrorLine>{error}</ErrorLine>
      </div>
    </Card>
  );
}
