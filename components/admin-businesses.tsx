"use client";

import { Check, ChevronDown, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { StatusPill } from "@/ui/beautiful/atoms/StatusPill";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/ui/components/dropdown-menu";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import type { BusinessRow } from "@/lib/admin";
import { ManageDialogs, type ManageAction } from "./admin-manage-dialogs";

const TIME_ZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Puerto_Rico",
];

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

type Footprint = {
  name: string;
  records: number;
  members: number;
  phones: string[];
  inboxAddress: string | null;
  stripe: string | null;
  files: number;
  signIns: number;
};

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

type Created = { business: { id: string; name: string; slug: string }; owner: { name: string; phone: string }; line: string };

function Field({ id, label, hint, ...props }: { id: string; label: string; hint?: string } & React.ComponentProps<"input">) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={id} {...props} />
      {hint ? <p className="text-[12px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

/** The super admins' businesses: the list, opening one, and setting up a new one after a sales call. */
export function AdminBusinesses({ businesses, activeBusinessId }: { businesses: BusinessRow[]; activeBusinessId: string | null }) {
  const router = useRouter();
  const [formOpen, setFormOpen] = useState(businesses.length === 0);
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Created>();
  const [opening, setOpening] = useState<string>();
  const [pausing, setPausing] = useState<BusinessRow | null>(null);
  const [pauseError, setPauseError] = useState<string>();
  const [pauseBusy, setPauseBusy] = useState(false);
  const [makingInbox, setMakingInbox] = useState<string>();
  const [inboxError, setInboxError] = useState<{ id: string; message: string }>();
  const [removing, setRemoving] = useState<BusinessRow | null>(null);
  const [footprint, setFootprint] = useState<Footprint>();
  const [confirmName, setConfirmName] = useState("");
  const [removeError, setRemoveError] = useState<string>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removed, setRemoved] = useState<string>();
  const [managing, setManaging] = useState<{ action: ManageAction; business: BusinessRow } | null>(null);
  const [notice, setNotice] = useState<string>();

  async function startRemoving(business: BusinessRow) {
    setRemoving(business);
    setFootprint(undefined);
    setConfirmName("");
    setRemoveError(undefined);
    const response = await fetch(`/api/admin/businesses/${business.id}`);
    const data = (await response.json().catch(() => null)) as { business?: Footprint; error?: string } | null;
    if (!response.ok || !data?.business) setRemoveError(data?.error ?? "Couldn't load it. Try again.");
    else setFootprint(data.business);
  }

  async function remove(business: BusinessRow) {
    setRemoveBusy(true);
    setRemoveError(undefined);
    try {
      const response = await fetch(`/api/admin/businesses/${business.id}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmName }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setRemoveError(data?.error ?? "Couldn't delete it. Try again.");
        router.refresh();
        return;
      }
      setRemoving(null);
      setRemoved(business.name);
      setCreated(undefined);
      router.refresh();
    } finally {
      setRemoveBusy(false);
    }
  }

  async function makeInbox(business: BusinessRow) {
    setMakingInbox(business.id);
    setInboxError(undefined);
    try {
      const response = await fetch(`/api/admin/businesses/${business.id}/inbox`, { method: "POST" });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setInboxError({ id: business.id, message: data?.error ?? "Couldn't make the inbox. Try again." });
        return;
      }
      router.refresh();
    } finally {
      setMakingInbox(undefined);
    }
  }

  async function setPaused(business: BusinessRow) {
    setPauseBusy(true);
    setPauseError(undefined);
    try {
      const response = await fetch(`/api/admin/businesses/${business.id}/suspension`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suspended: !business.suspended }),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setPauseError(data?.error ?? "Couldn't change that. Try again.");
        return;
      }
      setPausing(null);
      router.refresh();
    } finally {
      setPauseBusy(false);
    }
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError(undefined);
    setSubmitting(true);
    try {
      const response = await fetch("/api/admin/businesses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form.entries())),
      });
      const data = (await response.json().catch(() => null)) as (Created & { error?: string }) | null;
      if (!response.ok || !data?.business) {
        setError(data?.error ?? "Couldn't set up the business. Try again.");
        return;
      }
      setCreated(data);
      setFormOpen(false);
      router.refresh();
    } finally {
      setSubmitting(false);
    }
  }

  async function open(id: string) {
    setOpening(id);
    const response = await fetch("/api/session/business", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orgId: id }),
    });
    if (response.ok) {
      router.push("/");
      router.refresh();
    } else setOpening(undefined);
  }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Businesses</h2>
          <p className="mt-1 text-sm text-ink-2">
            Every business on the app. Open one to see it as its owner does.{" "}
            <Link className="text-accent-ink hover:underline" href="/admin/usage">
              Usage across businesses
            </Link>
          </p>
        </div>
        {!formOpen ? (
          <Button onClick={() => { setFormOpen(true); setCreated(undefined); }} size="sm" variant="primary">
            <Plus aria-hidden="true" className="size-3.5" /> New business
          </Button>
        ) : null}
      </div>

      {created ? (
        <section className="rounded-card bg-green-tint px-5 py-4 text-sm" role="status">
          <p className="font-medium text-ink">
            <Check aria-hidden="true" className="mr-1.5 inline size-4 text-green" />
            {created.business.name} is set up.
          </p>
          <p className="mt-1 text-ink-2">
            Tell {created.owner.name} to text <span className="font-mono font-medium text-ink">{created.line}</span> from{" "}
            <span className="font-mono">{created.owner.phone}</span>. Their first text, anything at all, activates them.
          </p>
        </section>
      ) : null}

      {notice ? (
        <section className="rounded-card bg-green-tint px-5 py-4 text-sm" role="status">
          <p className="text-ink">
            <Check aria-hidden="true" className="mr-1.5 inline size-4 text-green" />
            {notice}
          </p>
        </section>
      ) : null}

      {removed ? (
        <section className="rounded-card bg-surface px-5 py-4 text-sm shadow-card" role="status">
          <p className="font-medium text-ink">
            <Check aria-hidden="true" className="mr-1.5 inline size-4 text-green" />
            {removed} is deleted.
          </p>
        </section>
      ) : null}

      {formOpen ? (
        <form className="rounded-card bg-surface shadow-card" onSubmit={create}>
          <div className="border-b border-line px-5 py-4">
            <h3 className="text-sm font-medium">New business</h3>
            <p className="mt-1 text-sm text-ink-2">The four answers from the sales call. Everything else the owner can text later.</p>
          </div>
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
            <Field autoComplete="off" id="name" label="Business name" required />
            <Field defaultValue="America/New_York" id="timeZone" label="Time zone" list="time-zones" required />
            <datalist id="time-zones">
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <Field autoComplete="off" id="ownerName" label="Owner's name" required />
            <Field autoComplete="off" id="ownerPhone" inputMode="tel" label="Owner's cell" placeholder="(555) 555-0142" required type="tel" />
            <Field
              autoComplete="off"
              hint="Optional. Made from the name when left blank."
              id="slug"
              label="Slug"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              placeholder="example-services"
            />
          </div>
          {error ? <p className="px-5 pb-1 text-sm text-destructive" role="alert">{error}</p> : null}
          <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
            {businesses.length > 0 ? (
              <Button onClick={() => { setFormOpen(false); setError(undefined); }} size="sm" type="button" variant="quiet">
                Cancel
              </Button>
            ) : null}
            <Button disabled={submitting} size="sm" type="submit" variant="primary">
              {submitting ? "Setting up…" : "Create business"}
            </Button>
          </div>
        </form>
      ) : null}

      <section className="overflow-hidden rounded-card bg-surface shadow-card">
        {businesses.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-3">No businesses yet.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-[12px] text-ink-3">
              <tr>
                <th className="px-5 py-2.5 font-medium">Business</th>
                <th className="px-3 py-2.5 font-medium">Owner</th>
                <th className="px-3 py-2.5 text-right font-medium">Members</th>
                <th className="px-3 py-2.5 font-medium">Created</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {businesses.map((business) => {
                const current = business.id === activeBusinessId;
                return (
                  <tr className="border-b border-line last:border-0" key={business.id}>
                    <td className="px-5 py-3">
                      <p className="flex items-center gap-2 font-medium text-ink">
                        {business.name}
                        {business.suspended ? <StatusPill dot={false} tone="orange">Paused</StatusPill> : null}
                      </p>
                      <p className="font-mono text-[12px] text-ink-3">{business.slug}</p>
                      {business.inboxAddress ? (
                        <p className="font-mono text-[12px] text-ink-3" title="Email inbox">{business.inboxAddress}</p>
                      ) : (
                        <button
                          className="text-[12px] text-ink-2 hover:text-ink hover:underline disabled:opacity-60"
                          disabled={makingInbox === business.id}
                          onClick={() => void makeInbox(business)}
                          type="button"
                        >
                          {makingInbox === business.id ? "Making the email inbox…" : "Make an email inbox"}
                        </button>
                      )}
                      {inboxError?.id === business.id ? (
                        <p className="text-[12px] text-destructive" role="alert">{inboxError.message}</p>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-ink">{business.ownerName ?? "None"}</p>
                      {business.ownerPhone ? <p className="font-mono text-[12px] text-ink-3">{business.ownerPhone}</p> : null}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">{business.memberCount}</td>
                    <td className="px-3 py-3 text-ink-2">{dateFormat.format(new Date(business.createdAt))}</td>
                    <td className="px-5 py-3 text-right whitespace-nowrap">
                      <Link className="mr-3 text-[13px] text-ink-2 hover:text-ink hover:underline" href={`/admin/${business.id}/activity`}>
                        Activity
                      </Link>
                      <Link className="mr-3 text-[13px] text-ink-2 hover:text-ink hover:underline" href={`/admin/${business.id}/usage`}>
                        Usage
                      </Link>
                      <DropdownMenu>
                        <DropdownMenuTrigger className="mr-3 inline-flex items-center gap-0.5 text-[13px] text-ink-2 hover:text-ink hover:underline">
                          Manage <ChevronDown aria-hidden="true" className="size-3.5" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onClick={() => setManaging({ action: "rename", business })}>Rename…</DropdownMenuItem>
                          {business.ownerId && business.ownerPhone ? (
                            <DropdownMenuItem onClick={() => setManaging({ action: "phone", business })}>Change owner&apos;s number…</DropdownMenuItem>
                          ) : null}
                          {business.inboxAddress ? (
                            <DropdownMenuItem onClick={() => setManaging({ action: "inbox", business })}>Remove email inbox…</DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onClick={() => { setPauseError(undefined); setPausing(business); }}>
                            {business.suspended ? "Resume…" : "Pause…"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem onClick={() => void startRemoving(business)} variant="destructive">
                            Delete…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {current ? (
                        <StatusPill dot={false} tone="accent">Open</StatusPill>
                      ) : (
                        <Button disabled={opening === business.id} onClick={() => void open(business.id)} size="xs">
                          {opening === business.id ? "Opening…" : "Open"}
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <ManageDialogs
        action={managing?.action ?? null}
        business={managing?.business ?? null}
        onClose={() => setManaging(null)}
        onDone={(message) => {
          setManaging(null);
          setNotice(message ?? undefined);
          router.refresh();
        }}
      />

      <Dialog onOpenChange={(open) => { if (!open) setPausing(null); }} open={pausing !== null}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{pausing ? `${pausing.suspended ? "Resume" : "Pause"} ${pausing.name}?` : ""}</DialogTitle>
          <DialogDescription>
            {pausing?.suspended
              ? "Its members can text the assistant and sign in again, and follow-ups start again on the next hour."
              : "Its members' texts get no answer (one line a day says it's paused), they can't sign in to the web app, and nothing texts them. Card payments still record."}
          </DialogDescription>
          {pauseError ? <p className="text-sm text-destructive" role="alert">{pauseError}</p> : null}
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>Cancel</DialogClose>
            <Button
              className={pausing?.suspended ? undefined : "bg-red text-white hover:opacity-90"}
              disabled={pauseBusy}
              onClick={() => pausing && void setPaused(pausing)}
              size="sm"
              variant={pausing?.suspended ? "primary" : undefined}
            >
              {pauseBusy ? "Saving…" : pausing?.suspended ? "Resume" : "Pause"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={(open) => { if (!open && !removeBusy) setRemoving(null); }} open={removing !== null}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{removing ? `Delete ${removing.name}?` : ""}</DialogTitle>
          <DialogDescription>Everything goes, here and at the providers. This can't be undone.</DialogDescription>
          {footprint ? (
            <ul className="space-y-1 text-sm text-ink-2">
              <li>{count(footprint.members, "member")}, {count(footprint.phones.length, "phone number")} released from Photon</li>
              {footprint.inboxAddress ? <li>The inbox <span className="font-mono text-[12px] text-ink">{footprint.inboxAddress}</span> and its mail</li> : null}
              <li>{count(footprint.records, "record")}, {count(footprint.files, "stored file")}</li>
              {footprint.signIns ? <li>{count(footprint.signIns, "web sign-in")}</li> : null}
              {footprint.stripe ? <li>The link to its Stripe account. The account stays the business's own.</li> : null}
            </ul>
          ) : !removeError ? (
            <p className="text-sm text-ink-3">Loading…</p>
          ) : null}
          {footprint && removing ? (
            <div className="grid gap-2">
              <Label htmlFor="confirm-delete">Type {removing.name} to confirm</Label>
              <Input
                autoComplete="off"
                id="confirm-delete"
                onChange={(event) => setConfirmName(event.target.value)}
                value={confirmName}
              />
            </div>
          ) : null}
          {removeError ? <p className="text-sm text-destructive" role="alert">{removeError}</p> : null}
          <DialogFooter>
            <DialogClose disabled={removeBusy} render={<Button size="sm" variant="quiet" />}>Cancel</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={removeBusy || !footprint || !removing || confirmName.trim() !== removing.name}
              onClick={() => removing && void remove(removing)}
              size="sm"
            >
              {removeBusy ? "Deleting…" : "Delete business"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
