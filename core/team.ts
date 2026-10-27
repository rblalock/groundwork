import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { emailClaims, memberPhones, members } from "../schema/schema";
import { db } from "./db";
import { inviteText } from "./inbound";
import { isLanguage, type Language } from "./language";
import {
  addPhone,
  assertOutranks,
  createMember,
  findMemberByPhone,
  normalizeE164,
  reactivateMember,
  setMemberLanguage,
  setMemberName,
  setMemberRole,
  findMemberById,
  removeMember,
  setMemberEmail,
  setPhonePhoton,
  type Caller,
  type Member,
  type PhoneStatus,
  type Role,
} from "./members";
import { CODE_MASK } from "../lib/login-codes";
import { getOrganization } from "./organizations";
import { postToMember } from "./outbound";
import { createPhotonAdmin } from "./photon-admin";
import { getProfile } from "./profile";

export type AddedMember = {
  member: Member;
  alreadyActive: boolean;
  /** A role the asker passed: changed, or left alone because the member is an owner. */
  roleChange: "changed" | "unchanged_owner" | null;
  assignedLine: string | null;
  /** The text for the asker to forward; null when the person is already on the team and has texted. */
  invite: string | null;
  invitePosted: boolean;
};

/**
 * Adds a crew member or admin by phone, for add_member and the web app's team page. Registers the phone
 * with Photon and builds the invite the asker forwards: the new person has to text the line first, so
 * nothing here texts them. `postInvite` also posts the invite to the asker's own thread (texting); the
 * web app shows it instead. A phone already on the team returns that member, with a passed role applied
 * (never to an owner); a removed member comes back. Roles follow `assertOutranks`: an admin adds and
 * manages crew, the owner admins too. Throws `INVALID_PHONE`, `PHONE_IN_USE`, or `NOT_PRIVILEGED`.
 */
export async function addTeamMember(
  caller: Caller,
  input: { name: string; phone: string; role?: "member" | "admin"; language?: Language },
  options: { postInvite: boolean },
): Promise<AddedMember> {
  const { name, role, language } = input;
  const e164 = normalizeE164(input.phone);
  if (!e164) throw new Error("INVALID_PHONE");

  const found = await findMemberByPhone(e164);
  // A phone belongs to one business: another business's member is not this team's to add.
  if (found && found.member.orgId !== caller.orgId) throw new Error("PHONE_IN_USE");
  let member: Member;
  let alreadyActive = false;
  let roleChange: AddedMember["roleChange"] = null;
  if (found && found.member.status === "active") {
    member = found.member;
    alreadyActive = true;
    // A stated role is the asker's to set only for someone below them, to a role below theirs. An owner
    // is never demoted here; that would need its own, deliberate step.
    if (role && role !== member.role) {
      if (member.role === "owner") roleChange = "unchanged_owner";
      else {
        assertOutranks(caller, member);
        assertOutranks(caller, { role });
        member = await setMemberRole(caller.orgId, member.id, role);
        roleChange = "changed";
      }
    }
  } else if (found) {
    assertOutranks(caller, { role: role ?? "member" });
    member = await reactivateMember(caller.orgId, found.member.id, e164, {
      name,
      role: role ?? "member",
      language,
      addedByMemberId: caller.memberId,
    });
  } else {
    assertOutranks(caller, { role: role ?? "member" });
    member = await createMember({
      orgId: caller.orgId,
      name,
      role: role ?? "member",
      language,
      addedByMemberId: caller.memberId,
    });
  }
  const phoneRow = found?.phone ?? (await addPhone(caller.orgId, member.id, e164));

  if (alreadyActive && phoneRow.status === "verified") {
    return { member, alreadyActive, roleChange, assignedLine: phoneRow.assignedLine, invite: null, invitePosted: false };
  }

  const photon = await createPhotonAdmin().ensureSharedUser({ e164, firstName: name.trim().split(/\s+/)[0] });
  await setPhonePhoton(caller.orgId, phoneRow.id, { photonUserId: photon.id, assignedLine: photon.assignedLine });

  const profile = await getProfile(caller.orgId);
  const invite = inviteText({
    businessName: profile.name,
    memberName: member.name,
    assignedLine: photon.assignedLine,
    language: isLanguage(member.language) ? member.language : "en",
  });
  const posted = options.postInvite
    ? await postToMember(caller.orgId, caller.memberId, { text: invite }, "system")
    : { posted: false };
  return { member, alreadyActive, roleChange, assignedLine: photon.assignedLine, invite, invitePosted: posted.posted };
}

