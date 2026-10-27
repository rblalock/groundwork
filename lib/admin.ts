import { and, asc, eq, sql } from "drizzle-orm";
import { memberPhones, members, organization } from "../schema/schema";
import { db } from "../core/db";

export type BusinessRow = {
  id: string;
  name: string;
  slug: string;
  /** Its first active owner's member id, for the phone change. */
  ownerId: string | null;
  ownerName: string | null;
  ownerPhone: string | null;
  /** The iMessage number the owner texts. */
  line: string | null;
  memberCount: number;
  /** Paused by a super admin. */
  suspended: boolean;
  /** Where its members forward emails, once a super admin has made it. */
  inboxAddress: string | null;
  createdAt: string;
};

/**
 * Every business, for the super admins' list: its first active owner and how many active members it
 * has. Reads across businesses on purpose; only `requireSuperAdmin` routes call it.
 */
export async function listBusinessesForAdmin(): Promise<BusinessRow[]> {
  const orgs = await db().select().from(organization).orderBy(asc(organization.createdAt), asc(organization.id));
  const counts = await db()
    .select({ orgId: members.orgId, count: sql<number>`count(*)::int` })
    .from(members)
    .where(eq(members.status, "active"))
    .groupBy(members.orgId);
  const owners = await db()
    .select({
      orgId: members.orgId,
      id: members.id,
      name: members.name,
      phone: memberPhones.e164,
      line: memberPhones.assignedLine,
      createdAt: members.createdAt,
    })
    .from(members)
    .leftJoin(memberPhones, and(eq(memberPhones.memberId, members.id), eq(memberPhones.orgId, members.orgId)))
    .where(and(eq(members.role, "owner"), eq(members.status, "active")))
    .orderBy(asc(members.createdAt), asc(members.id), asc(memberPhones.createdAt));
  return orgs.map((org) => {
    const owner = owners.find((o) => o.orgId === org.id);
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      ownerId: owner?.id ?? null,
      ownerName: owner?.name ?? null,
      ownerPhone: owner?.phone ?? null,
      line: owner?.line ?? null,
      memberCount: counts.find((c) => c.orgId === org.id)?.count ?? 0,
      suspended: org.suspended,
      inboxAddress: org.inboxAddress,
      createdAt: org.createdAt.toISOString(),
    };
  });
}
