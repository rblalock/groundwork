"use client";

import { Plus } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { Textarea } from "@/ui/components/textarea";
import type { Language } from "@/core/language";
import { formatPhone } from "@/lib/format";
import { pageCopyFor } from "@/lib/page-copy";
import { ErrorLine, Field, inputClass, NativeSelect, useMutation } from "./client-kit";

// An owner's or admin's changes on a customer's page. Each sends the revision the page showed, so a
// change made on a stale page is refused (409) with a line asking to reload.

type Details = { id: string; name: string; language: Language; notes: string | null; revision: number };

/** The customer's name, language, and notes. */
export function CustomerDetailsEditor({ customer, language }: { customer: Details; language: Language }) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const saved = await send("save", `/api/customers/${customer.id}`, {
      method: "PATCH",
      body: {
        name: String(form.get("name") ?? ""),
        language: String(form.get("language") ?? customer.language),
        notes: String(form.get("notes") ?? ""),
        expectedRevision: customer.revision,
      },
    });
    if (saved) setOpen(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs">
        {copy.common.edit}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{c.details}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <Field autoComplete="off" defaultValue={customer.name} id="name" label={c.name} required />
            <Field id="language" label={c.language}>
              <NativeSelect defaultValue={customer.language} id="language" name="language">
                <option value="en">{copy.common.languages.en}</option>
                <option value="es">{copy.common.languages.es}</option>
              </NativeSelect>
            </Field>
            <Field id="notes" label={c.notes}>
              <Textarea defaultValue={customer.notes ?? ""} id="notes" name="notes" rows={3} />
            </Field>
            <ErrorLine>{error}</ErrorLine>
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                {busy ? copy.common.saving : copy.common.save}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

export type ContactRow = { id: string; name: string; role: string | null; phones: string[]; emails: string[]; preferred: boolean };

const lines = (value: FormDataEntryValue | null) =>
  String(value ?? "")
    .split(/[\n,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

/** Adds a contact (no `contact`) or edits one: name, who they are, phones, emails, and whether preferred. */
export function ContactEditor({
  customerId,
  revision,
  contact,
  language,
}: {
  customerId: string;
  revision: number;
  contact?: ContactRow;
  language: Language;
}) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const phones = lines(form.get("phones"));
    const emails = lines(form.get("emails")).map((e) => e.toLowerCase());
    const digits = (p: string) => p.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    const body = {
      name: String(form.get("name") ?? ""),
      role: String(form.get("role") ?? ""),
      preferred: form.get("preferred") === "on",
      // An edit sends what changed: numbers typed differently but with the same digits stay as saved.
      addPhones: phones.filter((p) => !(contact?.phones ?? []).some((saved) => digits(saved) === digits(p))),
      removePhones: (contact?.phones ?? []).filter((saved) => !phones.some((p) => digits(saved) === digits(p))),
      addEmails: emails.filter((e) => !(contact?.emails ?? []).includes(e)),
      removeEmails: (contact?.emails ?? []).filter((saved) => !emails.includes(saved)),
      expectedRevision: revision,
    };
    const url = contact ? `/api/customers/${customerId}/contacts/${contact.id}` : `/api/customers/${customerId}/contacts`;
    const saved = await send("save", url, { method: contact ? "PATCH" : "POST", body });
    if (saved) setOpen(false);
  }

  return (
    <>
      {contact ? (
        <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
          {copy.common.edit}
        </Button>
      ) : (
        <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
          <Plus aria-hidden="true" className="size-3.5" /> {c.addContact}
        </Button>
      )}
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{contact ? c.editContact : c.addContact}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field autoComplete="off" defaultValue={contact?.name ?? ""} id="name" label={c.name} required />
              <Field autoComplete="off" defaultValue={contact?.role ?? ""} id="role" label={c.contactRole} placeholder={c.rolePlaceholder} />
            </div>
            <Field hint={c.onePerLine} id="phones" label={c.contactPhones}>
              <Textarea
                defaultValue={(contact?.phones ?? []).map(formatPhone).join("\n")}
                id="phones"
                inputMode="tel"
                name="phones"
                rows={2}
              />
            </Field>
            <Field hint={c.onePerLine} id="emails" label={c.contactEmails}>
              <Textarea defaultValue={(contact?.emails ?? []).join("\n")} id="emails" name="emails" rows={2} />
            </Field>
            <label className="flex items-start gap-2 text-[13px] text-ink">
              <input className="mt-0.5 size-4 accent-[var(--color-ink)]" defaultChecked={contact?.preferred ?? false} name="preferred" type="checkbox" />
              <span>
                {c.preferred}
                <span className="block text-[12px] text-ink-3">{c.preferredHint}</span>
              </span>
            </label>
            <ErrorLine>{error}</ErrorLine>
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                {busy ? copy.common.saving : copy.common.save}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Removes a contact, after asking. */
export function RemoveContactButton({ customerId, revision, contact, language }: { customerId: string; revision: number; contact: ContactRow; language: Language }) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const { send, busy, error } = useMutation(copy.common.failed);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {c.removeContact}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{c.removeContactTitle(contact.name)}</DialogTitle>
          <DialogDescription>{c.removeContactBody}</DialogDescription>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                const done = await send("remove", `/api/customers/${customerId}/contacts/${contact.id}`, { method: "DELETE", body: { expectedRevision: revision } });
                if (done) setOpen(false);
              }}
              size="sm"
              variant="primary"
            >
              {c.removeContact}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Adds an address to a customer's properties. */
export function AddPropertyForm({ customerId, revision, language }: { customerId: string; revision: number; language: Language }) {
  const copy = pageCopyFor(language);
  const [open, setOpen] = useState(false);
  const [address, setAddress] = useState("");
  const { send, busy, error } = useMutation(copy.common.failed);

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        <Plus aria-hidden="true" className="size-3.5" /> {copy.customers.addProperty}
      </Button>
    );
  }
  return (
    <form
      className="grid gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!address.trim()) return;
        const saved = await send("address", `/api/customers/${customerId}`, { method: "PATCH", body: { address, expectedRevision: revision } });
        if (saved) {
          setAddress("");
          setOpen(false);
        }
      }}
    >
      <Field autoComplete="off" autoFocus id="address" label={copy.customers.address} onChange={(e) => setAddress(e.target.value)} value={address} />
      <ErrorLine>{error}</ErrorLine>
      <div className="flex justify-end gap-2">
        <Button onClick={() => setOpen(false)} size="xs" type="button" variant="quiet">
          {copy.common.cancel}
        </Button>
        <Button disabled={busy !== null || !address.trim()} size="xs" type="submit" variant="primary">
          {busy ? copy.common.saving : copy.common.save}
        </Button>
      </div>
    </form>
  );
}

