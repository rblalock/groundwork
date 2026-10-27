"use client";

import type { JobStatus } from "@/core/jobs";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";
import { ErrorLine, useMutation } from "./client-kit";

/** The member's moves on their own job: mark it done, reopen it, or archive it. */
export function JobActions({ jobId, status, language }: { jobId: string; status: JobStatus; language: Language }) {
  const copy = pageCopyFor(language);
  const { send, busy, error } = useMutation(copy.common.failed);
  const set = (next: "done" | "active" | "archived") => send(next, `/api/jobs/${jobId}`, { method: "POST", body: { status: next } });
  const open = status === "active" || status === "failed" || status === "running";
  return (
    <div className="flex items-center gap-2">
      <ErrorLine>{error}</ErrorLine>
      {open ? (
        <Button disabled={busy !== null || status === "running"} onClick={() => void set("done")} size="sm">
          {copy.jobs.markDone}
        </Button>
      ) : (
        <Button disabled={busy !== null} onClick={() => void set("active")} size="sm">
          {copy.jobs.reopen}
        </Button>
      )}
      {status !== "archived" ? (
        <Button disabled={busy !== null || status === "running"} onClick={() => void set("archived")} size="sm" variant="quiet">
          {copy.jobs.archive}
        </Button>
      ) : null}
    </div>
  );
}
