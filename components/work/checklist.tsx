"use client";

import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { useState } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { cn } from "@/ui/lib/utils";
import { ErrorLine, useMutation } from "../pages/client-kit";

export type ChecklistRow = { itemId: string; text: string; done: boolean; tickedBy: string | null };

/**
 * The work's checklist, one checkbox per item. Ticking or unticking saves at once and reloads the page,
 * which shows a visit the last tick marked done.
 */
export function ChecklistItems({ jobId, rows, canTick, language }: { jobId: string; rows: ChecklistRow[]; canTick: boolean; language: Language }) {
  const copy = pageCopyFor(language);
  const { send, busy, error } = useMutation(copy.common.failed);
  return (
    <div className="space-y-2">
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.itemId}>
            <label className={cn("flex items-start gap-2.5", canTick && "cursor-pointer")}>
              <input
                checked={row.done}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                disabled={!canTick || busy !== null}
                onChange={(event) =>
                  void send(row.itemId, `/api/work/${encodeURIComponent(jobId)}/checklist`, {
                    method: "PUT",
                    body: { itemIds: [row.itemId], undo: !event.target.checked },
                  })
                }
                type="checkbox"
              />
              <span className="min-w-0">
                <span className={cn("block text-[13px] text-pretty", row.done ? "text-ink-3 line-through" : "text-ink")}>{row.text}</span>
                {row.tickedBy ? <span className="block text-[11px] text-ink-3">{row.tickedBy}</span> : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}

/** Texts the next visit's crew this list and every photo again, as they are now, and says who got it. */
export function ResendToCrewButton({ visitId, language }: { visitId: string; language: Language }) {
  const w = pageCopyFor(language).work;
  const { send, busy, error } = useMutation(pageCopyFor(language).common.failed);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        disabled={busy !== null}
        onClick={async () => {
          setSent(null);
          const result = await send<{ notified: string[] }>("resend", `/api/schedule/visits/${encodeURIComponent(visitId)}/resend`, { method: "POST", refresh: false });
          if (result) setSent(result.notified.length ? w.resentTo(result.notified.join(", ")) : w.resentNobody);
        }}
        size="xs"
        title={w.resendHelp}
      >
        {busy ? w.resending : w.resendToCrew}
      </Button>
      {sent ? <p className="text-[12px] text-ink-3">{sent}</p> : null}
      <ErrorLine>{error}</ErrorLine>
    </div>
  );
}
