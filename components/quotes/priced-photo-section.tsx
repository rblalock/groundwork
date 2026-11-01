"use client";

import { Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Card } from "@/components/pages/kit";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";
import { PricePhotoButton } from "./price-photo-button";
import { PricedPhotoEditor } from "./priced-photo-editor";

// The quote page's priced photos: each PNG, numbered in attachment order when there are several, and for
// a member the editor in place of the one they're fixing (which outline goes with which line), each photo
// edited on its own. Closing the editor reloads the page so the PNGs and their "not found" notes come
// back as the server drew them (another photo's legend may change with this one). A link from the chat's
// quote card or the price guide (`?edit=`) opens the editor on the photo it named.

/** The PNG's address, changed after an edit so the browser doesn't show the one it cached. */
const busted = (url: string, edit: string | null) => (edit ? `${url}${url.includes("?") ? "&" : "?"}e=${encodeURIComponent(edit)}` : url);

export type PricedPhotoTile = { id: string; url: string; number: number | null; notLocated: string[] };

export function PricedPhotoSection({
  quoteId,
  pricedPhotos,
  canPrice,
  canEdit,
  editId,
  outcome,
  language,
}: {
  quoteId: string;
  /** The quote's priced photos, in the order the page shows them. */
  pricedPhotos: PricedPhotoTile[];
  /** A member, on a quote with a photo. */
  canPrice: boolean;
  /** A member, on a quote with a priced photo. */
  canEdit: boolean;
  /** One of the quote's priced photos to open the editor on, from the page's `?edit=`. */
  editId?: string;
  /** How the last pricing went, from the page's `?priced=`. */
  outcome: string | undefined;
  language: Language;
}) {
  const q = pageCopyFor(language).quotes;
  const router = useRouter();
  const [, startTransition] = useTransition();
  // The priced photo being edited, if any.
  const [editing, setEditing] = useState<string | null>(() => (canEdit && editId && pricedPhotos.some((photo) => photo.id === editId) ? editId : null));
  const [edit, setEdit] = useState<string | null>(null);

  const actions = editing || !canPrice ? null : <PricePhotoButton again={pricedPhotos.length > 0} language={language} quoteId={quoteId} />;

  return (
    <Card actions={actions} title={pricedPhotos.length > 1 ? q.pricedPhotos : q.pricedPhoto}>
      {outcome && outcome !== "done" && !editing ? (
        <p className="mb-2 text-[13px] text-destructive" role="alert">
          {q.pricedOutcome[outcome] ?? q.pricedOutcome.failed}
        </p>
      ) : null}
      {pricedPhotos.length === 0 ? (
        <p className="text-[13px] text-ink-3">{q.pricedNone}</p>
      ) : (
        <div className="space-y-5">
          {pricedPhotos.map((photo) =>
            editing === photo.id ? (
              <PricedPhotoEditor
                key={photo.id}
                language={language}
                onClose={(last) => {
                  setEditing(null);
                  // Reloaded, the page shouldn't open the editor again.
                  if (editId) window.history.replaceState(null, "", `${window.location.pathname}#priced-photo`);
                  // Something to tell this PNG from the cached one; a closed editor that changed nothing still asks again.
                  setEdit(last?.editedAt ?? String(Date.now()));
                  startTransition(() => router.refresh());
                }}
                pricedId={photo.id}
                quoteId={quoteId}
              />
            ) : (
              <figure className="space-y-1.5" key={photo.id}>
                <a className="block overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90" href={busted(photo.url, edit)} rel="noopener" target="_blank">
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
                  <img alt={photo.number ? q.pricedNumberAlt(photo.number) : q.pricedAlt} className="block h-auto w-full" src={busted(photo.url, edit)} />
                </a>
                <figcaption className="flex items-start justify-between gap-3">
                  <span className="text-[12px] text-ink-3 text-pretty">
                    {photo.number ? <span className="font-medium text-ink-2">{q.pricedNumber(photo.number)} · </span> : null}
                    {q.pricedCaption}
                    {photo.notLocated.length > 0 ? ` ${(photo.number ? q.pricedNotLocatedAny : q.pricedNotLocated)(photo.notLocated.join(", "))}` : ""}
                  </span>
                  {canEdit && !editing ? (
                    <Button className="shrink-0" onClick={() => setEditing(photo.id)} size="sm" type="button" variant="secondary">
                      <Pencil aria-hidden="true" className="size-3.5" />
                      {q.pricedEdit.edit}
                    </Button>
                  ) : null}
                </figcaption>
              </figure>
            ),
          )}
        </div>
      )}
    </Card>
  );
}
