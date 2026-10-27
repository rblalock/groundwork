import { createHash } from "node:crypto";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { businessProfile, messages, organization } from "../schema/schema";
import type { InboundAttachment } from "../schema/types";
import { deleteBlob, readStoredFile, storeLogo } from "./blob";
import { db } from "./db";
import { recordEvent } from "./events";
import { normalizeLogo, sniffImage } from "./logo";
import { isPrivileged, type Caller } from "./members";
import type { PdfLogo } from "./pdf";
import { PDF_DETAILS, type BrandingPatch, type PdfDetail } from "./pdf-style";
import { getProfileWith, type Profile } from "./profile";

// A business's branding: its logo (the stored URL on `organization.logo`) and how its PDFs look (on its
// profile, see `core/pdf-style.ts`). Only the owner and admins change it, from Settings or by text.
// None of it changes a quote's numbers, so it doesn't bump the profile's version.

export type Branding = {
  logoUrl: string | null;
  accentColor: string | null;
  quoteFooter: string | null;
  invoiceFooter: string | null;
  showOnPdf: Record<PdfDetail, boolean>;
};

export function brandingFrom(profile: Profile, logoUrl: string | null): Branding {
  const hidden = new Set(profile.pdfHiddenDetails);
  return {
    logoUrl,
    accentColor: profile.pdfAccentColor,
    quoteFooter: profile.quoteFooter,
    invoiceFooter: profile.invoiceFooter,
    showOnPdf: Object.fromEntries(PDF_DETAILS.map((d) => [d, !hidden.has(d)])) as Record<PdfDetail, boolean>,
  };
}

/**
 * The business as its customer pages show it. The address and license number are there only when the
 * business prints them on its PDFs, so a fact it keeps off its documents stays off its pages too.
 */
export type PageBusiness = {
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  licenseNumber: string | null;
  logoVersion: string | null;
};

export function pageBusiness(profile: Profile, logoVersion: string | null): PageBusiness {
  const hidden = new Set(profile.pdfHiddenDetails);
  return {
    name: profile.name,
    phone: profile.phone,
    email: profile.email,
    address: hidden.has("address") ? null : profile.address,
    licenseNumber: hidden.has("licenseNumber") ? null : profile.licenseNumber,
    logoVersion,
  };
}

async function logoUrlOf(orgId: string): Promise<string | null> {
  const [row] = await db().select({ logo: organization.logo }).from(organization).where(eq(organization.id, orgId));
  return row?.logo ?? null;
}

/** A short tag that changes whenever the logo does, for the URL the app shows it at, so a browser's copy goes stale with it. */
export function logoVersion(logoUrl: string | null): string | null {
  return logoUrl ? createHash("sha256").update(logoUrl).digest("hex").slice(0, 12) : null;
}

/** The business's logo version; null when it has none. */
export async function logoVersionFor(orgId: string): Promise<string | null> {
  return logoVersion(await logoUrlOf(orgId));
}

export async function getBranding(orgId: string): Promise<Branding> {
  const [profile, logoUrl] = await Promise.all([getProfileWith(orgId, db()), logoUrlOf(orgId)]);
  return brandingFrom(profile, logoUrl);
}

function requirePrivileged(actor: Caller): void {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
}

/** The profile with a patch applied, as the PDFs would read it: for saving, and for Settings' preview of unsaved changes. */
export function withBranding(profile: Profile, patch: Partial<BrandingPatch>): Profile {
  const hidden = new Set(profile.pdfHiddenDetails);
  for (const [detail, shown] of Object.entries(patch.showOnPdf ?? {})) {
    if (shown === true) hidden.delete(detail);
    if (shown === false) hidden.add(detail);
  }
  return {
    ...profile,
    pdfAccentColor: patch.accentColor === undefined ? profile.pdfAccentColor : patch.accentColor,
    quoteFooter: patch.quoteFooter === undefined ? profile.quoteFooter : patch.quoteFooter,
    invoiceFooter: patch.invoiceFooter === undefined ? profile.invoiceFooter : patch.invoiceFooter,
    pdfHiddenDetails: PDF_DETAILS.filter((d) => hidden.has(d)),
  };
}

/** Saves the PDF settings that differ from what's stored; returns what changed. Throws `NOT_PRIVILEGED` for crew. */
export async function updateBranding(actor: Caller, patch: BrandingPatch): Promise<{ branding: Branding; changed: string[] }> {
  requirePrivileged(actor);
  const { orgId } = actor;
  const profile = await db().transaction(async (tx) => {
    const current = await getProfileWith(orgId, tx);
    const next = withBranding(current, patch);
    const changes: Partial<Profile> = {};
    if (next.pdfAccentColor !== current.pdfAccentColor) changes.pdfAccentColor = next.pdfAccentColor;
    if (next.quoteFooter !== current.quoteFooter) changes.quoteFooter = next.quoteFooter;
    if (next.invoiceFooter !== current.invoiceFooter) changes.invoiceFooter = next.invoiceFooter;
    if (next.pdfHiddenDetails.join() !== current.pdfHiddenDetails.join()) changes.pdfHiddenDetails = next.pdfHiddenDetails;
    const fields = Object.keys(changes);
    if (fields.length === 0) return { row: current, fields };
    const [row] = await tx
      .update(businessProfile)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(businessProfile.orgId, orgId))
      .returning();
    await recordEvent({ orgId, kind: "branding.updated", memberId: actor.memberId, data: { fields } }, tx);
    return { row, fields };
  });
  return { branding: brandingFrom(profile.row, await logoUrlOf(orgId)), changed: profile.fields };
}