export type PropertyRow = { id: string; address: string; notes: string | null };

/** Corrects one of a customer's addresses, or its notes. A changed address is placed again. */
export function PropertyEditor({ customerId, revision, property, language }: { customerId: string; revision: number; property: PropertyRow; language: Language }) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const saved = await send("save", `/api/customers/${customerId}/properties/${property.id}`, {
      method: "PATCH",
      body: { address: String(form.get("address") ?? ""), notes: String(form.get("notes") ?? ""), expectedRevision: revision },
    });
    if (saved) setOpen(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {c.editAddress}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
        open={open}
      >
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{c.address}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <Field autoComplete="off" defaultValue={property.address} id="address" label={c.address} required />
            <Field id="notes" label={c.notes}>
              <Textarea defaultValue={property.notes ?? ""} id="notes" name="notes" rows={3} />
            </Field>
            <ErrorLine>{error}</ErrorLine>
            <div className="flex justify-end gap-2">
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                {busy ? copy.common.saving : copy.common.save}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Removes an address, after asking. One a quote, job, invoice, or note is on is refused with how many. */
export function RemovePropertyButton({ customerId, revision, property, language }: { customerId: string; revision: number; property: PropertyRow; language: Language }) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {c.removeAddress}
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
        open={open}
      >
        <DialogContent showCloseButton={false}>
          <DialogTitle>{c.removeAddressTitle(property.address)}</DialogTitle>
          <DialogDescription>{c.removeAddressBody}</DialogDescription>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                const done = await send("remove", `/api/customers/${customerId}/properties/${property.id}`, { method: "DELETE", body: { expectedRevision: revision } });
                if (done) setOpen(false);
              }}
              size="sm"
              variant="primary"
            >
              {c.removeAddress}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Archives a customer, after asking, or brings an archived one back. */
