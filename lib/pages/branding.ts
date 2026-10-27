import { eq } from "drizzle-orm";
import { organization } from "../../schema/schema";
import type { LineResult } from "../../schema/types";
import { getBranding, readLogo, removeLogo, setLogo, updateBranding, withBranding, type Branding } from "../../core/branding";
import { db } from "../../core/db";
import { invoiceByPayToken } from "../../core/invoices";
import { isLanguage, type Language } from "../../core/language";
import { LOGO_MAX_BYTES } from "../../core/logo";
import { renderInvoicePdf, renderQuotePdf } from "../../core/pdf";
import { z } from "zod";
import { brandingFieldsSchema, brandingPatchSchema, type BrandingPatch } from "../../core/pdf-style";
import { getProfile } from "../../core/profile";
import { quoteByCustomerToken } from "../../core/quote-link";
import { addDays, todayYmd } from "../../core/time";
import { HttpError, type AppCaller } from "../guards";
import { privilegedActor, refuse } from "./access";

export { brandingPatchSchema };

/** What Settings previews: a sample quote or invoice, with the form's PDF settings as they stand, saved or not. */
export const previewInputSchema = z.object({
  kind: z.enum(["quote", "invoice"]).default("quote"),
  branding: brandingFieldsSchema.default({}),
});

// Settings' logo and PDF look, for owners and admins; and the logo itself, served to the web app's
// shell (any member of the business) and to an invoice's pay page (whoever holds the link).

const LOGO_ERRORS = {
  NOT_PRIVILEGED: [403, "Only the owner or an admin can do that."],
  LOGO_TOO_LARGE: [413, "That image is too big. Choose a PNG or JPEG under 5 MB."],
  LOGO_UNSUPPORTED: [415, "Choose a PNG or JPEG. WebP, GIF, and SVG can't be used yet."],
  LOGO_UNREADABLE: [400, "That image couldn't be opened. Try another PNG or JPEG."],
  LOGO_TOO_SMALL: [400, "That image is too small to print. Choose a bigger one."],
  LOGO_ANIMATED: [400, "Choose a still image, not an animated one."],
} as const;

/** The business's branding, for owners and admins. */
export async function brandingSettingsFor(caller: AppCaller): Promise<Branding> {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  return getBranding(caller.orgId);
}

export async function updateBrandingFromApp(caller: AppCaller, patch: BrandingPatch): Promise<{ branding: Branding; changed: string[] }> {
  return updateBranding(privilegedActor(caller), patch).catch((error) => refuse(error, LOGO_ERRORS));
}

/** Reads a request body up to the logo limit; the declared length is only an early refusal. */
export async function readLogoUpload(request: Request): Promise<Uint8Array> {
  const tooLarge = () => new HttpError(413, "LOGO_TOO_LARGE", LOGO_ERRORS.LOGO_TOO_LARGE[1]);
  if (Number(request.headers.get("content-length")) > LOGO_MAX_BYTES) {
    void request.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!request.body) throw new HttpError(400, "LOGO_UNREADABLE", LOGO_ERRORS.LOGO_UNREADABLE[1]);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LOGO_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(chunks, size));
}

/** An owner or admin uploads a new logo; it replaces the one before at once. */
export async function uploadLogoFromApp(caller: AppCaller, request: Request): Promise<{ branding: Branding }> {
  const actor = privilegedActor(caller);
  const bytes = await readLogoUpload(request);
  await setLogo(actor, bytes).catch((error) => refuse(error, LOGO_ERRORS));
  return { branding: await getBranding(caller.orgId) };
}

export async function removeLogoFromApp(caller: AppCaller): Promise<{ branding: Branding }> {
  await removeLogo(privilegedActor(caller)).catch((error) => refuse(error, LOGO_ERRORS));
  return { branding: await getBranding(caller.orgId) };
}

/** Obviously made-up lines, priced so the totals read plainly. */
function sampleLines(language: Language): LineResult[] {
  const es = language === "es";
  return [
    { itemId: null, name: es ? "Servicio de ejemplo" : "Sample service", unitLabel: es ? "c/u" : "each", quantity: 2, unitCents: 5000, taxable: true, source: "pricebook", totalCents: 10000 },
    { itemId: null, name: es ? "Otro servicio de ejemplo" : "Another sample service", unitLabel: es ? "hora" : "hour", quantity: 1.5, unitCents: 4000, taxable: true, source: "pricebook", totalCents: 6000 },
  ];
}