export type TeamMember = {
  id: string;
  name: string;
  role: Role;
  language: Language;
  /** They have signed in to the web app at least once. */
  hasLogin: boolean;
  /** The address they forward emails from, if any. */
  email: string | null;
  /** An address asked for and waiting on its code. */
  pendingEmail: string | null;
  phones: Array<{ e164: string; status: PhoneStatus; assignedLine: string | null; lastInboundAt: Date | null }>;
  createdAt: Date;
};

/** The active team, oldest first, with each member's phones. */
export async function listTeam(orgId: string): Promise<TeamMember[]> {
  const people = await db()
    .select()
    .from(members)
    .where(and(eq(members.orgId, orgId), eq(members.status, "active")))
    .orderBy(asc(members.createdAt), asc(members.id));
  if (people.length === 0) return [];
  const phones = await db()
    .select()
    .from(memberPhones)
    .where(and(eq(memberPhones.orgId, orgId), inArray(memberPhones.memberId, people.map((p) => p.id))))
    .orderBy(asc(memberPhones.createdAt), asc(memberPhones.id));
  const claims = await db()
    .select({ memberId: emailClaims.memberId, address: emailClaims.address })
    .from(emailClaims)
    .where(and(eq(emailClaims.orgId, orgId), eq(emailClaims.status, "pending"), gt(emailClaims.expiresAt, new Date())));
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    language: isLanguage(p.language) ? p.language : "en",
    hasLogin: p.userId !== null,
    email: p.email,
    pendingEmail: claims.find((c) => c.memberId === p.id)?.address ?? null,
    phones: phones
      .filter((ph) => ph.memberId === p.id)
      .map((ph) => ({ e164: ph.e164, status: ph.status, assignedLine: ph.assignedLine, lastInboundAt: ph.lastInboundAt })),
    createdAt: p.createdAt,
  }));
}

/** "j…@example.com": enough for the member to know it, not enough to hand anyone the address. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  return at > 0 ? `${address[0]}…${address.slice(at)}` : "…";
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name.trim();

/**
 * The text that carries a claim's code to the member it's for: how to turn forwarding on, and, when
 * someone else asked, who, so a member who didn't want it can say so.
 */
export function emailCodeText(input: { address: string; inbox: string; code: string; setBy: string | null; language: Language }): string {
  const masked = maskEmail(input.address);
  if (input.language === "es") {
    const lead = input.setBy ? `${firstName(input.setBy)} puso ${masked} como tu correo para reenviar. Para activarlo` : `Para activar el reenvío desde ${masked}`;
    return `${lead}, envía un correo nuevo a ${input.inbox} desde esa dirección con solo ${input.code} como asunto (no lo reenvíes ni respondas). El código vence en 24 horas.${input.setBy ? " ¿No fuiste tú? Avísale al dueño." : ""}`;
  }
  const lead = input.setBy ? `${firstName(input.setBy)} set ${masked} as your email for forwarding. To turn it on` : `To turn on forwarding from ${masked}`;
  return `${lead}, send a new email to ${input.inbox} from that address with just ${input.code} as the subject (not a reply or forward). The code works for 24 hours.${input.setBy ? " Not you? Tell the owner." : ""}`;
}

/** The text a member gets once their address is confirmed. */
export function emailConfirmedText(address: string, inbox: string, language: Language): string {
  return language === "es"
    ? `Listo: los correos de ${maskEmail(address)} a ${inbox} ahora me llegan como tuyos.`
    : `Forwarding is on: emails from ${maskEmail(address)} to ${inbox} now reach me as yours.`;
}

/** What the business's owners hear when any member's forwarding address turns on. */
export function emailConfirmedOwnerText(memberName: string, address: string, language: Language): string {
  return language === "es"
    ? `El correo para reenviar de ${firstName(memberName)}, ${maskEmail(address)}, ya está activo.`
    : `${firstName(memberName)}'s forwarding address ${maskEmail(address)} is now on.`;
}

/** The notice a member gets when someone else removes their forwarding address. */
export function emailRemovedNotice(setBy: string, language: Language): string {
  return language === "es"
    ? `${firstName(setBy)} quitó tu correo para reenviar. ¿No fuiste tú? Avísale al dueño.`
    : `${firstName(setBy)} removed your email for forwarding. Not you? Tell the owner.`;
}

export type ForwardingResult = {
  member: Member;
  /** The address waiting on its code, when one was asked for. The code itself only for the member themself. */
  pending: { address: string; expiresAt: Date; inbox: string; code?: string } | null;
  /** Whether the code reached the member by text. */
  codeTexted: boolean;
};