export function ArchiveCustomerButton({
  customer,
  language,
}: {
  customer: { id: string; name: string; revision: number; archived: boolean };
  language: Language;
}) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const { send, busy, error } = useMutation(copy.common.failed);
  const set = (archived: boolean) => send(archived ? "archive" : "restore", `/api/customers/${customer.id}/archive`, { method: "POST", body: { archived, expectedRevision: customer.revision } });

  if (customer.archived) {
    return (
      <div className="grid gap-1">
        <Button disabled={busy !== null} onClick={() => set(false)} size="xs">
          {c.restore}
        </Button>
        <ErrorLine>{error}</ErrorLine>
      </div>
    );
  }
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {c.archive}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{c.archiveTitle(customer.name)}</DialogTitle>
          <DialogDescription>{c.archiveBody}</DialogDescription>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              disabled={busy !== null}
              onClick={async () => {
                if (await set(true)) setOpen(false);
              }}
              size="sm"
              variant="primary"
            >
              {c.archive}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Candidate = { id: string; name: string; revision: number; phones: string[]; emails: string[]; address: string | null };

/** Finds the duplicate of this customer, then merges it in after a confirm. */
export function MergeCustomerButton({ customer, language }: { customer: { id: string; name: string; revision: number }; language: Language }) {
  const copy = pageCopyFor(language);
  const c = copy.customers;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [picked, setPicked] = useState<Candidate | null>(null);
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  useEffect(() => {
    if (!open || !query.trim()) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/customers?q=${encodeURIComponent(query.trim())}&exclude=${encodeURIComponent(customer.id)}`, { signal: controller.signal });
        const data = (await response.json()) as { customers?: Candidate[] };
        setFound(data.customers ?? []);
      } catch {
        // A newer search replaced this one.
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, customer.id]);

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setPicked(null);
      setError(undefined);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {c.merge}
      </Button>
      <Dialog onOpenChange={close} open={open}>
        <DialogContent className="sm:max-w-md">
          {picked ? (
            <>
              <DialogTitle>{c.mergeConfirm(picked.name, customer.name)}</DialogTitle>
              <DialogDescription>{c.mergeConfirmBody}</DialogDescription>
              <ErrorLine>{error}</ErrorLine>
              <DialogFooter>
                <Button onClick={() => setPicked(null)} size="sm" variant="quiet">
                  {c.back2}
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={async () => {
                    const done = await send("merge", `/api/customers/${customer.id}/merge`, {
                      method: "POST",
                      body: { otherId: picked.id, expectedRevision: customer.revision, otherRevision: picked.revision },
                    });
                    if (done) close(false);
                  }}
                  size="sm"
                  variant="primary"
                >
                  {c.mergeButton}
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogTitle>{c.mergeTitle}</DialogTitle>
              <DialogDescription>{c.mergeHelp(customer.name)}</DialogDescription>
              <label className="grid gap-1.5">
                <span className="sr-only">{c.mergeSearch}</span>
                <input autoFocus className={inputClass} onChange={(e) => setQuery(e.target.value)} placeholder={c.mergeSearch} type="search" value={query} />
              </label>
              {found && found.length === 0 ? <p className="text-[13px] text-ink-3">{c.noMergeMatch}</p> : null}
              {found && found.length > 0 ? (
                <ul className="-mx-1 grid max-h-64 gap-0.5 overflow-y-auto">
                  {found.map((other) => (
                    <li key={other.id}>
                      <button className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none" onClick={() => setPicked(other)} type="button">
                        <span className="block text-[13px] font-medium text-ink">{other.name}</span>
                        <span className="block text-[12px] text-ink-3">
                          {[other.address, ...other.phones.map(formatPhone), ...other.emails].filter(Boolean).join(" · ") || copy.common.none}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
