"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import type { BusinessRow } from "@/lib/admin";

/** A super admin's fixes to one business from the Businesses list: rename, the owner's number, the inbox. */
export type ManageAction = "rename" | "phone" | "inbox";

type Props = {
  action: ManageAction | null;
  business: BusinessRow | null;
  onClose: () => void;
  /** After a change: what to tell the super admin, if anything. */
  onDone: (notice: string | null) => void;
};

async function send(url: string, method: string, body?: unknown): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as (Record<string, unknown> & { error?: string }) | null;
  if (!response.ok) return { ok: false, error: data?.error ?? "Couldn't save that. Try again." };
  return { ok: true, data: data ?? {} };
}

export function ManageDialogs({ action, business, onClose, onDone }: Props) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const open = action !== null && business !== null;

  async function run(url: string, method: string, body: unknown, notice: (data: Record<string, unknown>) => string | null) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await send(url, method, body);
      if (!result.ok) return setError(result.error);
      onDone(notice(result.data));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!business) return;
    const form = Object.fromEntries(new FormData(event.currentTarget).entries()) as Record<string, string>;
    if (action === "rename") {
      void run(`/api/admin/businesses/${business.id}`, "PATCH", { name: form.name, slug: form.slug }, () => null);
    } else if (action === "phone" && business.ownerId && business.ownerPhone) {
      void run(`/api/admin/businesses/${business.id}/phone`, "POST", { memberId: business.ownerId, from: business.ownerPhone, to: form.phone }, (data) => {
        const phone = data.phone as { e164: string; assignedLine: string };
        return `Tell ${business.ownerName ?? "the owner"} to text ${phone.assignedLine} from ${phone.e164}. Their first text activates the new number.`;
      });
    } else if (action === "inbox") {
      void run(`/api/admin/businesses/${business.id}/inbox`, "DELETE", undefined, () => null);
    }
  }

  const title =
    action === "rename" ? `Rename ${business?.name ?? ""}` : action === "phone" ? `Change ${business?.ownerName ?? "the owner"}'s number` : `Remove ${business?.inboxAddress ?? "the inbox"}?`;

  return (
    <Dialog onOpenChange={(next) => { if (!next && !busy) { setError(undefined); onClose(); } }} open={open}>
      <DialogContent showCloseButton={false}>
        <form className="grid gap-4" key={`${action}-${business?.id}`} onSubmit={submit}>
          <DialogTitle>{title}</DialogTitle>
          {action === "rename" && business ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="rename-name">Business name</Label>
                <Input autoComplete="off" defaultValue={business.name} id="rename-name" maxLength={120} name="name" required />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="rename-slug">Slug</Label>
                <Input autoComplete="off" defaultValue={business.slug} id="rename-slug" name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" required />
              </div>
            </>
          ) : null}
          {action === "phone" && business ? (
            <>
              <DialogDescription>
                Now <span className="font-mono">{business.ownerPhone}</span>. The old number stops reaching the assistant.
              </DialogDescription>
              <div className="grid gap-2">
                <Label htmlFor="phone-new">New cell</Label>
                <Input autoComplete="off" id="phone-new" inputMode="tel" name="phone" placeholder="(555) 555-0142" required type="tel" />
              </div>
            </>
          ) : null}
          {action === "inbox" ? <DialogDescription>Its mail is deleted, and forwarded emails stop until you make another.</DialogDescription> : null}
          {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
          <DialogFooter>
            <DialogClose disabled={busy} render={<Button size="sm" type="button" variant="quiet" />}>Cancel</DialogClose>
            <Button
              className={action === "inbox" ? "bg-red text-white hover:opacity-90" : undefined}
              disabled={busy}
              size="sm"
              type="submit"
              variant={action === "inbox" ? undefined : "primary"}
            >
              {busy ? "Saving…" : action === "inbox" ? "Remove inbox" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
