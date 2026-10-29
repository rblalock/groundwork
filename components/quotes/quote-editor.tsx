"use client";

import { ImagePlus, Pencil, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { Spinner } from "@/components/spinner";
import type { Language } from "@/core/language";
import { parseMoneyToCents } from "@/core/money";
import { pageCopyFor } from "@/lib/page-copy";
import type { EditorItem } from "@/lib/pages/quote-editor";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { Textarea } from "@/ui/components/textarea";
import { ErrorLine, Field, inputClass, NativeSelect, useMutation } from "../pages/client-kit";

// Editing a quote on its page (lib/pages/quote-editor.ts): its lines and its notes for the customer in a
// dialog like the invoice line editor, and adding or taking off photos. Each save is a new revision of the one
// on screen; the server prices it the same way the assistant's revisions are priced.

type Line = { itemId: string | null; name: string; unitLabel: string; quantity: number; unitCents: number | null };

type Row = { key: number; itemId: string; name: string; unitLabel: string; quantity: string; price: string };

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(/\.00$/, ""));
const blank = (key: number): Row => ({ key, itemId: "", name: "", unitLabel: "", quantity: "1", price: "" });
const reapproves = (status: string) => status === "approved" || status === "sent";

export function EditQuoteButton({
  quoteId,
  revision,
  status,
  lines,
  customerNotes,
  items,
  language,
}: {
  quoteId: string;
  revision: number;
  status: string;
  lines: Line[];
  customerNotes: string | null;
  items: EditorItem[];
  language: Language;
}) {
  const [open, setOpen] = useState(false);
  const e = pageCopyFor(language).quotes.edit;
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" type="button" variant="quiet">
        <Pencil aria-hidden="true" className="size-3.5" />
        {e.open}
      </Button>
      {open ? (
        <EditQuoteDialog
          customerNotes={customerNotes}
          items={items}
          language={language}
          lines={lines}
          onClose={() => setOpen(false)}
          quoteId={quoteId}
          revision={revision}
          status={status}
        />
      ) : null}
    </>
  );
}

