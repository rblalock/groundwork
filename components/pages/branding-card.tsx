"use client";

import { Download, FileText, ImageUp, ReceiptText } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/ui/beautiful/atoms/Button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/ui/components/dialog";
import type { Language } from "@/core/language";
import { pdfCopy } from "@/core/pdf-copy";
import { FOOTER_MAX_CHARS, FOOTER_MAX_LINES, PDF_DETAILS, accentColors, normalizeFooter, normalizeHex, type PdfDetail, type Rgb } from "@/core/pdf-style";
import { pageCopyFor } from "@/lib/page-copy";
import { cn } from "@/ui/lib/utils";
import { Card } from "./kit";
import { ErrorLine, Field, inputClass, useMutation } from "./client-kit";

export type BrandingValues = {
  logoVersion: string | null;
  accentColor: string | null;
  quoteFooter: string | null;
  invoiceFooter: string | null;
  showOnPdf: Record<PdfDetail, boolean>;
};

const css = ([r, g, b]: Rgb) => `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

/**
 * Settings' logo and PDF look. The logo is saved the moment it's uploaded or removed; the accent, the
 * closing notes, and the header facts are saved with the button. Either preview shows a made-up quote
 * or invoice with what the form holds now, saved or not.
 */
export function BrandingCard({
  values,
  facts,
  language,
  pdfLanguage,
  canEdit,
}: {
  values: BrandingValues;
  /** Which contact facts the profile has, so an empty one says it isn't saved. */
  facts: Record<PdfDetail, boolean>;
  language: Language;
  /** The language the business's PDFs are in, for the standard closing lines shown as placeholders. */
  pdfLanguage: Language;
  canEdit: boolean;
}) {
  const copy = pageCopyFor(language);
  const b = copy.branding;
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { send, busy, error, setError } = useMutation(copy.common.failed);
  const [accent, setAccent] = useState(values.accentColor ?? "");
  const [quoteFooter, setQuoteFooter] = useState(values.quoteFooter ?? "");
  const [invoiceFooter, setInvoiceFooter] = useState(values.invoiceFooter ?? "");
  const [show, setShow] = useState(values.showOnPdf);
  const [notice, setNotice] = useState<string>();
  const [logoBusy, setLogoBusy] = useState<"upload" | "remove" | null>(null);
  const [logoError, setLogoError] = useState<string>();
  const [preview, setPreview] = useState<{ kind: "quote" | "invoice"; url: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState<"quote" | "invoice" | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // A preview's PDF lives in a blob URL until the dialog closes.
  useEffect(() => () => (preview ? URL.revokeObjectURL(preview.url) : undefined), [preview]);

  const hex = accent.trim() === "" ? null : normalizeHex(accent);
  const accentInvalid = accent.trim() !== "" && hex === null;
  const footerInvalid = (value: string) => {
    const text = normalizeFooter(value);
    return text !== null && (text.length > FOOTER_MAX_CHARS || text.split("\n").length > FOOTER_MAX_LINES);
  };
  const swatch = hex ? accentColors(hex) : null;
  const pdf = pdfCopy(pdfLanguage);

  /** The form as the API takes it. */
  function fields() {
    return { accentColor: hex, quoteFooter: normalizeFooter(quoteFooter), invoiceFooter: normalizeFooter(invoiceFooter), showOnPdf: show };
  }

  function valid(): boolean {
    const problem = accentInvalid
      ? b.errors.accent
      : footerInvalid(quoteFooter) || footerInvalid(invoiceFooter)
        ? b.errors.footer(FOOTER_MAX_CHARS)
        : null;
    if (problem) setError(problem);
    return problem === null;
  }

  async function save() {
    setNotice(undefined);
    if (!valid()) return;
    const saved = await send<{ changed: string[] }>("save", "/api/branding", { method: "PATCH", body: fields() });
    if (saved) setNotice(saved.changed.length ? b.saved : b.nothingChanged);
  }

  async function uploadLogo(file: File) {
    setLogoError(undefined);
    setLogoBusy("upload");
    try {
      const response = await fetch("/api/branding/logo", { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
      const data = (await response.json().catch(() => null)) as { error?: string; code?: string } | null;
      if (response.ok) startTransition(() => router.refresh());
      else setLogoError((data?.code && b.logoErrors[data.code]) || data?.error || copy.common.failed);
    } catch {
      setLogoError(copy.common.failed);
    } finally {
      setLogoBusy(null);
    }
  }

  async function removeLogo() {
    setLogoError(undefined);
    setLogoBusy("remove");
    try {
      const response = await fetch("/api/branding/logo", { method: "DELETE" });
      if (response.ok) startTransition(() => router.refresh());
      else setLogoError(copy.common.failed);
    } catch {
      setLogoError(copy.common.failed);
    } finally {
      setLogoBusy(null);
    }
  }

  async function openPreview(kind: "quote" | "invoice") {
    if (!valid()) return;
    setError(undefined);
    setPreviewBusy(kind);
    try {
      const response = await fetch("/api/branding/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, branding: fields() }),
      });
      if (response.ok) setPreview({ kind, url: URL.createObjectURL(await response.blob()) });
      else setError(copy.common.failed);
    } catch {
      setError(copy.common.failed);
    } finally {
      setPreviewBusy(null);
    }
  }

  return (
    <Card description={b.help} title={b.title}>
      <div className="space-y-6">
        <section aria-labelledby="branding-logo" className="space-y-2">
          <h3 className="text-[13px] font-medium" id="branding-logo">
            {b.logo}
          </h3>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex h-16 w-40 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white p-2 shadow-hairline">
              {values.logoVersion ? (
                // eslint-disable-next-line @next/next/no-img-element -- served by our own route
                <img alt={b.logoAlt} className="max-h-full max-w-full object-contain" src={`/api/branding/logo?v=${values.logoVersion}`} />
              ) : (
                <span className="text-[12px] text-ink-3">{b.noLogo}</span>
              )}
            </div>
            {canEdit ? (
              <div className="flex flex-wrap gap-2">
                <input
                  accept="image/png,image/jpeg,image/heic,image/heif"
                  aria-label={b.upload}
                  className="hidden"
                  disabled={logoBusy !== null}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadLogo(file);
                  }}
                  ref={fileInput}
                  type="file"
                />
                <Button disabled={logoBusy !== null} onClick={() => fileInput.current?.click()} size="sm" type="button">
                  <ImageUp aria-hidden="true" className="size-3.5" />
                  {logoBusy === "upload" ? b.uploading : values.logoVersion ? b.replace : b.upload}
                </Button>
                {values.logoVersion ? (
                  <Button disabled={logoBusy !== null} onClick={() => void removeLogo()} size="sm" type="button" variant="quiet">
                    {logoBusy === "remove" ? b.removing : b.remove}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
          <p className="text-[12px] text-ink-3 text-pretty">{b.logoHelp}</p>
          <ErrorLine>{logoError}</ErrorLine>
        </section>

        <fieldset className="min-w-0 space-y-5" disabled={!canEdit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field error={accentInvalid ? b.errors.accent : undefined} hint={b.accentHelp} id="accentColor" label={b.accent}>
              <div className="flex items-center gap-2">
                <input
                  aria-label={b.accentPick}
                  className="h-8 w-10 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
                  onChange={(event) => setAccent(event.target.value)}
                  type="color"
                  value={hex ?? "#1f2328"}
                />
                <input
                  aria-invalid={accentInvalid ? true : undefined}
                  autoComplete="off"
                  className={inputClass}
                  id="accentColor"
                  onChange={(event) => setAccent(event.target.value)}
                  placeholder={b.accentPlaceholder}
                  spellCheck={false}
                  value={accent}
                />
                {accent ? (
                  <Button className="shrink-0 whitespace-nowrap" onClick={() => setAccent("")} size="xs" type="button" variant="quiet">
                    {b.accentClear}
                  </Button>
                ) : null}
              </div>
            </Field>
            <div aria-hidden="true" className="grid content-end">
              {/* The table heading as the PDF draws it, with the text color the PDF picks. */}
              <div
                className="flex h-[22px] items-center justify-between rounded-[3px] px-1.5 text-[10px] font-semibold"
                style={{ background: swatch ? css(swatch.fill) : "rgb(242 244 247)", color: swatch ? css(swatch.onFill) : "rgb(107 112 120)" }}
              >
                <span>{pdf.service}</span>
                <span>{pdf.amount}</span>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <h3 className="text-[13px] font-medium">{b.details}</h3>
              <p className="text-[12px] text-ink-3">{b.detailsHelp}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {PDF_DETAILS.map((detail) => (
                <label className="flex items-center gap-2 text-[13px] text-ink" key={detail}>
                  <input
                    checked={show[detail]}
                    className="size-4 accent-[var(--color-ink)]"
                    onChange={(event) => setShow((current) => ({ ...current, [detail]: event.target.checked }))}
                    type="checkbox"
                  />
                  {b.detailNames[detail]}
                  {facts[detail] ? null : <span className="text-[12px] text-ink-3">({b.notSaved})</span>}
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-4">
            {(
              [
                ["quoteFooter", b.quoteFooter, quoteFooter, setQuoteFooter, pdf.thanks],
                ["invoiceFooter", b.invoiceFooter, invoiceFooter, setInvoiceFooter, pdf.invoiceThanks],
              ] as const
            ).map(([id, label, value, setValue, standard]) => (
              <Field
                error={footerInvalid(value) ? b.errors.footer(FOOTER_MAX_CHARS) : undefined}
                hint={b.footerHelp(FOOTER_MAX_CHARS)}
                id={id}
                key={id}
                label={label}
              >
                <textarea
                  aria-invalid={footerInvalid(value) ? true : undefined}
                  className={cn(inputClass, "h-20 py-1.5")}
                  id={id}
                  maxLength={FOOTER_MAX_CHARS * 2}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={standard}
                  value={value}
                />
              </Field>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={previewBusy !== null} onClick={() => void openPreview("quote")} size="sm" type="button">
            <FileText aria-hidden="true" className="size-3.5" />
            {previewBusy === "quote" ? b.previewing : b.previewQuote}
          </Button>
          <Button disabled={previewBusy !== null} onClick={() => void openPreview("invoice")} size="sm" type="button">
            <ReceiptText aria-hidden="true" className="size-3.5" />
            {previewBusy === "invoice" ? b.previewing : b.previewInvoice}
          </Button>
          {canEdit ? (
            <div className="ml-auto flex items-center gap-3">
              {notice ? (
                <p className="text-[13px] text-ink-2" role="status">
                  {notice}
                </p>
              ) : null}
              <ErrorLine>{error}</ErrorLine>
              <Button disabled={busy !== null} onClick={() => void save()} size="sm" type="button" variant="primary">
                {busy ? copy.common.saving : b.save}
              </Button>
            </div>
          ) : (
            <ErrorLine>{error}</ErrorLine>
          )}
        </div>
      </div>

      <Dialog onOpenChange={(open) => (open ? undefined : setPreview(null))} open={preview !== null}>
        <DialogContent className="h-[min(88vh,960px)] grid-rows-[auto_auto_1fr_auto] sm:max-w-3xl">
          <DialogTitle>{preview ? b.previewTitle(preview.kind) : null}</DialogTitle>
          <DialogDescription>{b.previewHelp}</DialogDescription>
          {preview ? <iframe className="size-full min-h-0 rounded-[8px] bg-white shadow-hairline" src={preview.url} title={b.previewTitle(preview.kind)} /> : <div />}
          <DialogFooter>
            {preview ? (
              <a
                className="inline-flex h-[27px] items-center gap-1.5 rounded-full px-3 text-[13px] text-ink hover:bg-hover"
                download={`sample-${preview.kind}.pdf`}
                href={preview.url}
              >
                <Download aria-hidden="true" className="size-3.5" />
                {b.download}
              </a>
            ) : null}
            <DialogClose render={<Button size="sm" variant="primary" />}>{b.close}</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
