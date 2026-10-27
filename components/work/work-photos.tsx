"use client";

import { ImagePlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { Language } from "@/core/language";
import { Spinner } from "@/components/spinner";
import { pageCopyFor } from "@/lib/page-copy";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { ErrorLine, useMutation } from "../pages/client-kit";

/**
 * "Add photos" on a piece of work: picks one or more photos and uploads them one at a time (each its own
 * request, under Vercel's body limit), on `visitId` when given, then reloads the page to show them.
 */
export function AddWorkPhotosButton({ jobId, visitId, language }: { jobId: string; visitId: string | null; language: Language }) {
  const copy = pageCopyFor(language);
  const w = copy.work;
  const errors = copy.quotes.errors;
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: File[]) => {
    setError(null);
    let uploaded = 0;
    for (const [index, file] of files.entries()) {
      setProgress({ done: index, total: files.length });
      const form = new FormData();
      form.append("file", file);
      if (visitId) form.append("visitId", visitId);
      try {
        const response = await fetch(`/api/work/${encodeURIComponent(jobId)}/photos`, { method: "POST", body: form });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(response.status === 413 ? errors.photoSize : (body?.error ?? errors.photoFailed));
          break;
        }
        uploaded++;
      } catch {
        setError(errors.photoFailed);
        break;
      }
    }
    setProgress(null);
    if (input.current) input.current.value = "";
    if (uploaded > 0) router.refresh();
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
        className="sr-only"
        multiple
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) void upload(files);
        }}
        ref={input}
        tabIndex={-1}
        type="file"
      />
      <Button disabled={progress !== null} onClick={() => input.current?.click()} size="sm" type="button" variant="quiet">
        {progress ? <Spinner size={12} /> : <ImagePlus aria-hidden="true" className="size-3.5" />}
        {progress ? w.uploading(progress.done, progress.total) : w.addPhotos}
      </Button>
      {error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Takes one photo off the work, after a confirm. */
export function RemoveWorkPhotoButton({ jobId, photoId, label, language }: { jobId: string; photoId: string; label: string; language: Language }) {
  const copy = pageCopyFor(language);
  const { send, busy, error } = useMutation(copy.common.failed);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={label}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-surface/90 text-ink-2 shadow-hairline transition-colors hover:text-ink"
        onClick={() => setOpen(true)}
        title={label}
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{copy.work.takeOffTitle}</DialogTitle>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={busy !== null}
              onClick={async () => {
                if (await send("remove", `/api/work/${encodeURIComponent(jobId)}/photos/${encodeURIComponent(photoId)}`, { method: "DELETE" })) setOpen(false);
              }}
              size="sm"
            >
              {copy.work.takeOff}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
