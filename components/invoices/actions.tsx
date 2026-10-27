"use client";

import { Check, Copy, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import { Textarea } from "@/ui/components/textarea";
import type { Language } from "@/core/language";
import { formatCents, parseMoneyToCents } from "@/core/money";
import { pageCopyFor } from "@/lib/page-copy";
import { ErrorLine, Field, inputClass, NativeSelect, useMutation } from "../pages/client-kit";

type Line = { name: string; quantity: number; unitLabel: string; unitCents: number | null; taxable: boolean };

export type InvoiceActionProps = {
  invoiceId: string;
  status: "draft" | "sent" | "partially_paid" | "paid" | "void";
  balanceCents: number;
  hasPayments: boolean;
  payUrl: string | null;
  lines: Line[];
  notes: string | null;
  dueDate: string | null;
  today: string;
  language: Language;
};

/**
 * An owner's or admin's moves on an invoice: edit a draft's lines, send it (the PDF goes to their texts
 * to forward), record a payment, copy the pay link, and void it. The server applies the same rules as
 * the assistant.
 */
export function InvoiceActions(props: InvoiceActionProps) {
  const { invoiceId, status, balanceCents, hasPayments, payUrl, language } = props;
  const copy = pageCopyFor(language);
  const t = copy.invoices;
  const { send, busy, error } = useMutation(copy.common.failed);
  const [dialog, setDialog] = useState<"edit" | "pay" | "void" | null>(null);
  const [notice, setNotice] = useState<string>();
  const open = status === "sent" || status === "partially_paid";
  if (status === "void") return null;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {status === "draft" ? (
          <Button
            disabled={busy !== null}
            onClick={async () => {
              setNotice(undefined);
              if (await send("send", `/api/invoices/${invoiceId}/send`, { method: "POST" })) setNotice(t.sentNote);
            }}
            size="sm"
            variant="primary"
          >
            {busy === "send" ? t.sending : t.send}
          </Button>
        ) : null}
        {status === "draft" || open ? (
          <Button disabled={busy !== null} onClick={() => setDialog("pay")} size="sm" variant={open ? "primary" : "secondary"}>
            {t.record}
          </Button>
        ) : null}
        {status === "draft" ? (
          <Button disabled={busy !== null} onClick={() => setDialog("edit")} size="sm">
            {t.edit}
          </Button>
        ) : null}
        {status !== "draft" ? (
          <Button
            disabled={busy !== null}
            onClick={async () => {
              setNotice(undefined);
              if (await send("send", `/api/invoices/${invoiceId}/send`, { method: "POST" })) setNotice(t.sentNote);
            }}
            size="sm"
          >
            {busy === "send" ? t.sending : t.sendAgain}
          </Button>
        ) : null}
        {payUrl ? <CopyButton label={t.copyLink} done={t.copied} text={payUrl} /> : null}
        {!hasPayments ? (
          <Button disabled={busy !== null} onClick={() => setDialog("void")} size="sm" variant="quiet">
            {t.voidInvoice}
          </Button>
        ) : null}
      </div>
      <p className="text-[12px] text-ink-3" role="status">
        {notice ?? t.sendNote}
      </p>
      <ErrorLine>{error}</ErrorLine>

      {dialog === "edit" ? <EditLinesDialog {...props} onClose={() => setDialog(null)} /> : null}
      {dialog === "pay" ? <PaymentDialog balanceCents={balanceCents} invoiceId={invoiceId} language={language} onClose={() => setDialog(null)} today={props.today} /> : null}
      <Dialog onOpenChange={(next) => setDialog(next ? "void" : null)} open={dialog === "void"}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.confirmVoidTitle}</DialogTitle>
          <DialogDescription>{t.confirmVoidBody}</DialogDescription>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={busy !== null}
              onClick={async () => {
                if (await send("void", `/api/invoices/${invoiceId}/void`, { method: "POST" })) setDialog(null);
              }}
              size="sm"
            >
              {t.voidInvoice}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      size="sm"
    >
      {copied ? <Check aria-hidden="true" className="size-3.5" /> : <Copy aria-hidden="true" className="size-3.5" />}
      {copied ? done : label}
    </Button>
  );
}

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2).replace(/\.00$/, ""));