function EditQuoteDialog({
  quoteId,
  revision,
  status,
  lines,
  customerNotes,
  items,
  language,
  onClose,
}: {
  quoteId: string;
  revision: number;
  status: string;
  lines: Line[];
  customerNotes: string | null;
  items: EditorItem[];
  language: Language;
  onClose: () => void;
}) {
  const copy = pageCopyFor(language);
  const e = copy.quotes.edit;
  const errors = copy.quotes.errors;
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const active = new Map(items.map((item) => [item.id, item]));
  // A line whose item has since left the price book is kept as a custom line at its price.
  const [rows, setRows] = useState<Row[]>(() =>
    lines.length
      ? lines.map((line, key) => ({
          key,
          itemId: line.itemId && active.has(line.itemId) ? line.itemId : "",
          name: line.name,
          unitLabel: line.unitLabel,
          quantity: String(line.quantity),
          price: dollars(line.unitCents),
        }))
      : [blank(0)],
  );
  const update = (key: number, patch: Partial<Row>) => setRows((all) => all.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const pick = (key: number, itemId: string) => {
    const item = active.get(itemId);
    update(key, item ? { itemId, name: item.name, unitLabel: item.unitLabel, price: dollars(item.priceCents) } : { itemId: "" });
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const out = [];
    for (const row of rows) {
      const quantity = Number(row.quantity);
      if (!Number.isFinite(quantity) || quantity <= 0) return setError(errors.lineQuantity);
      const unitCents = row.price.trim() ? parseMoneyToCents(row.price) : null;
      if (row.price.trim() && unitCents === null) return setError(errors.linePrice);
      if (row.itemId) {
        // What's on screen is what's saved: a price changed from the item's saved one is set for this quote.
        out.push({ itemId: row.itemId, name: row.name.trim() || undefined, quantity, ...(unitCents !== null ? { unitCents } : {}) });
      } else {
        if (!row.name.trim()) return setError(errors.lineName);
        out.push({ name: row.name.trim(), unitLabel: row.unitLabel.trim(), quantity, ...(unitCents !== null ? { unitCents } : {}) });
      }
    }
    const notes = String(new FormData(event.currentTarget).get("customerNotes") ?? "");
    const saved = await send("save", `/api/quotes/${quoteId}`, { method: "PATCH", body: { revision, lines: out, customerNotes: notes } });
    if (saved) onClose();
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>{e.title}</DialogTitle>
        {reapproves(status) ? <DialogDescription>{e.reapprove}</DialogDescription> : null}
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <div className="hidden grid-cols-[10rem_minmax(0,1fr)_4.5rem_5rem_6rem_2rem] gap-2 text-[12px] text-ink-3 sm:grid">
              <span>{e.item}</span>
              <span>{e.name}</span>
              <span>{e.qty}</span>
              <span>{e.unit}</span>
              <span>{e.price}</span>
              <span />
            </div>
            {rows.map((row) => (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_4.5rem_5rem_6rem_2rem]" key={row.key}>
                <NativeSelect aria-label={e.item} className="col-span-2 sm:col-span-1" onChange={(event) => pick(row.key, event.target.value)} value={row.itemId}>
                  <option value="">{e.custom}</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </NativeSelect>
                <input aria-label={e.name} className={`${inputClass} col-span-2 sm:col-span-1`} onChange={(event) => update(row.key, { name: event.target.value })} value={row.name} />
                <input aria-label={e.qty} className={inputClass} inputMode="decimal" onChange={(event) => update(row.key, { quantity: event.target.value })} value={row.quantity} />
                <input
                  aria-label={e.unit}
                  className={inputClass}
                  disabled={row.itemId !== ""}
                  onChange={(event) => update(row.key, { unitLabel: event.target.value })}
                  value={row.unitLabel}
                />
                <input aria-label={e.price} className={inputClass} inputMode="decimal" onChange={(event) => update(row.key, { price: event.target.value })} placeholder="0.00" value={row.price} />
                <Button
                  aria-label={e.removeLine}
                  disabled={rows.length === 1}
                  onClick={() => setRows((all) => all.filter((r) => r.key !== row.key))}
                  size="sm"
                  type="button"
                  variant="quiet"
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </Button>
              </div>
            ))}
            <div>
              <Button onClick={() => setRows((all) => [...all, blank(Math.max(-1, ...all.map((r) => r.key)) + 1)])} size="xs" type="button">
                <Plus aria-hidden="true" className="size-3.5" />
                {e.addLine}
              </Button>
            </div>
          </div>
          <Field id="customerNotes" label={e.notes}>
            <Textarea defaultValue={customerNotes ?? ""} id="customerNotes" name="customerNotes" rows={3} />
          </Field>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
              {busy ? copy.common.saving : e.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** An X on a photo: takes it off the quote and its PDF, as a new revision of the one on screen. */
export function RemovePhotoButton({ quoteId, photoId, revision, status, language }: { quoteId: string; photoId: string; revision: number; status: string; language: Language }) {
  const copy = pageCopyFor(language);
  const e = copy.quotes.edit;
  const { send, busy, error } = useMutation(copy.common.failed);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        aria-label={e.removePhoto}
        className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-surface/90 text-ink-2 shadow-hairline transition-colors hover:text-ink"
        onClick={() => setOpen(true)}
        title={e.removePhoto}
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{e.removePhotoTitle}</DialogTitle>
          {reapproves(status) ? <DialogDescription>{e.reapprove}</DialogDescription> : null}
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={busy !== null}
              onClick={async () => {
                if (await send("remove", `/api/quotes/${quoteId}`, { method: "PATCH", body: { revision, removePhotoIds: [photoId] } })) setOpen(false);
              }}
              size="sm"
            >
              {e.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type PhotoErrors = { photoSize: string; photoType: string; photoLimit: string; photoFailed: string };

/** What went wrong with an upload, in the member's words: the route's own message, or a plain failure. */
async function uploadError(response: Response, errors: PhotoErrors): Promise<string> {
  if (response.status === 413) return errors.photoSize;
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? errors.photoFailed;
}

/**
 * "Add photos" on the Photos card: picks one or more photos and uploads them one at a time (each its own
 * request, under Vercel's body limit), each a new revision, then reloads the page to show them.
 */
export function AddPhotosButton({ quoteId, language }: { quoteId: string; language: Language }) {
  const copy = pageCopyFor(language);
  const e = copy.quotes.edit;
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
      try {
        const response = await fetch(`/api/quotes/${encodeURIComponent(quoteId)}/photos`, { method: "POST", body: form });
        if (!response.ok) {
          setError(await uploadError(response, errors));
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
    <div className="relative flex flex-col items-end gap-1">
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
        {progress ? e.uploading(progress.done + 1, progress.total) : e.addPhotos}
      </Button>
      {error ? (
        <p className="text-[12px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
