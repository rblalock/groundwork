"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { ErrorLine, useMutation } from "../pages/client-kit";

type Photo = { id: string; description: string | null; onPdf: boolean };

/**
 * The work's photos on its invoice: tapping one puts it on the PDF or takes it off, up to `limit`.
 * Read-only (`canChoose` false) shows only which are on it.
 */
export function InvoicePhotos({
  invoiceId,
  jobId,
  photos,
  limit,
  canChoose,
  language,
}: {
  invoiceId: string;
  jobId: string;
  photos: Photo[];
  limit: number;
  canChoose: boolean;
  language: Language;
}) {
  const copy = pageCopyFor(language);
  const t = copy.invoices;
  const { send, busy, error } = useMutation(copy.common.failed);
  // Shown at once; the page refresh after the save brings the server's choice back.
  const [chosen, setChosen] = useState(() => new Set(photos.filter((p) => p.onPdf).map((p) => p.id)));
  const full = chosen.size >= limit;

  const toggle = async (photoId: string) => {
    const before = chosen;
    const next = new Set(chosen);
    if (next.has(photoId)) next.delete(photoId);
    else next.add(photoId);
    setChosen(next);
    const saved = await send("photos", `/api/invoices/${encodeURIComponent(invoiceId)}/photos`, {
      method: "PUT",
      body: { photoIds: photos.filter((p) => next.has(p.id)).map((p) => p.id) },
    });
    if (!saved) setChosen(before);
  };

  return (
    <div className="space-y-2">
      <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
        {photos.map((photo, index) => {
          const on = chosen.has(photo.id);
          const src = `/api/work/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(photo.id)}`;
          const image = (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
              <img
                alt={photo.description ?? copy.work.photoAlt(index + 1)}
                className={`size-full object-cover transition-opacity ${on ? "" : "opacity-55"}`}
                loading="lazy"
                src={src}
              />
              {on ? (
                <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-[11px] font-medium text-white shadow-hairline">
                  <Check aria-hidden="true" className="size-3" />
                  {t.onPdf}
                </span>
              ) : null}
            </>
          );
          const frame = `relative block aspect-square w-full overflow-hidden rounded-[8px] bg-inset shadow-hairline ${on ? "ring-2 ring-accent" : ""}`;
          return (
            <li className="min-w-0" key={photo.id}>
              {canChoose ? (
                <button
                  aria-label={on ? t.takeOffPdf(index + 1) : t.putOnPdf(index + 1)}
                  aria-pressed={on}
                  className={`${frame} cursor-pointer outline-offset-2 transition-shadow disabled:cursor-not-allowed`}
                  disabled={busy !== null || (!on && full)}
                  onClick={() => void toggle(photo.id)}
                  title={photo.description ?? undefined}
                  type="button"
                >
                  {image}
                </button>
              ) : (
                <div className={frame} title={photo.description ?? undefined}>
                  {image}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}
