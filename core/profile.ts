import { eq, sql } from "drizzle-orm";
import { businessProfile, organization } from "../schema/schema";
import { db, type Db, type Tx } from "./db";
import { recordEvent } from "./events";
import type { Language } from "./language";
import type { Role } from "./members";

export type Profile = typeof businessProfile.$inferSelect;
export type ProfilePatch = Partial<
  Pick<
    Profile,
    | "name"
    | "phone"
    | "email"
    | "address"
    | "licenseNumber"
    | "timeZone"
    | "quietStartHour"
    | "quietEndHour"
    | "quoteValidityDays"
    | "followUpDays"
    | "minimumChargeCents"
    | "taxRateBp"
    | "paymentTermsDays"
    | "depositPercent"
    | "customerLinePrices"
    | "language"
  >
>;

/** Profile facts only the owner changes: the deposit customers pay up front by card. */
export const OWNER_ONLY_FIELDS = ["depositPercent"] as const satisfies readonly (keyof ProfilePatch)[];

/** Refuses a patch touching an owner-only fact from anyone but the owner. Throws `OWNER_ONLY`. */
export function assertMayPatchProfile(role: Role, patch: ProfilePatch): void {
  if (role !== "owner" && OWNER_ONLY_FIELDS.some((field) => patch[field] !== undefined)) throw new Error("OWNER_ONLY");
}

const DEFAULT_NAME = "This business";

/** Same as `getProfile`, on a given connection or transaction. */
export async function getProfileWith(orgId: string, executor: Db | Tx): Promise<Profile> {
  await executor
    .insert(businessProfile)
    .values({ orgId, name: DEFAULT_NAME })
    .onConflictDoNothing({ target: businessProfile.orgId });
  const [row] = await executor.select().from(businessProfile).where(eq(businessProfile.orgId, orgId));
  return row;
}

/** The business's language, which new customers and members start in when none is given. English before it has a profile. */
export async function businessLanguage(orgId: string, executor: Db | Tx = db()): Promise<Language> {
  const [row] = await executor.select({ language: businessProfile.language }).from(businessProfile).where(eq(businessProfile.orgId, orgId));
  return row?.language ?? "en";
}

/** The business's profile; inserts the default (named "This business") when missing. */
export function getProfile(orgId: string): Promise<Profile> {
  return getProfileWith(orgId, db());
}

export async function updateProfile(orgId: string, patch: ProfilePatch, memberId: string): Promise<Profile> {
  return db().transaction(async (tx) => {
    await getProfileWith(orgId, tx);
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as ProfilePatch;
    const [row] = await tx
      .update(businessProfile)
      .set({ ...changes, version: sql`${businessProfile.version} + 1`, updatedAt: new Date() })
      .where(eq(businessProfile.orgId, orgId))
      .returning();
    // The organization's name is what the web app shows for the business, so it follows the profile.
    if (changes.name) await tx.update(organization).set({ name: changes.name }).where(eq(organization.id, orgId));
    await recordEvent(
      { orgId, kind: "profile.updated", memberId, data: { fields: Object.keys(changes), version: row.version } },
      tx,
    );
    return row;
  });
}

/** Increment the pricebook or rules counter that invalidates stale quotes; returns the new value. */
export async function bumpVersion(
  orgId: string,
  which: "pricebook" | "rules",
  executor: Db | Tx = db(),
): Promise<number> {
  await getProfileWith(orgId, executor);
  const column = which === "pricebook" ? businessProfile.pricebookVersion : businessProfile.rulesVersion;
  const field = which === "pricebook" ? "pricebookVersion" : "rulesVersion";
  const [row] = await executor
    .update(businessProfile)
    .set({ [field]: sql`${column} + 1` })
    .where(eq(businessProfile.orgId, orgId))
    .returning({ value: column });
  return row.value;
}
