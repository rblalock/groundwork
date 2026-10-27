"use client";

import { useState } from "react";
import { Spinner } from "@/components/spinner";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";

/**
 * Prices the quote's latest photo (`POST /api/quotes/[id]/priced`), a plain form post that comes back to
 * the page. Pricing takes a few seconds, so the button says so until the page returns.
 */
export function PricePhotoButton({ quoteId, again, language }: { quoteId: string; again: boolean; language: Language }) {
  const q = pageCopyFor(language).quotes;
  const [busy, setBusy] = useState(false);
  return (
    <form action={`/api/quotes/${encodeURIComponent(quoteId)}/priced`} method="post" onSubmit={() => setBusy(true)}>
      <Button disabled={busy} size="sm" type="submit" variant={again ? "secondary" : "primary"}>
        {busy ? (
          <>
            <Spinner variant="saving" />
            {q.pricingPhoto}
          </>
        ) : again ? (
          q.priceAgain
        ) : (
          q.pricePhoto
        )}
      </Button>
    </form>
  );
}