type LineRow = { key: number; name: string; quantity: string; unitLabel: string; price: string; taxable: boolean };
type FormCopy = ReturnType<typeof pageCopyFor>["invoices"]["form"];

const blankRow = (key: number): LineRow => ({ key, name: "", quantity: "1", unitLabel: "", price: "", taxable: true });

/** An invoice's lines as editable rows, and the lines they hold once each one checks out. */
function useLineRows(initial: Line[], f: FormCopy) {
  const [rows, setRows] = useState<LineRow[]>(() =>
    initial.length
      ? initial.map((l, i) => ({ key: i, name: l.name, quantity: String(l.quantity), unitLabel: l.unitLabel, price: dollars(l.unitCents), taxable: l.taxable }))
      : [blankRow(0)],
  );
  /** The lines to save, or the first problem in the member's words. */
  function collect(): { lines: Array<Omit<Line, "unitCents"> & { unitCents: number }> } | { problem: string } {
    const lines = [];
    for (const row of rows) {
      const quantity = Number(row.quantity);
      const unitCents = parseMoneyToCents(row.price);
      if (!row.name.trim()) return { problem: f.errors.name };
      if (!Number.isFinite(quantity) || quantity <= 0) return { problem: f.errors.quantity };
      if (unitCents === null) return { problem: f.errors.money };
      lines.push({ name: row.name.trim(), quantity, unitLabel: row.unitLabel.trim(), unitCents, taxable: row.taxable });
    }
    return { lines };
  }
  return { rows, setRows, collect };
}

