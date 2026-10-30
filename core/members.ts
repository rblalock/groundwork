import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { customerContacts, memberPhones, members, organization, user } from "../schema/schema";
import { db, newId } from "./db";
import { isEmailAddress } from "./email";
import { cancelClaims, claimedByAnother, startClaim, type StartedClaim } from "./email-claims";
import { cleanEquipment } from "./equipment";
import { isLanguage, type Language } from "./language";
import { businessLanguage } from "./profile";

export type Member = typeof members.$inferSelect;
export type MemberPhone = typeof memberPhones.$inferSelect;
export type Role = "owner" | "admin" | "member";
export type PhoneStatus = "pending" | "verified" | "stopped";
/** The member behind a turn. `orgId` is their business: everything they do is scoped to it. */
export type Caller = {
  orgId: string;
  memberId: string;
  name: string;
  role: Role;
  language: Language;
  phoneE164: string | null;
};

/** Owner and admin are equivalent for money and prices. */
export function isPrivileged(role: Role): boolean {
  return role === "owner" || role === "admin";
}

const RANK: Record<Role, number> = { owner: 3, admin: 2, member: 1 };

/** True when `caller` is strictly above `target` on the team: owner over admin over crew. */
export function outranks(caller: { role: Role }, target: { role: Role }): boolean {
  return RANK[caller.role] > RANK[target.role];
}

/**
 * The one check on changing someone else on the team (their role, their forwarding email, removing or
 * bringing them back, or giving a new member a role): the caller must strictly outrank them, and the role
 * they'd have. The owner manages admins and crew, an admin manages crew, and nobody manages an owner but
 * that owner. Throws `NOT_PRIVILEGED`.
 */
export function assertOutranks(caller: { role: Role }, target: { role: Role }): void {
  if (!outranks(caller, target)) throw new Error("NOT_PRIVILEGED");
}

/**
 * Digits only: 10 digits, or 11 starting with 1, become +1XXXXXXXXXX (US default);
 * anything else with 8 to 15 digits becomes +digits. Otherwise null.
 */
export function normalizeE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

export async function createMember(input: {
  orgId: string;
  name: string;
  role: Role;
  language?: Language;
  addedByMemberId?: string;
}): Promise<Member> {
  const [row] = await db()
    .insert(members)
    .values({
      id: newId("mem"),
      orgId: input.orgId,
      name: input.name,
      role: input.role,
      language: input.language ?? (await businessLanguage(input.orgId)),
      addedByMemberId: input.addedByMemberId ?? null,
    })
    .returning();
  return row;
}

/** Marks the member removed and stops every phone. Throws `LAST_OWNER` when no active owner would remain. */
export async function removeMember(orgId: string, memberId: string): Promise<Member> {
  return db().transaction(async (tx) => {
    // Lock the active owners so two concurrent removals cannot both pass the check.
    const owners = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.orgId, orgId), eq(members.role, "owner"), eq(members.status, "active")))
      .for("update");
    const [member] = await tx.select().from(members).where(and(eq(members.orgId, orgId), eq(members.id, memberId)));
    if (!member) throw new Error("MEMBER_NOT_FOUND");
    if (member.role === "owner" && member.status === "active" && owners.every((o) => o.id === memberId)) {
      throw new Error("LAST_OWNER");
    }
    const [removed] = await tx
      .update(members)
      .set({ status: "removed" })
      .where(and(eq(members.orgId, orgId), eq(members.id, memberId)))
      .returning();
    await tx
      .update(memberPhones)
      .set({ status: "stopped" })
      .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.memberId, memberId)));
    return removed;
  });
}

/**
 * Adds a phone in `pending` state. Idempotent for the same member; throws `PHONE_IN_USE` for another
 * member's number, in this business or any other (a phone belongs to one business), and
 * `MEMBER_NOT_FOUND` for a member outside this business.
 */
