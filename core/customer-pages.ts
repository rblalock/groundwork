// A business's customer page designs (core/customer-page-template.ts): each page's versions,
// and which one is live. Owners and admins design, publish, and go back to the standard page; a new
// version is a draft until it's published, so what customers see changes only when they say so.
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { customerPages, customerPageVersions } from "../schema/schema";
import { db, newId } from "./db";
import { recordEvent } from "./events";
import { isPrivileged, type Caller } from "./members";
import { getBranding } from "./branding";
import { BLOCK_GUIDE, checkTemplate, slotGuide, type CustomerPageKind } from "./customer-page-template";
import { getProfile } from "./profile";

/** Versions kept per page; older ones are dropped as new ones come, never the live one. */
export const VERSIONS_KEPT = 40;

export type PageVersion = { version: number; html: string; request: string | null; memberId: string | null; createdAt: Date };

export type CustomerPageState = {
  page: CustomerPageKind;
  /** The live version, or null when customers see the standard page. */
  published: { version: number; at: Date } | null;
  /** The newest version, published or not; null before the first design. */
  latest: PageVersion | null;
};

type Actor = Pick<Caller, "orgId" | "memberId" | "role">;

function requireDesigner(actor: Actor): void {
  if (!isPrivileged(actor.role)) throw new Error("NOT_PRIVILEGED");
}

async function pageRow(orgId: string, page: CustomerPageKind) {
  const [row] = await db()
    .select()
    .from(customerPages)
    .where(and(eq(customerPages.orgId, orgId), eq(customerPages.page, page)));
  return row ?? null;
}

const versionOf = (row: typeof customerPageVersions.$inferSelect): PageVersion => ({
  version: row.version,
  html: row.html,
  request: row.request,
  memberId: row.memberId,
  createdAt: row.createdAt,
});

export async function getVersion(orgId: string, page: CustomerPageKind, version: number): Promise<PageVersion | null> {
  const [row] = await db()
    .select()
    .from(customerPageVersions)
    .where(and(eq(customerPageVersions.orgId, orgId), eq(customerPageVersions.page, page), eq(customerPageVersions.version, version)));
  return row ? versionOf(row) : null;
}

export async function latestVersion(orgId: string, page: CustomerPageKind): Promise<PageVersion | null> {
  const [row] = await db()
    .select()
    .from(customerPageVersions)
    .where(and(eq(customerPageVersions.orgId, orgId), eq(customerPageVersions.page, page)))
    .orderBy(desc(customerPageVersions.version))
    .limit(1);
  return row ? versionOf(row) : null;
}

/** The page's versions, newest first, without their HTML. */
export async function listVersions(orgId: string, page: CustomerPageKind): Promise<Array<Omit<PageVersion, "html">>> {
  return db()
    .select({
      version: customerPageVersions.version,
      request: customerPageVersions.request,
      memberId: customerPageVersions.memberId,
      createdAt: customerPageVersions.createdAt,
    })
    .from(customerPageVersions)
    .where(and(eq(customerPageVersions.orgId, orgId), eq(customerPageVersions.page, page)))
    .orderBy(desc(customerPageVersions.version))
    .limit(VERSIONS_KEPT);
}

export async function customerPageState(orgId: string, page: CustomerPageKind): Promise<CustomerPageState> {
  const [row, latest] = await Promise.all([pageRow(orgId, page), latestVersion(orgId, page)]);
  const published = row?.publishedVersion != null && row.publishedAt ? { version: row.publishedVersion, at: row.publishedAt } : null;
  return { page, published, latest };
}

/** The live template of a page, or null for the standard page. What every customer view reads. */
export async function publishedTemplate(orgId: string, page: CustomerPageKind): Promise<string | null> {
  const [row] = await db()
    .select({ html: customerPageVersions.html })
    .from(customerPages)
    .innerJoin(
      customerPageVersions,
      and(
        eq(customerPageVersions.orgId, customerPages.orgId),
        eq(customerPageVersions.page, customerPages.page),
        eq(customerPageVersions.version, customerPages.publishedVersion),
      ),
    )
    .where(and(eq(customerPages.orgId, orgId), eq(customerPages.page, page)));
  return row?.html ?? null;
}

/**
 * Saves a new version of a page, as a draft. The template is checked first: `TEMPLATE_INVALID` with
 * the problems when it fails. Old versions past `VERSIONS_KEPT` go, except the live one.
 */
export async function saveVersion(actor: Actor, page: CustomerPageKind, html: string, request: string | null): Promise<PageVersion> {
  requireDesigner(actor);
  const check = checkTemplate(html, page);
  if (!check.ok) throw new Error(`TEMPLATE_INVALID: ${check.errors.join(" ")}`);
  const saved = await db().transaction(async (tx) => {
    // One writer per page at a time, so two saves can't take the same number.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`customer_page:${actor.orgId}:${page}`}))`);
    const [last] = await tx
      .select({ version: customerPageVersions.version })
      .from(customerPageVersions)
      .where(and(eq(customerPageVersions.orgId, actor.orgId), eq(customerPageVersions.page, page)))
      .orderBy(desc(customerPageVersions.version))
      .limit(1);
    const version = (last?.version ?? 0) + 1;
    const [row] = await tx
      .insert(customerPageVersions)
      .values({ id: newId("cpv"), orgId: actor.orgId, page, version, html: check.html, request: request?.slice(0, 2000) ?? null, memberId: actor.memberId })
      .returning();
    const [live] = await tx
      .select({ version: customerPages.publishedVersion })
      .from(customerPages)
      .where(and(eq(customerPages.orgId, actor.orgId), eq(customerPages.page, page)));
    const oldest = version - VERSIONS_KEPT;
    if (oldest > 0) {
      await tx
        .delete(customerPageVersions)
        .where(
          and(
            eq(customerPageVersions.orgId, actor.orgId),
            eq(customerPageVersions.page, page),
            lt(customerPageVersions.version, oldest + 1),
            live?.version != null ? sql`${customerPageVersions.version} <> ${live.version}` : sql`true`,
          ),
        );
    }
    return row;
  });
  await recordEvent({ orgId: actor.orgId, kind: "customer_page.saved", memberId: actor.memberId, data: { page, version: saved.version } });
  return versionOf(saved);
}

