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

// The quote page's priced photo: the PNG, and for a member the editor in its place while they fix which
// outline goes with which line. Closing the editor reloads the page so the PNG and its "not found" note
// come back as the server drew them.

/** The PNG's address, changed after an edit so the browser doesn't show the one it cached. */
const busted = (url: string, edit: string | null) => (edit ? `${url}${url.includes("?") ? "&" : "?"}e=${encodeURIComponent(edit)}` : url);

export function PricedPhotoSection({
  quoteId,
  pricedPhoto,
  canPrice,
  canEdit,
  outcome,
  language,
}: {
  quoteId: string;
  pricedPhoto: { id: string; url: string; notLocated: string[] } | null;
  /** A member, on a quote with a photo. */
  canPrice: boolean;
  /** A member, on a quote with a priced photo. */
  canEdit: boolean;
  /** How the last pricing went, from the page's `?priced=`. */
  outcome: string | undefined;
  language: Language;
}) {
  const q = pageCopyFor(language).quotes;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [edit, setEdit] = useState<string | null>(null);

  const actions =
    editing || (!canPrice && !(canEdit && pricedPhoto)) ? null : (
      <div className="flex items-center gap-1.5">
        {canEdit && pricedPhoto ? (
          <Button onClick={() => setEditing(true)} size="sm" type="button" variant="secondary">
            <Pencil aria-hidden="true" className="size-3.5" />
            {q.pricedEdit.edit}
          </Button>
        ) : null}
        {canPrice ? <PricePhotoButton again={pricedPhoto !== null} language={language} quoteId={quoteId} /> : null}
      </div>
    );

  return (
    <Card actions={actions} title={q.pricedPhoto}>
      {outcome && outcome !== "done" && !editing ? (
        <p className="mb-2 text-[13px] text-destructive" role="alert">
          {q.pricedOutcome[outcome] ?? q.pricedOutcome.failed}
        </p>
      ) : null}
      {pricedPhoto && editing ? (
        <PricedPhotoEditor
          language={language}
          onClose={(last) => {
            setEditing(false);
            // Something to tell this PNG from the cached one; a closed editor that changed nothing still asks again.
            setEdit(last?.editedAt ?? String(Date.now()));
            startTransition(() => router.refresh());
          }}
          pricedId={pricedPhoto.id}
          quoteId={quoteId}
        />
      ) : pricedPhoto ? (
        <figure className="space-y-1.5">
          <a className="block overflow-hidden rounded-[8px] bg-inset shadow-hairline transition-opacity hover:opacity-90" href={busted(pricedPhoto.url, edit)} rel="noopener" target="_blank">
            {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route, any size */}
            <img alt={q.pricedAlt} className="block h-auto w-full" src={busted(pricedPhoto.url, edit)} />
          </a>
          <figcaption className="text-[12px] text-ink-3 text-pretty">
            {q.pricedCaption}
            {pricedPhoto.notLocated.length > 0 ? ` ${q.pricedNotLocated(pricedPhoto.notLocated.join(", "))}` : ""}
          </figcaption>
        </figure>
      ) : (
        <p className="text-[13px] text-ink-3">{q.pricedNone}</p>
      )}
    </Card>
  );
}