export async function addPhone(orgId: string, memberId: string, e164: string): Promise<MemberPhone> {
  const normalized = normalizeE164(e164);
  if (!normalized) throw new Error("INVALID_PHONE");
  if (!(await findMemberById(orgId, memberId))) throw new Error("MEMBER_NOT_FOUND");
  await db()
    .insert(memberPhones)
    .values({ id: newId("ph"), orgId, memberId, e164: normalized })
    .onConflictDoNothing({ target: memberPhones.e164 });
  // Looked up across businesses on purpose: the unique phone may be another business's.
  const [row] = await db().select().from(memberPhones).where(eq(memberPhones.e164, normalized));
  if (row.memberId !== memberId || row.orgId !== orgId) throw new Error("PHONE_IN_USE");
  return row;
}

/**
 * Brings a removed member back (rehiring by text): active again with the given name, role, and
 * adder, and the phone set back to pending so their next text verifies it and gets the welcome.
 * Throws `PHONE_NOT_FOUND` when the phone is not this member's.
 */
export async function reactivateMember(
  orgId: string,
  memberId: string,
  e164: string,
  input: { name: string; role: Role; language?: Language; addedByMemberId: string },
): Promise<Member> {
  const normalized = normalizeE164(e164) ?? e164;
  return db().transaction(async (tx) => {
    const reset = await tx
      .update(memberPhones)
      .set({ status: "pending", verifiedAt: null })
      .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.memberId, memberId), eq(memberPhones.e164, normalized)))
      .returning({ id: memberPhones.id });
    if (reset.length === 0) throw new Error("PHONE_NOT_FOUND");
    const [row] = await tx
      .update(members)
      .set({
        status: "active",
        name: input.name,
        role: input.role,
        addedByMemberId: input.addedByMemberId,
        ...(input.language ? { language: input.language } : {}),
      })
      .where(and(eq(members.orgId, orgId), eq(members.id, memberId)))
      .returning();
    return row;
  });
}

/** Changes an active crew member's or admin's role. Throws `MEMBER_NOT_FOUND`; owners are not changed here (`IS_OWNER`). */
export async function setMemberRole(orgId: string, memberId: string, role: "member" | "admin"): Promise<Member> {
  const current = await findMemberById(orgId, memberId);
  if (!current || current.status !== "active") throw new Error("MEMBER_NOT_FOUND");
  if (current.role === "owner") throw new Error("IS_OWNER");
  const [row] = await db()
    .update(members)
    .set({ role })
    .where(and(eq(members.orgId, orgId), eq(members.id, memberId)))
    .returning();
  return row;
}

/**
 * Renames an active member. Their web login carries the name too (the account menu shows it), so it
 * follows. Throws `MEMBER_NOT_FOUND`.
 */
export async function setMemberName(orgId: string, memberId: string, name: string): Promise<Member> {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .update(members)
      .set({ name })
      .where(and(eq(members.orgId, orgId), eq(members.id, memberId), eq(members.status, "active")))
      .returning();
    if (!row) throw new Error("MEMBER_NOT_FOUND");
    if (row.userId) await tx.update(user).set({ name, updatedAt: new Date() }).where(eq(user.id, row.userId));
    return row;
  });
}

/** Sets the language an active member reads the app and the assistant in. Throws `MEMBER_NOT_FOUND`. */
export async function setMemberLanguage(orgId: string, memberId: string, language: Language): Promise<Member> {
  const [row] = await db()
    .update(members)
    .set({ language })
    .where(and(eq(members.orgId, orgId), eq(members.id, memberId), eq(members.status, "active")))
    .returning();
  if (!row) throw new Error("MEMBER_NOT_FOUND");
  return row;
}

/** Sets what an active member's truck carries, tidied (`cleanEquipment`). Throws `MEMBER_NOT_FOUND`. */
export async function setMemberEquipment(orgId: string, memberId: string, equipment: string[]): Promise<Member> {
  const [row] = await db()
    .update(members)
    .set({ equipment: cleanEquipment(equipment) })
    .where(and(eq(members.orgId, orgId), eq(members.id, memberId), eq(members.status, "active")))
    .returning();
  if (!row) throw new Error("MEMBER_NOT_FOUND");
  return row;
}

/** How this phone last texted us (`iMessage`, `SMS`, or `RCS`), so a post can fall back to a link for SMS. */
export async function memberPhoneService(orgId: string, e164: string): Promise<string | null> {
  const [row] = await db()
    .select({ service: memberPhones.lastService })
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.e164, e164)));
  return row?.service ?? null;
}