/**
 * Asks for the address a member forwards emails from, for set_member_email and the web app, or clears it.
 * Anyone may ask for their own; someone else's only when the caller strictly outranks them (the owner for
 * admins and crew, an admin for crew; an owner's only by that owner). Asking makes the address pending
 * (`setMemberEmail`): its code is texted to that member, and it turns on only when they email the inbox
 * from it with the code, which proves they can send from it. The code is returned only to the member
 * themself (their web page shows it once); the texted copy is logged with the code masked. Clearing
 * someone else's texts them a notice. Throws `NOT_PRIVILEGED`, `EMAIL_NO_INBOX` (no address to confirm
 * to yet), and `setMemberEmail`'s codes.
 */
export async function setForwardingEmail(caller: Caller, memberId: string, email: string | null, deps?: { now?: Date }): Promise<ForwardingResult> {
  const now = deps?.now ?? new Date();
  const self = memberId === caller.memberId;
  if (!self) {
    const target = await findMemberById(caller.orgId, memberId);
    if (!target || target.status !== "active") throw new Error("MEMBER_NOT_FOUND");
    assertOutranks(caller, target);
  }
  const inbox = (await getOrganization(caller.orgId))?.inboxAddress ?? null;
  if (email?.trim() && !inbox) throw new Error("EMAIL_NO_INBOX");
  const { member, claim } = await setMemberEmail(caller.orgId, memberId, email, caller.memberId, now);
  const language = isLanguage(member.language) ? member.language : "en";
  if (!claim) {
    if (!self && !email?.trim()) {
      const text = emailRemovedNotice(caller.name, language);
      const sent = await postToMember(caller.orgId, member.id, { text }, "proactive", { now });
      if (!sent.posted && sent.reason === "quiet_hours") {
        // Imported here: followups.ts imports outbound.ts, as notifyOwners does.
        const { queueNotice } = await import("./followups");
        await queueNotice({ orgId: caller.orgId, memberId: member.id, quoteId: null, payload: { text, asksApproval: false }, now });
      }
    }
    return { member, pending: null, codeTexted: false };
  }
  // The code goes now, whatever the hour: it answers a deliberate request, and a held notice would keep it
  // in the clear. The log keeps it masked, like a sign-in code.
  const text = emailCodeText({ address: claim.address, inbox: inbox!, code: claim.code, setBy: self ? null : caller.name, language });
  const sent = await postToMember(caller.orgId, member.id, { text, logText: text.replace(claim.code, CODE_MASK) }, "system", { now });
  return {
    member,
    pending: { address: claim.address, expiresAt: claim.expiresAt, inbox: inbox!, ...(self ? { code: claim.code } : {}) },
    codeTexted: sent.posted,
  };
}

/**
 * Removes someone from the team, for remove_member and the Team page: anyone below the caller (or the
 * caller themself), never the last owner (`removeMember`'s `LAST_OWNER`). Throws `NOT_PRIVILEGED` and
 * `MEMBER_NOT_FOUND`.
 */
export async function removeTeamMember(caller: Caller, memberId: string): Promise<Member> {
  const target = await findMemberById(caller.orgId, memberId);
  if (!target) throw new Error("MEMBER_NOT_FOUND");
  if (target.id !== caller.memberId) assertOutranks(caller, target);
  return removeMember(caller.orgId, memberId);
}

export type MemberUpdate = { name?: string; language?: Language; role?: "member" | "admin" };

/**
 * Changes a member's name, language, or role, for update_member and the Team and Account pages.
 * Anyone changes their own name and language; an owner or admin changes them for someone below them.
 * Only an owner changes roles (an admin promoting someone would make a peer), never their own, and no
 * one's role becomes or stops being owner here. A role that's already theirs changes nothing. Throws
 * `MEMBER_NOT_FOUND`, `NOT_PRIVILEGED`, `ROLE_OWNER_ONLY`, `OWN_ROLE`, or `IS_OWNER`.
 */
export async function updateTeamMember(caller: Caller, memberId: string, update: MemberUpdate): Promise<Member> {
  let target = await findMemberById(caller.orgId, memberId);
  if (!target || target.status !== "active") throw new Error("MEMBER_NOT_FOUND");
  const self = target.id === caller.memberId;
  const name = update.name?.trim();
  if ((name !== undefined || update.language !== undefined) && !self) assertOutranks(caller, target);
  const roleChanges = update.role !== undefined && update.role !== target.role;
  if (roleChanges) {
    if (caller.role !== "owner") throw new Error("ROLE_OWNER_ONLY");
    if (self) throw new Error("OWN_ROLE");
    if (target.role === "owner") throw new Error("IS_OWNER");
  }
  if (name && name !== target.name) target = await setMemberName(caller.orgId, target.id, name);
  if (update.language !== undefined && update.language !== target.language) {
    target = await setMemberLanguage(caller.orgId, target.id, update.language);
  }
  if (roleChanges && update.role) target = await setMemberRole(caller.orgId, target.id, update.role);
  return target;
}
