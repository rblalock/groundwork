"use client";

import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { useState } from "react";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import type { QuoteOutcome, QuoteStatus } from "@/lib/pages/quotes";
import { ErrorLine, useMutation } from "./client-kit";

/**
 * An owner's or admin's moves on a quote: approve a ready draft (the revision on screen), then mark it
 * sent, won, or lost, or void it. The server applies the same rules as the assistant.
 */
export function QuoteActions({
  quoteId,
  status,
  ready,
  revision,
  language,
}: {
  quoteId: string;
  status: QuoteStatus;
  ready: boolean;
  revision: number;
  language: Language;
}) {
  const copy = pageCopyFor(language);
  const { send, busy, error } = useMutation(copy.common.failed);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const open = status === "draft" || status === "needs_owner";
  const outcome = (value: QuoteOutcome) => send(value, `/api/quotes/${quoteId}/outcome`, { method: "POST", body: { outcome: value } });

  if (status === "void" || status === "won" || status === "lost") return null;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {open && ready ? (
          <Button
            disabled={busy !== null}
            onClick={() => void send("approve", `/api/quotes/${quoteId}/approve`, { method: "POST", body: { revision } })}
            size="sm"
            variant="primary"
          >
            {busy === "approve" ? copy.quotes.approving : copy.quotes.approve}
          </Button>
        ) : null}
        {status === "approved" ? (
          <Button disabled={busy !== null} onClick={() => void outcome("sent")} size="sm" variant="primary">
            {copy.quotes.markSent}
          </Button>
        ) : null}
        {status === "approved" || status === "sent" ? (
          <>
            <Button disabled={busy !== null} onClick={() => void outcome("won")} size="sm">
              {copy.quotes.markWon}
            </Button>
            <Button disabled={busy !== null} onClick={() => void outcome("lost")} size="sm">
              {copy.quotes.markLost}
            </Button>
          </>
        ) : null}
        <Button disabled={busy !== null} onClick={() => setConfirmVoid(true)} size="sm" variant="quiet">
          {copy.quotes.voidQuote}
        </Button>
      </div>
      <ErrorLine>{error}</ErrorLine>
      <Dialog onOpenChange={setConfirmVoid} open={confirmVoid}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{copy.quotes.confirmVoidTitle}</DialogTitle>
          <DialogDescription>{copy.quotes.confirmVoidBody}</DialogDescription>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={busy !== null}
              onClick={async () => {
                await outcome("void");
                setConfirmVoid(false);
              }}
              size="sm"
            >
              {copy.quotes.voidQuote}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