/** The line the member texts the assistant on, from their phones that aren't stopped; null when none has one. */
export async function assignedLineFor(orgId: string, memberId: string): Promise<string | null> {
  const phones = await db()
    .select({ line: memberPhones.assignedLine })
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.memberId, memberId), ne(memberPhones.status, "stopped")))
    .orderBy(asc(memberPhones.createdAt), asc(memberPhones.id));
  return phones.find((p) => p.line)?.line ?? null;
}

/** Stores the Photon user and the line this phone should text. */
export async function setPhonePhoton(
  orgId: string,
  phoneId: string,
  photon: { photonUserId: string; assignedLine: string },
): Promise<void> {
  await db()
    .update(memberPhones)
    .set(photon)
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.id, phoneId)));
}

/**
 * The member a phone belongs to, in whichever business: this is how an inbound text finds its
 * business. The one lookup that is not scoped to an org; callers check `member.orgId`.
 */
export async function findMemberByPhone(
  e164: string,
): Promise<{ member: Member; phone: MemberPhone } | null> {
  const normalized = normalizeE164(e164) ?? e164;
  const [row] = await db()
    .select({ member: members, phone: memberPhones })
    .from(memberPhones)
    .innerJoin(members, eq(members.id, memberPhones.memberId))
    .where(eq(memberPhones.e164, normalized));
  return row ?? null;
}

export async function findMemberById(orgId: string, id: string): Promise<Member | null> {
  const [row] = await db()
    .select()
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.id, id)));
  return row ?? null;
}

/** Active members, oldest first. */
export function listMembers(orgId: string): Promise<Member[]> {
  return db()
    .select()
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.status, "active")))
    .orderBy(asc(members.createdAt), asc(members.id));
}

/** Active owners and admins. */
export function privilegedMembers(orgId: string): Promise<Member[]> {
  return db()
    .select()
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.status, "active"), inArray(members.role, ["owner", "admin"])))
    .orderBy(asc(members.createdAt), asc(members.id));
}

/**
 * Marks a pending phone verified without a text: an admin vouched for it at provisioning. A stopped
 * phone stays stopped.
 */
export async function verifyPhone(orgId: string, phoneId: string, at: Date): Promise<void> {
  await db()
    .update(memberPhones)
    .set({ status: "verified", verifiedAt: at })
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.id, phoneId), eq(memberPhones.status, "pending")));
}

export async function setPhoneStatus(orgId: string, phoneId: string, status: PhoneStatus): Promise<void> {
  await db()
    .update(memberPhones)
    .set({ status })
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.id, phoneId)));
}

/**
 * Notes an inbound text: stamps the thread and last inbound time, and verifies a pending phone.
 * `verified` is true only for the one call that verified the phone or was its first text, so two
 * concurrent first texts cannot both count as first contact.
 */
export async function recordInbound(
  orgId: string,
  phoneId: string,
  threadId: string,
  at: Date,
  service?: "iMessage" | "SMS" | "RCS",
): Promise<{ verified: boolean }> {
  // The WHERE re-checks after a concurrent update commits, so exactly one caller gets the row back. A
  // phone provisioning already verified still has its first contact on its first text.
  const claimed = await db()
    .update(memberPhones)
    .set({ status: "verified", verifiedAt: sql`coalesce(${memberPhones.verifiedAt}, ${at.toISOString()}::timestamptz)`, lastInboundAt: at })
    .where(
      and(
        eq(memberPhones.orgId, orgId),
        eq(memberPhones.id, phoneId),
        or(eq(memberPhones.status, "pending"), and(eq(memberPhones.status, "verified"), isNull(memberPhones.lastInboundAt))),
      ),
    )
    .returning({ id: memberPhones.id });
  await db()
    .update(memberPhones)
    .set({ lastInboundAt: at, threadId, ...(service ? { lastService: service } : {}) })
    .where(and(eq(memberPhones.orgId, orgId), eq(memberPhones.id, phoneId)));
  return { verified: claimed.length > 0 };
}

