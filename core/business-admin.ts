import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { businessProfile, loginCodes, memberPhones, organization, session } from "../schema/schema";
import { agentMailGateway } from "./agentmail";
import { db, newId } from "./db";
import { recordEvent } from "./events";
import { findMemberById, findMemberByPhone, normalizeE164 } from "./members";
import { getOrganization } from "./organizations";
import { getProfileWith } from "./profile";
import { createPhotonAdmin, type PhotonAdmin } from "./photon-admin";

// A super admin's fixes to one business, for when its people can't make them: a new name or slug, an
// owner's new phone (they can't sign in to change it), and taking its email inbox away. Each throws
// `NO_SUCH_BUSINESS` for a business that isn't there.

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Renames the business: its name, which the profile, PDFs, pages, and web app show, and its slug. Throws
 * `INVALID_NAME`, `INVALID_SLUG`, or `SLUG_TAKEN`. An inbox keeps the address it was made with.
 */
export async function renameBusiness(orgId: string, input: { name: string; slug: string }): Promise<{ name: string; slug: string }> {
  const name = input.name.replace(/\s+/g, " ").trim();
  const slug = input.slug.trim();
  if (!name || name.length > 120) throw new Error("INVALID_NAME");
  if (!SLUG_PATTERN.test(slug) || slug.length > 60) throw new Error("INVALID_SLUG");
  return db().transaction(async (tx) => {
    const [org] = await tx.select().from(organization).where(eq(organization.id, orgId)).for("update");
    if (!org) throw new Error("NO_SUCH_BUSINESS");
    const [taken] = await tx.select({ id: organization.id }).from(organization).where(and(eq(organization.slug, slug), ne(organization.id, orgId)));
    if (taken) throw new Error("SLUG_TAKEN");
    await tx.update(organization).set({ name, slug }).where(eq(organization.id, orgId));
    await getProfileWith(orgId, tx);
    await tx
      .update(businessProfile)
      .set({ name, version: sql`${businessProfile.version} + 1`, updatedAt: new Date() })
      .where(eq(businessProfile.orgId, orgId));
    await recordEvent({ orgId, kind: "business.renamed", data: { from: { name: org.name, slug: org.slug }, to: { name, slug } } }, tx);
    return { name, slug };
  });
}

/**
 * Moves a member from one phone to another. The new number is registered with Photon and starts
 * pending: their first text to `assignedLine` from it verifies it, as for a new member. The old number
 * is released from Photon, so it can join another business. The member is signed out of the web app
 * everywhere, and sign-in codes out for the old number are voided. Throws `INVALID_PHONE`, `PHONE_IN_USE`
 * (anyone's, this member's included), `MEMBER_NOT_FOUND`, or `PHONE_NOT_FOUND` (not this member's).
 */
export async function changeMemberPhone(
  orgId: string,
  input: { memberId: string; from: string; to: string },
  deps: { photon?: PhotonAdmin } = {},
): Promise<{ e164: string; assignedLine: string }> {
  const to = normalizeE164(input.to);
  if (!to) throw new Error("INVALID_PHONE");
  if (!(await getOrganization(orgId))) throw new Error("NO_SUCH_BUSINESS");
  const member = await findMemberById(orgId, input.memberId);
  if (!member) throw new Error("MEMBER_NOT_FOUND");
  const [old] = await db()
    .select()
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.memberId, member.id), eq(memberPhones.e164, input.from)));
  if (!old) throw new Error("PHONE_NOT_FOUND");
  if (await findMemberByPhone(to)) throw new Error("PHONE_IN_USE");

  const photon = deps.photon ?? createPhotonAdmin();
  const registered = await photon.ensureSharedUser({ e164: to, firstName: member.name.trim().split(/\s+/)[0] });
  await db().transaction(async (tx) => {
    await tx.delete(memberPhones).where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.id, old.id)));
    await tx.insert(memberPhones).values({
      id: newId("ph"),
      orgId,
      memberId: member.id,
      e164: to,
      photonUserId: registered.id,
      assignedLine: registered.assignedLine,
    });
    // A new number often means the old phone is lost or someone else's now: sign the member out
    // everywhere, and void any sign-in code still out for the old number.
    if (member.userId) await tx.delete(session).where(eq(session.userId, member.userId));
    await tx
      .update(loginCodes)
      .set({ consumedAt: new Date() })
      .where(and(eq(loginCodes.orgId, orgId), eq(loginCodes.phoneE164, old.e164), isNull(loginCodes.consumedAt)));
    await recordEvent({ orgId, kind: "member.phone_changed", refId: member.id, memberId: member.id }, tx);
  });
  // The member is already moved; a number left registered only waits to be reused, so don't fail on it.
  await photon.removeSharedUser(old.e164).catch((error) => console.error("business-admin: releasing the old number failed", { orgId }, error));
  console.info("business-admin: moved a member to a new phone", { orgId, memberId: member.id });
  return { e164: to, assignedLine: registered.assignedLine };
}

/**
 * Deletes the business's email inbox and the mail in it; forwarded emails then have nowhere to go until
 * a super admin makes another. A business with none is left as it is.
 */
export async function removeBusinessInbox(orgId: string): Promise<{ removed: boolean }> {
  const org = await getOrganization(orgId);
  if (!org) throw new Error("NO_SUCH_BUSINESS");
  if (!org.inboxId) return { removed: false };
  await agentMailGateway().deleteInbox(org.inboxId);
  const [cleared] = await db()
    .update(organization)
    .set({ inboxId: null, inboxAddress: null })
    .where(and(eq(organization.id, orgId), eq(organization.inboxId, org.inboxId)))
    .returning();
  if (cleared) await recordEvent({ orgId, kind: "email.inbox_removed", data: { address: org.inboxAddress } });
  console.info("email: removed a business's inbox", { orgId });
  return { removed: Boolean(cleared) };
}