/**
 * Checks, normalizes, and stores a new logo, replacing the one before (`core/logo.ts` for what's
 * refused and why). Throws `NOT_PRIVILEGED` for crew.
 */
export async function setLogo(actor: Caller, bytes: Uint8Array): Promise<{ logoUrl: string; width: number; height: number }> {
  requirePrivileged(actor);
  const logo = await normalizeLogo(bytes);
  const url = await storeLogo(actor.orgId, logo.mimeType, logo.bytes);
  const previous = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ logo: organization.logo })
      .from(organization)
      .where(eq(organization.id, actor.orgId))
      .for("update");
    await tx.update(organization).set({ logo: url }).where(eq(organization.id, actor.orgId));
    await recordEvent(
      { orgId: actor.orgId, kind: "branding.logo_set", memberId: actor.memberId, data: { width: logo.width, height: logo.height, type: logo.mimeType } },
      tx,
    );
    return row?.logo ?? null;
  });
  if (previous && previous !== url) await deleteBlob(previous).catch((error) => console.error("branding: old logo delete failed", error));
  return { logoUrl: url, width: logo.width, height: logo.height };
}

/** Takes the logo off; PDFs and the app go back to the business's name alone. Throws `NOT_PRIVILEGED` for crew. */
export async function removeLogo(actor: Caller): Promise<{ removed: boolean }> {
  requirePrivileged(actor);
  const previous = await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ logo: organization.logo })
      .from(organization)
      .where(eq(organization.id, actor.orgId))
      .for("update");
    if (!row?.logo) return null;
    await tx.update(organization).set({ logo: null }).where(eq(organization.id, actor.orgId));
    await recordEvent({ orgId: actor.orgId, kind: "branding.logo_removed", memberId: actor.memberId }, tx);
    return row.logo;
  });
  if (previous) await deleteBlob(previous).catch((error) => console.error("branding: logo delete failed", error));
  return { removed: previous !== null };
}

/** The stored logo's bytes and type; null when there's none, or it can't be read (a fake store has no bytes). */
export async function readLogo(logoUrl: string | null): Promise<PdfLogo | null> {
  if (!logoUrl) return null;
  try {
    const bytes = await readStoredFile(logoUrl);
    if (!bytes) return null;
    const format = sniffImage(bytes);
    if (format !== "png" && format !== "jpeg") return null;
    return { bytes, mimeType: format === "png" ? "image/png" : "image/jpeg" };
  } catch (error) {
    console.warn("branding: the logo could not be read", error);
    return null;
  }
}

/** The business's logo for its PDFs; null when it has none or it can't be read. */
export async function loadLogo(orgId: string): Promise<PdfLogo | null> {
  return readLogo(await logoUrlOf(orgId));
}

/** The half hour the assistant looks back for the photo a member means by "use this as our logo". */
export const LOGO_TEXT_WINDOW_MS = 30 * 60 * 1000;

const isImage = (a: InboundAttachment): boolean => a.type === "image" || /^image\//i.test(a.mimeType ?? "");

/**
 * Sets the logo from the image on this member's newest text that has one, from the last half hour. The
 * image is set aside as a document, so it never attaches to a quote. Throws `NO_TEXTED_IMAGE` when there
 * is none, and the codes `setLogo` throws.
 */
export async function setLogoFromText(actor: Caller, now: Date = new Date()): Promise<{ logoUrl: string; width: number; height: number }> {
  requirePrivileged(actor);
  const [message] = await db()
    .select({ id: messages.id, attachments: messages.attachments })
    .from(messages)
    .where(
      and(
        eq(messages.orgId, actor.orgId),
        eq(messages.memberId, actor.memberId),
        eq(messages.direction, "inbound"),
        gte(messages.createdAt, new Date(now.getTime() - LOGO_TEXT_WINDOW_MS)),
        sql`exists (select 1 from jsonb_array_elements(${messages.attachments}) a where a->>'type' = 'image' or a->>'mimeType' ilike 'image/%')`,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  const image = message?.attachments.find(isImage);
  if (!message || !image) throw new Error("NO_TEXTED_IMAGE");
  const bytes = await readStoredFile(image.url).catch(() => null);
  if (!bytes) throw new Error("LOGO_UNREADABLE");
  const result = await setLogo(actor, bytes);
  await db()
    .update(messages)
    .set({ attachments: message.attachments.map((a) => (a === image ? { ...a, document: true } : a)) })
    .where(and(eq(messages.orgId, actor.orgId), eq(messages.id, message.id)));
  return result;
}