/**
 * Links a member to their web login. Only fills an empty link, so two sign-ins racing on a first login
 * can't each attach a different user; returns the user id the member ends up linked to.
 */
export async function linkMemberUser(orgId: string, memberId: string, userId: string): Promise<string | null> {
  await db()
    .update(members)
    .set({ userId })
    .where(and(eq(members.orgId, orgId), eq(members.id, memberId), isNull(members.userId)));
  const member = await findMemberById(orgId, memberId);
  return member?.userId ?? null;
}

/**
 * The businesses a web login is an active member of, oldest membership first. Looked up by user across
 * businesses on purpose: it's how a signed-in person finds the businesses they may open.
 */
export function membershipsForUser(userId: string): Promise<Array<{ member: Member; org: { id: string; name: string; slug: string } }>> {
  return db()
    .select({ member: members, org: { id: organization.id, name: organization.name, slug: organization.slug } })
    .from(members)
    .innerJoin(organization, eq(organization.id, members.orgId))
    .where(and(eq(members.userId, userId), eq(members.status, "active")))
    .orderBy(asc(members.createdAt), asc(members.id));
}

/** An email address as members are matched by it: trimmed and lowercase. Null when it isn't one. */
export function normalizeEmail(input: string): string | null {
  const address = input.trim().replace(/^mailto:/i, "").toLowerCase();
  return isEmailAddress(address) ? address : null;
}

/**
 * Asks for an address as a member's forwarding email, or with null clears it. Asking doesn't turn it on:
 * it starts a pending claim whose code proves the member can send from it (core/email-claims.ts), and
 * returns the code, once, for the caller to deliver to that member. Asking for the address they already
 * have changes nothing (`claim` null). Throws `INVALID_EMAIL`; `MEMBER_NOT_FOUND` for anyone who isn't an
 * active member of this business; `EMAIL_IN_USE` when another member has it, or a live claim on it, in any
 * case; `EMAIL_IS_CUSTOMER` when it's one of the business's customer contacts' (an address names one
 * person, and a customer's must never act as a member); and `EMAIL_CLAIM_LIMIT` past a day's claims.
 */
export async function setMemberEmail(
  orgId: string,
  memberId: string,
  email: string | null,
  setByMemberId: string,
  now: Date = new Date(),
): Promise<{ member: Member; claim: StartedClaim | null }> {
  const address = email === null || !email.trim() ? null : normalizeEmail(email);
  if (email !== null && email.trim() && !address) throw new Error("INVALID_EMAIL");
  const member = await findMemberById(orgId, memberId);
  if (!member || member.status !== "active") throw new Error("MEMBER_NOT_FOUND");
  if (!address) {
    await cancelClaims(orgId, memberId);
    const [row] = await db()
      .update(members)
      .set({ email: null, emailSetByMemberId: setByMemberId, emailSetAt: now })
      .where(and(eq(members.orgId, orgId), eq(members.id, memberId)))
      .returning();
    return { member: row, claim: null };
  }
  if (member.email === address) return { member, claim: null };
  const [other] = await db()
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.orgId, orgId), sql`lower(${members.email}) = ${address}`, ne(members.id, memberId)));
  if (other || (await claimedByAnother(orgId, memberId, address, now))) throw new Error("EMAIL_IN_USE");
  const [contact] = await db()
    .select({ id: customerContacts.id })
    .from(customerContacts)
    .where(and(eq(customerContacts.orgId, orgId), sql`${address} = any(select lower(e) from unnest(${customerContacts.emails}) as e)`))
    .limit(1);
  if (contact) throw new Error("EMAIL_IS_CUSTOMER");
  const claim = await startClaim({ orgId, memberId, address, setByMemberId }, now);
  return { member, claim };
}

/** The active member of this business who forwards from `address`, if any. */
export async function findMemberByEmail(orgId: string, address: string): Promise<Member | null> {
  const normalized = normalizeEmail(address);
  if (!normalized) return null;
  const [row] = await db()
    .select()
    .from(members)
    .where(and(eq(members.orgId, orgId), sql`lower(${members.email}) = ${normalized}`, eq(members.status, "active")));
  return row ?? null;
}