function LineRows({ rows, setRows, f }: { rows: LineRow[]; setRows: (update: (all: LineRow[]) => LineRow[]) => void; f: FormCopy }) {
  const update = (key: number, patch: Partial<LineRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  return (
    <div className="grid gap-2">
      <div className="hidden grid-cols-[minmax(0,1fr)_4.5rem_5rem_6rem_2.5rem_2rem] gap-2 text-[12px] text-ink-3 sm:grid">
        <span>{f.name}</span>
        <span>{f.qty}</span>
        <span>{f.unit}</span>
        <span>{f.price}</span>
        <span className="text-center">{f.tax}</span>
        <span />
      </div>
      {rows.map((row) => (
        <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_5rem_6rem_2.5rem_2rem] gap-2" key={row.key}>
          <input aria-label={f.name} className={inputClass} onChange={(e) => update(row.key, { name: e.target.value })} value={row.name} />
          <input aria-label={f.qty} className={inputClass} inputMode="decimal" onChange={(e) => update(row.key, { quantity: e.target.value })} value={row.quantity} />
          <input aria-label={f.unit} className={inputClass} onChange={(e) => update(row.key, { unitLabel: e.target.value })} value={row.unitLabel} />
          <input aria-label={f.price} className={inputClass} inputMode="decimal" onChange={(e) => update(row.key, { price: e.target.value })} placeholder="0.00" value={row.price} />
          <label className="flex items-center justify-center" title={f.tax}>
            <input
              aria-label={f.taxLine(row.name.trim())}
              checked={row.taxable}
              className="size-4 accent-[var(--color-accent)]"
              onChange={(e) => update(row.key, { taxable: e.target.checked })}
              type="checkbox"
            />
          </label>
          <Button
            aria-label={f.removeLine}
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
        <Button onClick={() => setRows((all) => [...all, blankRow(Math.max(...all.map((r) => r.key)) + 1)])} size="xs" type="button">
          <Plus aria-hidden="true" className="size-3.5" />
          {f.addLine}
        </Button>
      </div>
    </div>
  );
}

function EditLinesDialog({ invoiceId, lines: initial, notes, dueDate, language, onClose }: InvoiceActionProps & { onClose: () => void }) {
  const copy = pageCopyFor(language);
  const f = copy.invoices.form;
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const { rows, setRows, collect } = useLineRows(initial, f);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const collected = collect();
    if ("problem" in collected) return setError(collected.problem);
    const due = String(form.get("dueDate") ?? "");
    const saved = await send("save", `/api/invoices/${invoiceId}`, {
      method: "PATCH",
      body: { lines: collected.lines, notes: String(form.get("notes") ?? "").trim() || null, dueDate: due || null },
    });
    if (saved) onClose();
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>{f.editTitle}</DialogTitle>
        <DialogDescription>{f.editHelp}</DialogDescription>
        <form className="grid gap-4" onSubmit={submit}>
          <LineRows f={f} rows={rows} setRows={setRows} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field defaultValue={dueDate ?? ""} hint={f.dueDateHelp} id="dueDate" label={f.dueDate} type="date" />
          </div>
          <Field id="notes" label={f.notes}>
            <Textarea defaultValue={notes ?? ""} id="notes" name="notes" rows={3} />
          </Field>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
              {busy ? copy.common.saving : f.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Invoices finished work that has no quote to copy: the owner or admin enters what to bill, and it's
 * saved as a draft invoice on the work (the same `createInvoice` the assistant uses), then opened.
 */
function InvoiceWorkDialog({ serviceJobId, language, onClose }: { serviceJobId: string; language: Language; onClose: () => void }) {
  const router = useRouter();
  const copy = pageCopyFor(language);
  const f = copy.invoices.form;
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const { rows, setRows, collect } = useLineRows([], f);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const collected = collect();
    if ("problem" in collected) return setError(collected.problem);
    const notes = String(form.get("notes") ?? "").trim();
    const made = await send<{ invoiceId: string }>("create", "/api/invoices", {
      method: "POST",
      body: { serviceJobId, lines: collected.lines, ...(notes ? { notes } : {}) },
    });
    if (made) router.push(`/invoices/${made.invoiceId}`);
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-2xl">
        <DialogTitle>{f.createTitle}</DialogTitle>
        <DialogDescription>{f.createHelp}</DialogDescription>
        <form className="grid gap-4" onSubmit={submit}>
          <LineRows f={f} rows={rows} setRows={setRows} />
          <Field id="notes" label={f.notes}>
            <Textarea id="notes" name="notes" rows={3} />
          </Field>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
              {busy ? copy.invoices.creating : f.createSubmit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type CustomerPick = { id: string; name: string; address: string | null };

/**
 * "New invoice": an invoice from scratch, not from work or a quote. Who it's for (or no one), a title,
 * and its lines, saved as a draft (the same `createInvoice` the assistant uses) and opened.
 */
export function NewInvoiceButton({ language }: { language: Language }) {
  const router = useRouter();
  const copy = pageCopyFor(language);
  const f = copy.invoices.form;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<CustomerPick[] | null>(null);
  const [customer, setCustomer] = useState<CustomerPick | null>(null);
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const { rows, setRows, collect } = useLineRows([], f);

  useEffect(() => {
    if (!open || customer || !query.trim()) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/customers?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        const data = (await response.json()) as { customers?: CustomerPick[] };
        setFound(data.customers ?? []);
      } catch {
        // A newer search replaced this one.
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, customer]);

  function close(next: boolean) {
    setOpen(next);
    if (!next) {
      setQuery("");
      setCustomer(null);
      setRows(() => [blankRow(0)]);
      setError(undefined);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return setError(f.titleRequired);
    const collected = collect();
    if ("problem" in collected) return setError(collected.problem);
    const made = await send<{ invoiceId: string }>("create", "/api/invoices", {
      method: "POST",
      body: { title, lines: collected.lines, ...(customer ? { customerId: customer.id } : {}) },
    });
    if (made) router.push(`/invoices/${made.invoiceId}`);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} size="sm" variant="primary">
        <Plus aria-hidden="true" className="size-3.5" />
        {copy.invoices.newInvoice}
      </Button>
      <Dialog onOpenChange={close} open={open}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle>{f.newTitle}</DialogTitle>
          <form className="grid gap-4" onSubmit={submit}>
            <div className="grid gap-1.5">
              <span className="text-[13px] font-medium">{f.customer}</span>
              {customer ? (
                <div className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px]">
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium text-ink">{customer.name}</span>
                    {customer.address ? <span className="text-ink-3"> · {customer.address}</span> : null}
                  </span>
                  <Button onClick={() => setCustomer(null)} size="xs" type="button" variant="quiet">
                    {f.change}
                  </Button>
                </div>
              ) : (
                <>
                  <input
                    aria-label={f.customerSearch}
                    autoComplete="off"
                    className={inputClass}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={f.customerSearch}
                    type="search"
                    value={query}
                  />
                  {found && found.length === 0 ? <p className="text-[12px] text-ink-3">{f.noMatch}</p> : null}
                  {found && found.length > 0 ? (
                    <ul className="-mx-1 grid max-h-48 gap-0.5 overflow-y-auto">
                      {found.map((c) => (
                        <li key={c.id}>
                          <button
                            className="w-full rounded-lg px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                            onClick={() => setCustomer(c)}
                            type="button"
                          >
                            <span className="block text-[13px] font-medium text-ink">{c.name}</span>
                            {c.address ? <span className="block text-[12px] text-ink-3">{c.address}</span> : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
            </div>
            <Field autoComplete="off" id="title" label={f.title} maxLength={160} required />
            <LineRows f={f} rows={rows} setRows={setRows} />
            <ErrorLine>{error}</ErrorLine>
            <DialogFooter>
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
                {busy ? copy.invoices.creating : f.createSubmit}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PaymentDialog({ invoiceId, balanceCents, today, language, onClose }: { invoiceId: string; balanceCents: number; today: string; language: Language; onClose: () => void }) {
  const copy = pageCopyFor(language);
  const t = copy.invoices;
  const f = t.form;
  const { send, busy, error, setError } = useMutation(copy.common.failed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amountCents = parseMoneyToCents(String(form.get("amount") ?? ""));
    if (!amountCents) return setError(f.errors.money);
    const saved = await send("pay", `/api/invoices/${invoiceId}/payments`, {
      method: "POST",
      body: {
        amountCents,
        method: String(form.get("method")),
        receivedDate: String(form.get("receivedDate") ?? "") || undefined,
        reference: String(form.get("reference") ?? "").trim() || undefined,
      },
    });
    if (saved) onClose();
  }

  return (
    <Dialog onOpenChange={(next) => (next ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>{f.payTitle}</DialogTitle>
        <DialogDescription>{f.payBalance(formatCents(balanceCents, language))}</DialogDescription>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field autoComplete="off" defaultValue={dollars(balanceCents)} id="amount" inputMode="decimal" label={f.payAmount} required />
            <Field id="method" label={f.payMethod}>
              <NativeSelect defaultValue="cash" id="method" name="method">
                {(["cash", "check", "card", "other"] as const).map((m) => (
                  <option key={m} value={m}>
                    {t.methods[m]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field defaultValue={today} id="receivedDate" label={f.payDate} max={today} type="date" />
            <Field autoComplete="off" hint={f.payReferenceHint} id="reference" label={f.payReference} />
          </div>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button disabled={busy !== null} size="sm" type="submit" variant="primary">
              {busy ? copy.common.saving : f.paySubmit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type OpenInvoice = { invoiceId: string; label: string; title: string; customerName: string | null; balanceCents: number };

/** "Record payment" on the Payments page: pick the open invoice it's for, then the same form as on the invoice. */
export function RecordPaymentButton({ invoices, today, language }: { invoices: OpenInvoice[]; today: string; language: Language }) {
  const copy = pageCopyFor(language);
  const p = copy.payments;
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<OpenInvoice | null>(null);
  if (invoices.length === 0) return null;
  return (
    <>
      <Button onClick={() => setPicking(true)} size="sm" type="button" variant="primary">
        <Plus aria-hidden="true" className="size-3.5" />
        {copy.invoices.record}
      </Button>
      <Dialog onOpenChange={setPicking} open={picking}>
        <DialogContent className="sm:max-w-md">
          <DialogTitle>{copy.invoices.form.payTitle}</DialogTitle>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              const id = String(new FormData(event.currentTarget).get("invoice") ?? "");
              setChosen(invoices.find((invoice) => invoice.invoiceId === id) ?? null);
              setPicking(false);
            }}
          >
            <Field id="invoice" label={p.invoice}>
              <NativeSelect id="invoice" name="invoice">
                {invoices.map((invoice) => (
                  <option key={invoice.invoiceId} value={invoice.invoiceId}>
                    {`${invoice.label} · ${invoice.customerName ?? invoice.title} · ${formatCents(invoice.balanceCents, language)}`}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <DialogFooter>
              <DialogClose render={<Button size="sm" type="button" variant="quiet" />}>{copy.common.cancel}</DialogClose>
              <Button size="sm" type="submit" variant="primary">
                {p.next}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      {chosen ? (
        <PaymentDialog balanceCents={chosen.balanceCents} invoiceId={chosen.invoiceId} language={language} onClose={() => setChosen(null)} today={today} />
      ) : null}
    </>
  );
}

/** Takes a payment entered by mistake off its invoice, after a confirm. */
export function RemovePaymentButton({ invoiceId, paymentId, language }: { invoiceId: string; paymentId: string; language: Language }) {
  const copy = pageCopyFor(language);
  const t = copy.invoices;
  const { send, busy, error } = useMutation(copy.common.failed);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)} size="xs" variant="quiet">
        {t.remove}
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>{t.confirmRemoveTitle}</DialogTitle>
          <DialogDescription>{t.confirmRemoveBody}</DialogDescription>
          <ErrorLine>{error}</ErrorLine>
          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="quiet" />}>{copy.common.cancel}</DialogClose>
            <Button
              className="bg-red text-white hover:opacity-90"
              disabled={busy !== null}
              onClick={async () => {
                if (await send("remove", `/api/invoices/${invoiceId}/payments/${paymentId}`, { method: "DELETE" })) setOpen(false);
              }}
              size="sm"
            >
              {t.remove}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Invoices finished work or an agreed quote, then opens the invoice. Work with no quote to copy
 * (`needsLines`) first asks what to bill.
 */
export function CreateInvoiceButton({
  about,
  language,
  needsLines = false,
  variant = "secondary",
}: {
  about: { serviceJobId: string } | { quoteId: string };
  language: Language;
  needsLines?: boolean;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const copy = pageCopyFor(language);
  const { send, busy, error } = useMutation(copy.common.failed);
  const [asking, setAsking] = useState(false);
  const withLines = needsLines && "serviceJobId" in about ? about.serviceJobId : null;
  return (
    <span className="inline-grid gap-1">
      <Button
        disabled={busy !== null}
        onClick={async () => {
          if (withLines) return setAsking(true);
          const made = await send<{ invoiceId: string }>("create", "/api/invoices", { method: "POST", body: about });
          if (made) router.push(`/invoices/${made.invoiceId}`);
        }}
        size="sm"
        variant={variant}
      >
        {busy ? copy.invoices.creating : copy.invoices.create}
      </Button>
      <ErrorLine>{error}</ErrorLine>
      {withLines && asking ? <InvoiceWorkDialog language={language} onClose={() => setAsking(false)} serviceJobId={withLines} /> : null}
    </span>
  );
}
