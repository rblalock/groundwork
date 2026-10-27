import { asc, eq } from "drizzle-orm";
import { organization } from "../schema/schema";
import { db, newId } from "./db";

export type Organization = typeof organization.$inferSelect;

/** Lowercase letters, digits, and single dashes, from a business name. "business" when nothing is left. */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "business";
}

/** Creates a business. The slug defaults to one made from the name; a slug in use throws `SLUG_TAKEN`. */
export async function createOrganization(input: { name: string; slug?: string; id?: string }): Promise<Organization> {
  const slug = input.slug ?? slugify(input.name);
  const [row] = await db()
    .insert(organization)
    .values({ id: input.id ?? newId("org"), name: input.name.trim(), slug })
    .onConflictDoNothing({ target: organization.slug })
    .returning();
  if (!row) throw new Error("SLUG_TAKEN");
  return row;
}

export async function getOrganization(id: string): Promise<Organization | null> {
  const [row] = await db().select().from(organization).where(eq(organization.id, id));
  return row ?? null;
}

export async function findOrganizationBySlug(slug: string): Promise<Organization | null> {
  const [row] = await db().select().from(organization).where(eq(organization.slug, slug));
  return row ?? null;
}

/** Every business, oldest first. */
export function listOrganizations(): Promise<Organization[]> {
  return db().select().from(organization).orderBy(asc(organization.createdAt), asc(organization.id));
}

/**
 * Whether a super admin has paused the business. Paused businesses get no turns, texts, or web pages;
 * payments still record. Unknown businesses count as not paused (their own lookups refuse them).
 */
export async function isSuspended(orgId: string): Promise<boolean> {
  const [row] = await db().select({ suspended: organization.suspended }).from(organization).where(eq(organization.id, orgId));
  return row?.suspended ?? false;
}

/** Pauses or resumes a business. Super admins only (the admin route checks). Throws `NO_SUCH_BUSINESS`. */
export async function setSuspended(orgId: string, suspended: boolean, now: Date = new Date()): Promise<Organization> {
  const [row] = await db()
    .update(organization)
    .set({ suspended, suspendedAt: suspended ? now : null })
    .where(eq(organization.id, orgId))
    .returning();
  if (!row) throw new Error("NO_SUCH_BUSINESS");
  console.info("organizations: business", suspended ? "paused" : "resumed", { orgId });
  return row;
}

/** Thrown where a paused business's work would run; the tool hint and route guards explain it. */
export class BusinessSuspendedError extends Error {
  constructor() {
    super("BUSINESS_SUSPENDED");
    this.name = "BusinessSuspendedError";
  }
}
