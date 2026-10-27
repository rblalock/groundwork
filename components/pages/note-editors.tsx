"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { Textarea } from "@/ui/components/textarea";
import type { Language } from "@/core/language";
import { pageCopyFor } from "@/lib/page-copy";
import { ErrorLine, Field, inputClass, NativeSelect, useMutation } from "./client-kit";

export type EditableNote = { id: string; title: string; body: string; tags: string[]; revision: number; propertyId: string | null };
export type NoteCustomer = { id: string; name: string; properties: Array<{ id: string; address: string }> };
export type NoteQuote = { id: string; title: string };

/** Kept files from the web: PDFs and photos up to 4 MB (the server checks the bytes too). */
const FILE_TYPES = "application/pdf,image/jpeg,image/png";
const FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Adds a note, or edits one: a title, the text, tags, and a file to keep on it. With `customer`, the note
 * goes on that customer and can be put on one of their places; with `quote`, a new note goes on that
 * quote; without either, a new note is business-wide.
 */
export function NoteEditor({
  language,
  note,
  customer,
  quote,
  trigger = "button",
}: {
  language: Language;
  note?: EditableNote;
  customer?: NoteCustomer;
  quote?: NoteQuote;
  trigger?: "button" | "quiet";
}) {
  const copy = pageCopyFor(language);
  const n = copy.notes;
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // A new note saved whose file then didn't go through: trying again changes that note, not a second one.
  const [createdId, setCreatedId] = useState<string | null>(null);
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    const upload = file instanceof File && file.size > 0 ? file : null;
    if (upload && upload.size > FILE_MAX_BYTES) return setError(n.errors.fileSize);
    const tags = String(form.get("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const place = form.get("propertyId") === null ? undefined : String(form.get("propertyId")) || null;
    // A new note goes on the customer; an edit moves it only when its place was changed.
    const moves = customer && (!note || (place !== undefined && place !== note.propertyId));
    const body = {
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      tags,
      ...(moves ? { customerId: customer.id, propertyId: place ?? null } : {}),
      ...(quote && !note ? { quoteId: quote.id } : {}),
      ...(note ? { expectedRevision: note.revision } : {}),
    };
    const target = note?.id ?? createdId;
    const saved = await send<{ note: { id: string } }>("save", target ? `/api/notes/${target}` : "/api/notes", { method: target ? "PATCH" : "POST", body });
    if (!saved) return;
    if (!note) setCreatedId(saved.note.id);
    if (upload) {
      setUploading(true);
      try {
        const data = new FormData();
        data.append("file", upload);
        const response = await fetch(`/api/notes/${saved.note.id}/files`, { method: "POST", body: data });
        if (!response.ok) {
          const reason = (await response.json().catch(() => null)) as { error?: string } | null;
          setError(reason?.error ?? n.errors.fileFailed);
          return;
        }
        router.refresh();
      } catch {
        setError(n.errors.fileFailed);
        return;
      } finally {
        setUploading(false);
      }
    }
    setOpen(false);
    setCreatedId(null);
  }

  return (
    <>
      {note ? (
        <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
          {n.edit}
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)} size="xs" variant={trigger === "quiet" ? "quiet" : "secondary"}>
          <Plus aria-hidden="true" className="size-3.5" /> {n.add}
        </Button>
      )}
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setError(undefined);
            setCreatedId(null);
          }
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogTitle>{note ? n.editTitle : quote ? n.newSiteTitle(quote.title) : customer ? n.newSiteTitle(customer.name) : n.newTitle}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <Field autoComplete="off" defaultValue={note?.title ?? ""} id="title" label={n.titleField} maxLength={160} required />
            <Field id="body" label={n.bodyField}>
              <Textarea defaultValue={note?.body ?? ""} id="body" name="body" rows={6} />
            </Field>
            {customer && customer.properties.length > 0 ? (
              <Field id="propertyId" label={n.placeField}>
                <NativeSelect defaultValue={note?.propertyId ?? ""} id="propertyId" name="propertyId">
                  <option value="">{n.anyPlace}</option>
                  {customer.properties.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.address}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
            <Field autoComplete="off" defaultValue={note?.tags.join(", ") ?? ""} hint={n.tagsHint} id="tags" label={n.tagsField} />
            <Field id="file" label={n.file}>
              <input accept={FILE_TYPES} className={`${inputClass} h-auto py-1.5 file:mr-2 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-ink`} id="file" name="file" type="file" />
            </Field>
            <ErrorLine>{error}</ErrorLine>
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null || uploading} size="sm" type="submit" variant="primary">
                {busy || uploading ? copy.common.saving : copy.common.save}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Archives a note, after asking. */
export function ArchiveNoteButton({ note, language }: { note: { id: string; title: string; revision: number }; language: Language }) {
  const copy = pageCopyFor(language);
  const n = copy.notes;
  const [open, setOpen] = useState(false);
  const { send, busy, error } = useMutation(copy.common.failed);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {n.archive}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{n.archiveTitle(note.title)}</DialogTitle>
          <DialogDescription>{n.archiveBody}</DialogDescription>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                if (await send("archive", `/api/notes/${note.id}`, { method: "PATCH", body: { archived: true, expectedRevision: note.revision } })) setOpen(false);
              }}
              size="sm"
              variant="primary"
            >
              {n.archive}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
