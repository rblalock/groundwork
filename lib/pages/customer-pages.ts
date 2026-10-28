// Settings → Branding → customer pages: owners and admins design the business's own quote and invoice
// pages with the page designer (agents/designer/), see them filled with a sample or one of their own
// documents, publish a version, or go back to the standard page. The designer page's chat is the
// member's conversation with the designer about that page; its preview shows a page as the designer
// writes it (`html`, from the conversation's stream) and each version it saves.
import { and, desc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { Client } from "eve/client";
import { z } from "zod";
import { invoices, quotes } from "../../schema/schema";
import { agentSessionFor, ensureAgentSession, forgetAgentSession } from "../../core/agent-sessions";
import { getBranding, pageBusiness, readLogo } from "../../core/branding";
import { CUSTOMER_PAGE_KINDS, TEMPLATE_MAX_BYTES, type CustomerPageKind } from "../../core/customer-page-template";
import {
  customerPageState,
  getVersion,
  latestVersion,
  listVersions,
  publishVersion,
  restoreVersion,
  saveVersion,
  useStandardPage,
  type CustomerPageState,
} from "../../core/customer-pages";
import { db } from "../../core/db";
import { agentHost } from "../../core/jobs";
import type { Language } from "../../core/language";
import { getProfile } from "../../core/profile";
import { invoiceSlots, quoteSlots, renderCustomerPage, type PayShown, type QuoteShown } from "../customer-pages";
import { DESIGN_PAGE_HEADER } from "../eve-auth";
import { HttpError, type AppCaller } from "../guards";
import { quoteLinkPage } from "../quote-page";
import { payPage } from "../stripe";
import { privilegedActor, refuse } from "./access";

export const pageKindSchema = z.enum(CUSTOMER_PAGE_KINDS);

const ERRORS = {
  NOT_PRIVILEGED: [403, "Only the owner or an admin can do that."],
  PAGE_VERSION_NOT_FOUND: [404, "That version isn't here anymore."],
  TEMPLATE_INVALID: [422, "That design couldn't be used. Ask for it again."],
} as const;

function requireDesigner(caller: AppCaller): void {
  if (caller.role === "member") throw new HttpError(403, "NOT_PRIVILEGED", ERRORS.NOT_PRIVILEGED[1]);
}

/** Both pages' state, for Settings. */
export async function customerPagesFor(caller: AppCaller): Promise<Record<CustomerPageKind, CustomerPageState>> {
  requireDesigner(caller);
  const [quote, invoice] = await Promise.all([customerPageState(caller.orgId, "quote"), customerPageState(caller.orgId, "invoice")]);
  return { quote, invoice };
}

/**
 * The member's conversation with the designer about `page`, started the first time they open it, and
 * again if eve no longer has it, or no longer runs it: `ended` is the session a send was just refused on
 * as no longer active, which only the member's current one can be. It's created with their own sign-in
 * (`cookie`), so the designer's channel checks it as it checks every request of theirs
 * (lib/eve-auth.ts, `designerWebAuth`).
 */
export async function designSessionFor(caller: AppCaller, page: CustomerPageKind, cookie: string, ended?: string): Promise<string> {
  requireDesigner(caller);
  if (!caller.memberId) throw new HttpError(403, "NOT_PRIVILEGED", ERRORS.NOT_PRIVILEGED[1]);
  const who = { orgId: caller.orgId, memberId: caller.memberId };
  const existing = await agentSessionFor(who, "designer", page);
  if (existing && existing.eveSessionId !== ended && !(await sessionGone(cookie, existing.eveSessionId))) return existing.eveSessionId;
  if (existing) await forgetAgentSession(who, "designer", existing.eveSessionId);
  return ensureAgentSession(who, "designer", page, async () => {
    const client = new Client({ host: agentHost("designer"), redirect: "error", headers: { cookie, [DESIGN_PAGE_HEADER]: page } });
    const { session } = await client.sessions.create({ signal: AbortSignal.timeout(20_000) });
    return session.state.sessionId;
  });
}

/**
 * Whether eve answers that it has no such session: asking for its stream past any end it could have
 * returns at once. Only a 404 counts, so a slow or failed request never throws a conversation away.
 */
async function sessionGone(cookie: string, eveSessionId: string): Promise<boolean> {
  const client = new Client({ host: agentHost("designer"), redirect: "error", headers: { cookie } });
  const response = await client
    .fetch(`/eve/v1/session/${encodeURIComponent(eveSessionId)}/stream?follow=false&startIndex=1000000000`, { signal: AbortSignal.timeout(10_000) })
    .catch(() => null);
  await response?.body?.cancel().catch(() => undefined);
  return response?.status === 404;
}

export type EditorData = {
  state: CustomerPageState;
  versions: Array<{ version: number; request: string | null; createdAt: string }>;
  /** Whether a real document of this kind can fill the preview. */
  hasRecent: boolean;
};

export async function editorFor(caller: AppCaller, page: CustomerPageKind): Promise<EditorData> {
  requireDesigner(caller);
  const [state, versions, recent] = await Promise.all([customerPageState(caller.orgId, page), listVersions(caller.orgId, page), recentToken(caller.orgId, page)]);
  return { state, versions: versions.map((v) => ({ version: v.version, request: v.request, createdAt: v.createdAt.toISOString() })), hasRecent: recent !== null };
}

// --- Previews -------------------------------------------------------------------------------------

export const SAMPLE_STATES = { quote: ["open", "approved", "expired"], invoice: ["payable", "paid", "void"] } as const;

export const previewSchema = z
  .object({
    version: z.number().int().positive().optional(),
    source: z.enum(["sample", "recent"]).default("sample"),
    state: z.string().max(20).optional(),
    language: z.enum(["en", "es"]).default("en"),
    /** A page still being written, from the thread's stream, in place of a saved version. */
    html: z.string().max(TEMPLATE_MAX_BYTES * 2).optional(),
  })
  .strict();
export type PreviewInput = z.infer<typeof previewSchema>;

/** The newest quote or invoice a customer could have opened, by its link's token. */
async function recentToken(orgId: string, page: CustomerPageKind): Promise<string | null> {
  if (page === "quote") {
    const [row] = await db()
      .select({ token: quotes.customerToken })
      .from(quotes)
      .where(and(eq(quotes.orgId, orgId), isNotNull(quotes.customerToken), inArray(quotes.status, ["approved", "sent", "won"])))
      .orderBy(desc(quotes.updatedAt))
      .limit(1);
    return row?.token ?? null;
  }
  const [row] = await db()
    .select({ token: invoices.payToken })
    .from(invoices)
    .where(and(eq(invoices.orgId, orgId), ne(invoices.status, "draft")))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  return row?.token ?? null;
}

const SAMPLE_TOKEN = "sample";

/** Obviously made-up documents, in the business's own name, for a preview. */
function sampleQuote(business: QuoteShown["business"], orgId: string, state: string, language: Language, linePrices: boolean): QuoteShown {
  const kind = state === "approved" || state === "expired" ? state : "open";
  const es = language === "es";
  const price = (cents: number) => (linePrices ? cents : null);
  return {
    kind,
    orgId,
    business,
    language,
    quote: {
      title: es ? "Trabajo de muestra" : "Sample job",
      revisionId: "sample",
      customerName: es ? "Cliente de muestra" : "Sample Customer",
      address: "123 Example St",
      linePrices,
      lines: [
        { name: es ? "Visita de servicio" : "Service visit", quantity: 1, unitLabel: null, unitCents: price(9500), totalCents: price(9500) },
        { name: es ? "Mano de obra" : "Labor", quantity: 3, unitLabel: es ? "h" : "hr", unitCents: price(8500), totalCents: price(25500) },
        { name: es ? "Materiales" : "Materials", quantity: 1, unitLabel: null, unitCents: price(14200), totalCents: price(14200) },
      ],
      ruleLines: [],
      subtotalCents: 49200,
      minimumAppliedCents: 0,
      adjustmentCents: 0,
      override: false,
      taxRateBp: 725,
      taxCents: 3567,
      totalCents: 52767,
      validUntil: "2099-12-31",
      notes: es ? "Esto es una muestra." : "This is a sample.",
      pdfUrl: "https://example.com/sample.pdf",
      pricedPhoto: null,
    },
    approval: kind === "approved" ? { name: es ? "Cliente de muestra" : "Sample Customer", at: "2099-01-15" } : null,
    deposit: { cents: 15000, paidCents: 0, dueCents: 15000, payable: true },
    payments: [],
  };
}

function sampleInvoice(business: PayShown["business"], orgId: string, state: string, language: Language): PayShown {
  const kind = state === "paid" || state === "void" ? state : "payable";
  const paid = kind === "paid" ? 52767 : 0;
  return {
    kind,
    orgId,
    business,
    invoice: { label: "INV-0000", title: language === "es" ? "Trabajo de muestra" : "Sample job", balanceCents: 52767 - paid, totalCents: 52767, paidCents: paid, issueDate: "2099-01-15", dueDate: "2099-01-30", language },
    payments: paid ? [{ id: "sample", receivedDate: "2099-01-20", method: "card", card: "Visa •••• 4242", amountCents: paid }] : [],
  };
}

async function logoDataUrl(orgId: string): Promise<string | null> {
  const logo = await readLogo((await getBranding(orgId)).logoUrl);
  return logo ? `data:${logo.mimeType};base64,${Buffer.from(logo.bytes).toString("base64")}` : null;
}

/** What fills a preview: the sample in the asked state and language, or the newest real document as it stands. */
async function previewValues(orgId: string, page: CustomerPageKind, input: PreviewInput) {
  const logoSrc = await logoDataUrl(orgId);
  const target = { token: SAMPLE_TOKEN, logoSrc, preview: true };
  if (input.source === "recent") {
    const token = await recentToken(orgId, page);
    if (token) {
      if (page === "quote") {
        const real = await quoteLinkPage(token);
        if ("quote" in real && real.orgId === orgId) return quoteSlots(real, target);
      } else {
        const real = await payPage(token);
        if (real.kind !== "not_found" && real.orgId === orgId) return invoiceSlots(real, target);
      }
    }
  }
  const profile = await getProfile(orgId);
  const business = pageBusiness(profile, null);
  return page === "quote"
    ? quoteSlots(sampleQuote(business, orgId, input.state ?? "open", input.language, profile.customerLinePrices), target)
    : invoiceSlots(sampleInvoice(business, orgId, input.state ?? "payable", input.language), target);
}

/**
 * A page filled for the preview: the one being written (`html`), or a version (the newest when none
 * is named). Null before the first design. A half-written page is cleaned like any other and shown in
 * the preview's sandbox, so nothing in it runs or loads.
 */
export async function previewFor(caller: AppCaller, page: CustomerPageKind, input: PreviewInput): Promise<string | null> {
  requireDesigner(caller);
  return renderPreview(caller.orgId, page, input);
}

/** The preview itself, for whoever already checked who's asking: the editor, and the designer looking at its work. */
export async function renderPreview(orgId: string, page: CustomerPageKind, input: PreviewInput): Promise<string | null> {
  const html = input.html ?? (input.version ? await getVersion(orgId, page, input.version) : await latestVersion(orgId, page))?.html;
  if (!html) return null;
  return renderCustomerPage(html, page, await previewValues(orgId, page, input), { preview: true });
}

// --- Publishing -----------------------------------------------------------------------------------

export const publishSchema = z.object({ version: z.number().int().positive().optional() }).strict();
export const restoreSchema = z.object({ version: z.number().int().positive() }).strict();

export async function publishFromApp(caller: AppCaller, page: CustomerPageKind, version?: number): Promise<CustomerPageState> {
  return publishVersion(privilegedActor(caller), page, version).catch((error) => refuse(error, ERRORS));
}

export async function standardFromApp(caller: AppCaller, page: CustomerPageKind): Promise<CustomerPageState> {
  return useStandardPage(privilegedActor(caller), page).catch((error) => refuse(error, ERRORS));
}

export async function restoreFromApp(caller: AppCaller, page: CustomerPageKind, version: number): Promise<{ version: number }> {
  const restored = await restoreVersion(privilegedActor(caller), page, version).catch((error) => refuse(error, ERRORS));
  return { version: restored.version };
}