/** Makes a version (the newest when none is named) the one customers see. `PAGE_VERSION_NOT_FOUND` when there's no such version. */
export async function publishVersion(actor: Actor, page: CustomerPageKind, version?: number): Promise<CustomerPageState> {
  requireDesigner(actor);
  const target = version === undefined ? await latestVersion(actor.orgId, page) : await getVersion(actor.orgId, page, version);
  if (!target) throw new Error("PAGE_VERSION_NOT_FOUND");
  const now = new Date();
  await db()
    .insert(customerPages)
    .values({ orgId: actor.orgId, page, publishedVersion: target.version, publishedAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: [customerPages.orgId, customerPages.page], set: { publishedVersion: target.version, publishedAt: now, updatedAt: now } });
  await recordEvent({ orgId: actor.orgId, kind: "customer_page.published", memberId: actor.memberId, data: { page, version: target.version } });
  return customerPageState(actor.orgId, page);
}

/** Customers see the standard page again. The designs stay, to publish again later. */
export async function useStandardPage(actor: Actor, page: CustomerPageKind): Promise<CustomerPageState> {
  requireDesigner(actor);
  const now = new Date();
  await db()
    .update(customerPages)
    .set({ publishedVersion: null, publishedAt: null, updatedAt: now })
    .where(and(eq(customerPages.orgId, actor.orgId), eq(customerPages.page, page)));
  await recordEvent({ orgId: actor.orgId, kind: "customer_page.standard", memberId: actor.memberId, data: { page } });
  return customerPageState(actor.orgId, page);
}

/** An earlier version comes back as the newest, a draft until it's published. */
export async function restoreVersion(actor: Actor, page: CustomerPageKind, version: number): Promise<PageVersion> {
  requireDesigner(actor);
  const old = await getVersion(actor.orgId, page, version);
  if (!old) throw new Error("PAGE_VERSION_NOT_FOUND");
  return saveVersion(actor, page, old.html, `Restored version ${version}`);
}

export type PageEdit = { old_string: string; new_string: string };

/** Applies exact replacements in order; each must match exactly once in the text as it stands. */
export function applyEdits(html: string, edits: readonly PageEdit[]): { ok: true; html: string } | { ok: false; error: string } {
  let out = html;
  for (const [index, edit] of edits.entries()) {
    const first = out.indexOf(edit.old_string);
    if (!edit.old_string || first < 0) return { ok: false, error: `Edit ${index + 1}: old_string isn't in the page as it stands. Copy it exactly from read_customer_page.` };
    if (out.indexOf(edit.old_string, first + 1) >= 0) return { ok: false, error: `Edit ${index + 1}: old_string appears more than once. Include more around it so it matches once.` };
    out = out.slice(0, first) + edit.new_string + out.slice(first + edit.old_string.length);
  }
  return { ok: true, html: out };
}

/**
 * Changes the newest version of a page with exact replacements and saves the result as a new draft.
 * `PAGE_NOT_DESIGNED` before the first version, `PAGE_EDIT_FAILED` when an edit doesn't apply, and
 * `TEMPLATE_INVALID` when the result fails the check.
 */
export async function editVersion(actor: Actor, page: CustomerPageKind, edits: readonly PageEdit[], request: string | null): Promise<PageVersion> {
  requireDesigner(actor);
  const latest = await latestVersion(actor.orgId, page);
  if (!latest) throw new Error("PAGE_NOT_DESIGNED");
  const applied = applyEdits(latest.html, edits);
  if (!applied.ok) throw new Error(`PAGE_EDIT_FAILED: ${applied.error}`);
  return saveVersion(actor, page, applied.html, request);
}

/**
 * Everything the assistant designs a page from: the page's newest template (what edits replace text
 * in), which version customers see, the other page's template to match, the slots this page has and
 * how our blocks are marked up, and the business's own facts.
 */
export async function pageForDesign(orgId: string, page: CustomerPageKind) {
  const other: CustomerPageKind = page === "quote" ? "invoice" : "quote";
  const [state, otherLatest, profile, branding] = await Promise.all([customerPageState(orgId, page), latestVersion(orgId, other), getProfile(orgId), getBranding(orgId)]);
  return {
    page,
    version: state.latest?.version ?? null,
    liveVersion: state.published?.version ?? null,
    template: state.latest?.html ?? null,
    otherPage: otherLatest ? { page: other, template: otherLatest.html } : null,
    slots: slotGuide(page),
    blocks: BLOCK_GUIDE,
    business: {
      name: profile.name,
      hasPhone: Boolean(profile.phone),
      hasEmail: Boolean(profile.email),
      hasAddress: Boolean(profile.address) && branding.showOnPdf.address,
      hasLicense: Boolean(profile.licenseNumber) && branding.showOnPdf.licenseNumber,
      hasLogo: branding.logoUrl !== null,
    },
    // The PDFs customers download from the page: update_branding changes them.
    pdf: {
      accentColor: branding.accentColor,
      quoteFooter: branding.quoteFooter,
      invoiceFooter: branding.invoiceFooter,
      showOnPdf: branding.showOnPdf,
    },
  };
}