/**
 * A sample quote or invoice PDF with the business's logo and these PDF settings (saved or not), so an
 * owner sees the look before a real one goes out. The customer, address, and lines are made up and say so.
 */
export async function brandingPreview(caller: AppCaller, input: { kind: "quote" | "invoice"; patch: Partial<BrandingPatch> }): Promise<Uint8Array> {
  // Looking changes nothing, so a super admin viewing the business may preview too.
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", "Only the owner or an admin can do that.");
  const [stored, logo] = await Promise.all([getProfile(caller.orgId), getBranding(caller.orgId).then((b) => readLogo(b.logoUrl))]);
  const profile = withBranding(stored, input.patch);
  const language: Language = isLanguage(profile.language) ? profile.language : "en";
  const es = language === "es";
  const lines = sampleLines(language);
  const subtotal = lines.reduce((sum, line) => sum + (line.totalCents ?? 0), 0);
  const customer = { name: es ? "Cliente de ejemplo" : "Sample Customer", phones: ["555-0100"], emails: ["sample@example.com"] };
  const property = { address: es ? "Calle Ejemplo 123" : "123 Example St" };
  const note = es ? "Esto es un ejemplo para ver cómo se ven tus PDF. No es una cotización real." : "This is a sample to show how your PDFs look. It isn't a real quote.";
  const today = todayYmd(profile.timeZone, new Date());
  if (input.kind === "invoice") {
    return renderInvoicePdf({
      profile,
      label: "INV-0000",
      title: property.address,
      status: "sent",
      issueDate: today,
      dueDate: addDays(today, profile.paymentTermsDays),
      lines,
      ruleLines: [],
      adjustments: [],
      subtotalCents: subtotal,
      minimumAppliedCents: 0,
      adjustmentCents: 0,
      taxRateBp: null,
      taxCents: 0,
      totalCents: subtotal,
      amountPaidCents: 0,
      notes: es ? "Esto es un ejemplo para ver cómo se ven tus PDF. No es una factura real." : "This is a sample to show how your PDFs look. It isn't a real invoice.",
      customer,
      property,
      payUrl: null,
      language,
      logo,
    });
  }
  return renderQuotePdf({
    profile,
    quoteId: "sample",
    title: property.address,
    status: "approved",
    revision: {
      number: 1,
      lines,
      ruleLines: [],
      adjustments: [],
      subtotalCents: subtotal,
      minimumAppliedCents: 0,
      adjustmentCents: 0,
      taxRateBp: null,
      taxCents: 0,
      totalCents: subtotal,
      validUntil: addDays(today, profile.quoteValidityDays),
      customerNotes: note,
    },
    customer,
    property,
    language,
    logo,
  });
}

/** The logo's bytes as an image response, or a 404 when there's none to show. */
async function logoResponse(logoUrl: string | null): Promise<Response> {
  const logo = await readLogo(logoUrl);
  if (!logo) return Response.json({ error: "That isn't here.", code: "NOT_FOUND" }, { status: 404 });
  return new Response(new Uint8Array(logo.bytes), {
    headers: {
      "content-type": logo.mimeType,
      // The URL carries the logo's version, so a replaced logo is a new URL.
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    },
  });
}

/** The caller's own business's logo, for the app's shell. Never another business's: the business comes from the session. */
export async function appLogo(caller: AppCaller): Promise<Response> {
  const [row] = await db().select({ logo: organization.logo }).from(organization).where(eq(organization.id, caller.orgId));
  return logoResponse(row?.logo ?? null);
}

/** The logo of the business that sent the invoice behind a pay link; drafts aren't the customer's yet, so they look missing. */
export async function payLogo(token: string): Promise<Response> {
  const invoice = await invoiceByPayToken(token);
  if (!invoice || invoice.status === "draft") return logoResponse(null);
  const [row] = await db().select({ logo: organization.logo }).from(organization).where(eq(organization.id, invoice.orgId));
  return logoResponse(row?.logo ?? null);
}

/** The logo of the business behind a quote's customer link; a draft isn't the customer's yet, so it looks missing. */
export async function quoteLinkLogo(token: string): Promise<Response> {
  const quote = await quoteByCustomerToken(token);
  if (!quote || quote.status === "draft" || quote.status === "needs_owner") return logoResponse(null);
  const [row] = await db().select({ logo: organization.logo }).from(organization).where(eq(organization.id, quote.orgId));
  return logoResponse(row?.logo ?? null);
}