/** The member as a `Caller`, or null when they're not active. */
export function callerForMember(member: Member): Promise<Caller | null> {
  return callerFor(member);
}

async function callerFor(member: Member | null | undefined, principalId?: string): Promise<Caller | null> {
  if (!member || member.status !== "active") return null;
  const phones = await db()
    .select()
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, member.orgId), eq(memberPhones.memberId, member.id), ne(memberPhones.status, "stopped")))
    .orderBy(asc(memberPhones.createdAt), asc(memberPhones.id));
  const principalPhone = principalId ? normalizeE164(principalId) : null;
  const phone =
    phones.find((p) => p.e164 === principalPhone) ??
    phones.find((p) => p.status === "verified") ??
    phones[0];
  return {
    orgId: member.orgId,
    memberId: member.id,
    name: member.name,
    role: member.role,
    language: isLanguage(member.language) ? member.language : "en",
    phoneE164: phone?.e164 ?? null,
  };
}

/** The eve channel's authenticator for a member signed in to the web app (agents/assistant/agent/channels/eve.ts). */
export const APP_WEB = "app-web";

/**
 * The eve channel's authenticator for a job session the assistant drives server-side, as the member
 * whose thread opened it (core/jobs.ts signs it, lib/eve-auth.ts checks it).
 */
export const APP_JOB = "app-job";

/** The eve principal id a job session runs under: the member's, like their texts'. */
export const jobPrincipalId = (memberId: string) => `member:${memberId}`;

/**
 * Maps an Eve auth principal to a member. photon-imessage carries `attributes.memberId` and
 * `attributes.orgId`, which must agree; app-web carries the same, and the member must still be linked
 * to the web login that is the principal; app-job carries the same, for the member the principal
 * names; local-dev is the member whose thread the session is (`localDevThread`), or else the first
 * active owner of the local-dev business (LOCAL_DEV_ORG, an org id or slug, or else the oldest
 * business), outside production.
 */
export async function resolveCaller(
  auth: { authenticator: string; principalId: string; attributes?: Record<string, unknown> } | null,
): Promise<Caller | null> {
  if (!auth) return null;
  switch (auth.authenticator) {
    case "photon-imessage": {
      const { memberId, orgId } = auth.attributes ?? {};
      if (typeof memberId !== "string" || typeof orgId !== "string") return null;
      return callerFor(await findMemberById(orgId, memberId), auth.principalId);
    }
    case APP_WEB: {
      const { memberId, orgId } = auth.attributes ?? {};
      if (typeof memberId !== "string" || typeof orgId !== "string") return null;
      const member = await findMemberById(orgId, memberId);
      if (!member || member.userId !== auth.principalId) return null;
      return callerFor(member);
    }
    case APP_JOB: {
      const { memberId, orgId } = auth.attributes ?? {};
      if (typeof memberId !== "string" || typeof orgId !== "string") return null;
      if (auth.principalId !== jobPrincipalId(memberId)) return null;
      return callerFor(await findMemberById(orgId, memberId));
    }
    case "local-dev": {
      if (process.env.VERCEL_ENV === "production") return null;
      // A member's own thread, in local development (`localDevThread`): that member.
      const { memberId: threadMember, orgId: threadOrg } = auth.attributes ?? {};
      if (typeof threadMember === "string" && typeof threadOrg === "string") {
        return callerFor(await findMemberById(threadOrg, threadMember));
      }
      const orgId = await localDevOrgId();
      if (!orgId) return null;
      const [member] = await db()
        .select()
        .from(members)
        .where(and(eq(members.orgId, orgId), eq(members.role, "owner"), eq(members.status, "active")))
        .orderBy(asc(members.createdAt), asc(members.id))
        .limit(1);
      return callerFor(member);
    }
    default:
      return null;
  }
}

async function localDevOrgId(): Promise<string | null> {
  const wanted = process.env.LOCAL_DEV_ORG?.trim();
  const [row] = await db()
    .select({ id: organization.id })
    .from(organization)
    .where(wanted ? or(eq(organization.id, wanted), eq(organization.slug, wanted)) : undefined)
    .orderBy(asc(organization.createdAt), asc(organization.id))
    .limit(1);
  return row?.id ?? null;
}
